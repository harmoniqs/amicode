/**
 * Integration test for session-scoped diffs (#174, #742).
 *
 * Verifies that GET /session/:id/diff returns the net diff (session-start
 * snapshot vs current state) filtered to only files the agent touched.
 *
 * After #742 the agent-touched file filter is derived exclusively from tool
 * filediff metadata — patch-part file lists no longer feed the filter (they
 * were the cross-session contamination vector).
 */
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import path from "path"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { ExternalDiff } from "@/session/external-diff"
import { Storage } from "@/storage/storage"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { MessageID, PartID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Session.node, Snapshot.node, Storage.node, FSUtil.node, Database.node])),
    httpApiLayer,
  ),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

function pathFor(template: string, params: Record<string, string>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)
}

const withSession = (input?: Parameters<Session.Interface["create"]>[0]) =>
  Effect.acquireRelease(Session.use.create(input), (created) => Session.use.remove(created.id).pipe(Effect.ignore))

describe("Session.diff — session-scoped agent diffs (#174)", () => {
  it.instance(
    "prepares an opaque external reservation over the authenticated session API",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-http-reservation" })
        const fs = yield* FSUtil.Service
        const sibling = path.join(path.dirname(test.directory), `external-http-${session.id}.txt`)
        yield* fs.writeWithDirs(sibling, "before\n")

        const response = yield* requestInDirectory(
          `/session/${session.id}/external-diff/reservations/prepare`,
          test.directory,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, files: [sibling] }),
          },
        )

        expect(response.status).toBe(200)
        const body = yield* response.json
        expect(body).toEqual({
          version: 1,
          reservation: {
            id: expect.any(String),
            expiresAt: expect.any(Number),
            endpoints: [
              {
                reference: expect.any(String),
                capability: expect.any(String),
                revision: 0,
              },
            ],
          },
        })
        expect(JSON.stringify(body)).not.toContain(sibling)
        expect(JSON.stringify(body)).not.toContain("before")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects mismatched reservations while preserving idempotent group commit and conditional abort",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-http-commit" })
        const other = yield* withSession({ title: "external-http-other" })
        const fs = yield* FSUtil.Service
        const source = path.join(path.dirname(test.directory), `external-http-source-${session.id}.txt`)
        const destination = path.join(path.dirname(test.directory), `external-http-destination-${session.id}.txt`)
        const partialSource = path.join(path.dirname(test.directory), `external-http-partial-source-${session.id}.txt`)
        const partialDestination = path.join(
          path.dirname(test.directory),
          `external-http-partial-destination-${session.id}.txt`,
        )
        const abortedFile = path.join(path.dirname(test.directory), `external-http-aborted-${session.id}.txt`)
        yield* fs.writeWithDirs(source, "before\n")
        yield* fs.writeWithDirs(partialSource, "partial-before\n")

        const prepare = (id: string, files: string[]) =>
          requestInDirectory(`/session/${id}/external-diff/reservations/prepare`, test.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, files }),
          })
        const lifecycle = (id: string, action: "commit" | "abort", reservation: unknown) =>
          requestInDirectory(`/session/${id}/external-diff/reservations/${action}`, test.directory, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ version: 1, reservation }),
          })
        type Reservation = {
          id: string
          expiresAt: number
          endpoints: Array<{ reference: string; capability: string; revision: number }>
        }
        const prepared = yield* prepare(session.id, [source, destination])
        expect(prepared.status).toBe(200)
        const reservation = ((yield* prepared.json) as { reservation: Reservation }).reservation
        const stalePrepared = yield* prepare(session.id, [source])
        expect(stalePrepared.status).toBe(200)
        const staleReservation = ((yield* stalePrepared.json) as { reservation: Reservation }).reservation

        yield* fs.writeWithDirs(destination, "before\n")
        yield* fs.remove(source)

        const wrongSession = yield* lifecycle(other.id, "commit", reservation)
        expect(wrongSession.status).toBe(409)
        const wrongCapability = yield* lifecycle(session.id, "commit", {
          ...reservation,
          endpoints: [{ ...reservation.endpoints[0], capability: "forged" }, reservation.endpoints[1]],
        })
        expect(wrongCapability.status).toBe(409)
        const wrongReference = yield* lifecycle(session.id, "commit", {
          ...reservation,
          endpoints: [{ ...reservation.endpoints[0], reference: "external_forged" }, reservation.endpoints[1]],
        })
        expect(wrongReference.status).toBe(409)
        const committed = yield* lifecycle(session.id, "commit", reservation)
        expect(committed.status).toBe(200)
        expect(yield* committed.json).toEqual({ version: 1, committed: true })
        const staleRevision = yield* lifecycle(session.id, "commit", staleReservation)
        expect(staleRevision.status).toBe(409)
        const retry = yield* lifecycle(session.id, "commit", reservation)
        expect(retry.status).toBe(200)
        expect(yield* retry.json).toEqual({ version: 1, committed: true })
        const postCommitAbort = yield* lifecycle(session.id, "abort", reservation)
        expect(postCommitAbort.status).toBe(409)

        const abortPrepared = yield* prepare(session.id, [abortedFile])
        expect(abortPrepared.status).toBe(200)
        const aborted = yield* lifecycle(
          session.id,
          "abort",
          ((yield* abortPrepared.json) as { reservation: Reservation }).reservation,
        )
        expect(aborted.status).toBe(200)
        expect(yield* aborted.json).toEqual({ version: 1, aborted: true })

        const partial = yield* prepare(session.id, [partialSource, partialDestination])
        expect(partial.status).toBe(200)
        const partialReservation = ((yield* partial.json) as { reservation: Reservation }).reservation
        yield* fs.writeWithDirs(partialDestination, "partial\n")
        yield* fs.remove(partialSource)
        const stale = yield* lifecycle(session.id, "commit", {
          ...partialReservation,
          endpoints: [{ ...partialReservation.endpoints[0], revision: -1 }, partialReservation.endpoints[1]],
        })
        expect(stale.status).toBe(409)
        const detail = yield* requestInDirectory(
          pathFor(SessionPaths.assessedDiff, { sessionID: session.id }),
          test.directory,
        )
        expect(detail.status).toBe(200)
        expect(yield* detail.json).toEqual(
          expect.objectContaining({
            assessments: expect.arrayContaining([
              expect.objectContaining({ file: partialSource, state: "unavailable" }),
              expect.objectContaining({ file: partialDestination, state: "unavailable" }),
            ]),
          }),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns a settled, no-store assessed diff for one non-Git sibling file",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-sibling" })
        const fs = yield* FSUtil.Service
        const sibling = path.join(path.dirname(test.directory), `external-${session.id}.txt`)
        yield* fs.writeWithDirs(sibling, "before\n")

        const reservation = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })
        expect(reservation).toBeDefined()
        yield* fs.writeWithDirs(sibling, "after\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: reservation! })).toBe(true)

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.assessedDiff, { sessionID: session.id }) + "?patch=true",
          test.directory,
        )
        expect(response.status).toBe(200)
        expect(response.headers["cache-control"]).toBe("no-store")
        expect(yield* response.json).toEqual({
          version: 1,
          revision: 2,
          assessments: [
            {
              reference: reservation!.endpoints[0].reference,
              file: sibling,
              state: "changed",
              status: "modified",
              patch: expect.stringContaining("-before"),
              additions: 1,
              deletions: 1,
            },
          ],
        })

        const other = yield* withSession({ title: "external-sibling-other-session" })
        const otherResponse = yield* requestInDirectory(
          pathFor(SessionPaths.assessedDiff, { sessionID: other.id }),
          test.directory,
        )
        expect(otherResponse.status).toBe(200)
        expect(yield* otherResponse.json).toEqual({ version: 1, revision: 0, assessments: [] })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "removes a reverted external file from the assessed changed rows",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-revert" })
        const fs = yield* FSUtil.Service
        const sibling = path.join(path.dirname(test.directory), `external-revert-${session.id}.txt`)
        yield* fs.writeWithDirs(sibling, "before\n")

        const reservation = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })
        expect(reservation).toBeDefined()
        yield* fs.writeWithDirs(sibling, "after\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: reservation! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toMatchObject([{ file: sibling, state: "changed" }])

        const revert = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })
        expect(revert).toBeDefined()
        yield* fs.writeWithDirs(sibling, "before\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: revert! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file: sibling, state: "unchanged" }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "marks a stale external owner unavailable while preserving a matching later owner",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const first = yield* withSession({ title: "external-first-owner" })
        const second = yield* withSession({ title: "external-second-owner" })
        const sibling = path.join(path.dirname(test.directory), `external-contention-${first.id}.txt`)
        yield* fs.writeWithDirs(sibling, "baseline\n")

        const firstWrite = ExternalDiff.prepare({ sessionID: first.id, files: [sibling] })!
        yield* fs.writeWithDirs(sibling, "first\n")
        expect(ExternalDiff.commit({ sessionID: first.id, reservation: firstWrite })).toBe(true)

        const secondWrite = ExternalDiff.prepare({ sessionID: second.id, files: [sibling] })!
        yield* fs.writeWithDirs(sibling, "second\n")
        expect(ExternalDiff.commit({ sessionID: second.id, reservation: secondWrite })).toBe(true)

        expect(ExternalDiff.assessed(first.id).assessments).toEqual([
          expect.objectContaining({ file: sibling, state: "unavailable" }),
        ])
        expect(ExternalDiff.assessed(second.id, { patch: true }).assessments).toEqual([
          expect.objectContaining({ file: sibling, state: "changed", patch: expect.stringContaining("+second") }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rehydrates a committed external baseline after a same-host restart",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const session = yield* withSession({ title: "external-rehydrate" })
        const sibling = path.join(path.dirname(test.directory), `external-rehydrate-${session.id}.txt`)
        yield* fs.writeWithDirs(sibling, "BASELINE_SECRET_975\n")
        const reservation = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })!
        yield* fs.writeWithDirs(sibling, "changed\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation })).toBe(true)

        ExternalDiff.resetMemoryForTest()

        expect(ExternalDiff.assessed(session.id, { patch: true }).assessments).toEqual([
          expect.objectContaining({
            file: sibling,
            state: "changed",
            patch: expect.stringContaining("BASELINE_SECRET_975"),
          }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "projects persisted v1 external diffs as legacy_external without ownership",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const session = yield* withSession({ title: "external-legacy-compatibility" })
        const sibling = path.join(path.dirname(test.directory), `external-legacy-${session.id}.txt`)
        yield* fs.writeWithDirs(sibling, "before\n")
        const reservation = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })!
        yield* fs.writeWithDirs(sibling, "after\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation })).toBe(true)
        const legacyWire = ExternalDiff.assessed(session.id)

        ExternalDiff.resetMemoryForTest()

        const compatibility = ExternalDiff.compatibility(session.id)
        expect(compatibility).toEqual([
          {
            kind: "legacy_external",
            assessment: expect.objectContaining({
              reference: reservation.endpoints[0].reference,
              file: sibling,
              state: "changed",
              status: "modified",
            }),
          },
        ])
        expect(compatibility[0]).not.toHaveProperty("operationID")
        expect(compatibility[0]).not.toHaveProperty("rootID")
        expect(compatibility[0]).not.toHaveProperty("lineage")
        expect(compatibility[0]).not.toHaveProperty("origin")
        const stillLegacy = ExternalDiff.assessed(session.id)
        expect(Object.keys(stillLegacy).sort()).toEqual(["assessments", "revision", "version"])
        expect(stillLegacy).toMatchObject({ version: legacyWire.version, assessments: legacyWire.assessments })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "keeps generated external patches out of unrequested detail and legacy diff responses",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const session = yield* withSession({ title: "external-egress" })
        const sibling = path.join(path.dirname(test.directory), `external-egress-${session.id}.txt`)
        const sentinel = "EXTERNAL_PATCH_SENTINEL_975"
        yield* fs.writeWithDirs(sibling, `${sentinel}-before\n`)
        const reservation = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })!
        yield* fs.writeWithDirs(sibling, `${sentinel}-after\n`)
        expect(ExternalDiff.commit({ sessionID: session.id, reservation })).toBe(true)

        const detail = yield* requestInDirectory(
          pathFor(SessionPaths.assessedDiff, { sessionID: session.id }),
          test.directory,
        )
        expect(detail.headers["cache-control"]).toBe("no-store")
        expect(JSON.stringify(yield* detail.json)).not.toContain(sentinel)
        expect(JSON.stringify(ExternalDiff.assessed(session.id).assessments)).not.toContain(sentinel)

        const legacy = yield* requestInDirectory(pathFor(SessionPaths.diff, { sessionID: session.id }), test.directory)
        expect(legacy.status).toBe(200)
        expect(yield* legacy.json).toEqual([])

        const requested = yield* requestInDirectory(
          pathFor(SessionPaths.assessedDiff, { sessionID: session.id }) + "?patch=true",
          test.directory,
        )
        expect(JSON.stringify(yield* requested.json)).toContain(sentinel)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "assesses a committed external creation as added and its committed deletion as unchanged",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-create-delete" })
        const fs = yield* FSUtil.Service
        const sibling = path.join(path.dirname(test.directory), `external-new-${session.id}.txt`)

        const create = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })
        expect(create).toBeDefined()
        yield* fs.writeWithDirs(sibling, "created\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: create! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file: sibling, state: "changed", status: "added" }),
        ])

        const remove = ExternalDiff.prepare({ sessionID: session.id, files: [sibling] })
        expect(remove).toBeDefined()
        yield* fs.remove(sibling)
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: remove! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file: sibling, state: "unchanged" }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "commits paired move endpoints atomically with distinct source and destination baselines",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-paired-move" })
        const fs = yield* FSUtil.Service
        const source = path.join(path.dirname(test.directory), `external-source-${session.id}.txt`)
        const missingDestination = path.join(path.dirname(test.directory), `external-destination-${session.id}.txt`)
        const existingDestination = path.join(path.dirname(test.directory), `external-overwrite-${session.id}.txt`)
        yield* fs.writeWithDirs(source, "source\n")
        yield* fs.writeWithDirs(existingDestination, "destination\n")

        const missingMove = ExternalDiff.prepare({ sessionID: session.id, files: [source, missingDestination] })
        expect(missingMove).toBeDefined()
        yield* fs.writeWithDirs(missingDestination, "source\n")
        yield* fs.remove(source)
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: missingMove! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file: source, state: "changed", status: "deleted" }),
            expect.objectContaining({ file: missingDestination, state: "changed", status: "added" }),
          ]),
        )

        const overwriteMove = ExternalDiff.prepare({
          sessionID: session.id,
          files: [missingDestination, existingDestination],
        })
        expect(overwriteMove).toBeDefined()
        yield* fs.writeWithDirs(existingDestination, "source\n")
        yield* fs.remove(missingDestination)
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: overwriteMove! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ file: existingDestination, state: "changed", status: "modified" }),
          ]),
        )

        expect(ExternalDiff.prepare({ sessionID: session.id, files: [source, source] })).toBeUndefined()
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "aborts prepared mutations conservatively and preserves B/E/C evidence",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-abort" })
        const fs = yield* FSUtil.Service
        const fresh = path.join(path.dirname(test.directory), `external-prepared-${session.id}.txt`)
        const file = path.join(path.dirname(test.directory), `external-bec-${session.id}.txt`)

        const firstTouch = ExternalDiff.prepare({ sessionID: session.id, files: [fresh] })
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file: fresh, state: "unavailable" }),
        ])
        expect(ExternalDiff.abort({ sessionID: session.id, reservation: firstTouch! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([])

        yield* fs.writeWithDirs(file, "B\n")
        const committed = ExternalDiff.prepare({ sessionID: session.id, files: [file] })
        yield* fs.writeWithDirs(file, "E\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: committed! })).toBe(true)

        const restored = ExternalDiff.prepare({ sessionID: session.id, files: [file] })
        yield* fs.writeWithDirs(file, "B\n")
        expect(ExternalDiff.abort({ sessionID: session.id, reservation: restored! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file, state: "unchanged" }),
        ])

        const retained = ExternalDiff.prepare({ sessionID: session.id, files: [file] })
        yield* fs.writeWithDirs(file, "E\n")
        expect(ExternalDiff.abort({ sessionID: session.id, reservation: retained! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file, state: "changed", status: "modified" }),
        ])

        const partial = ExternalDiff.prepare({ sessionID: session.id, files: [file] })
        yield* fs.writeWithDirs(file, "C\n")
        expect(ExternalDiff.abort({ sessionID: session.id, reservation: partial! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file, state: "unavailable" }),
        ])

        yield* fs.writeWithDirs(file, "B\n")
        const expectedBaseline = ExternalDiff.prepare({ sessionID: session.id, files: [file] })
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: expectedBaseline! })).toBe(true)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([
          expect.objectContaining({ file, state: "unchanged" }),
        ])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rejects invalid reservation commits without partially replacing expected state",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-invalid-reservations" })
        const fs = yield* FSUtil.Service
        const source = path.join(path.dirname(test.directory), `external-invalid-source-${session.id}.txt`)
        const destination = path.join(path.dirname(test.directory), `external-invalid-destination-${session.id}.txt`)
        yield* fs.writeWithDirs(source, "before\n")

        const initial = ExternalDiff.prepare({ sessionID: session.id, files: [source] })!
        yield* fs.writeWithDirs(source, "expected\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: initial })).toBe(true)
        const before = ExternalDiff.assessed(session.id)

        const stale = ExternalDiff.prepare({ sessionID: session.id, files: [source] })!
        const winning = ExternalDiff.prepare({ sessionID: session.id, files: [source] })!
        yield* fs.writeWithDirs(source, "winning\n")
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: winning })).toBe(true)
        const committed = ExternalDiff.assessed(session.id)
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: stale })).toBe(false)
        expect(ExternalDiff.commit({ sessionID: "other-session", reservation: stale })).toBe(false)
        expect(
          ExternalDiff.commit({
            sessionID: session.id,
            reservation: { ...stale, id: "forged", endpoints: [...stale.endpoints] },
          }),
        ).toBe(false)
        expect(
          ExternalDiff.commit({
            sessionID: session.id,
            reservation: {
              ...stale,
              endpoints: [{ ...stale.endpoints[0], reference: "wrong-reference" }],
            },
          }),
        ).toBe(false)
        const expired = ExternalDiff.prepare({ sessionID: session.id, files: [source], ttlMs: -1 })!
        expect(ExternalDiff.commit({ sessionID: session.id, reservation: expired })).toBe(false)
        expect(before.assessments[0]).toMatchObject({ state: "changed" })
        expect(ExternalDiff.assessed(session.id)).toEqual(committed)

        const group = ExternalDiff.prepare({ sessionID: session.id, files: [source, destination] })!
        yield* fs.writeWithDirs(destination, "partial\n")
        yield* fs.remove(source)
        expect(
          ExternalDiff.commit({
            sessionID: session.id,
            reservation: { ...group, endpoints: [{ ...group.endpoints[0], revision: -1 }, group.endpoints[1]] },
          }),
        ).toBe(false)
        expect(ExternalDiff.assessed(session.id).assessments).toEqual(
          expect.arrayContaining([expect.objectContaining({ file: destination, state: "unavailable" })]),
        )
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "does not publish one endpoint when a paired reservation cannot prepare the other",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "external-prepare-atomic" })
        const fs = yield* FSUtil.Service
        const source = path.join(path.dirname(test.directory), `external-prepare-source-${session.id}.txt`)
        const unreadableDestination = path.join(
          path.dirname(test.directory),
          `external-prepare-destination-${session.id}`,
        )
        yield* fs.writeWithDirs(source, "before\n")
        yield* fs.makeDirectory(unreadableDestination)

        expect(ExternalDiff.prepare({ sessionID: session.id, files: [source, unreadableDestination] })).toBeUndefined()
        expect(ExternalDiff.assessed(session.id).assessments).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns [] for session with no messages",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "empty-session" })

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "falls back to per-message summary diffs when no snapshot parts exist",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "no-snapshots" })
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [
              { file: "src/main.ts", additions: 10, deletions: 2, status: "modified" as const },
              { file: "src/new.ts", additions: 5, deletions: 0, status: "added" as const },
            ],
          },
        } satisfies SessionV1.User)

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        const diffs = (yield* response.json) as Array<{ file: string; additions: number; deletions: number }>
        expect(diffs.length).toBe(2)
        expect(diffs.map((d) => d.file).sort()).toEqual(["src/main.ts", "src/new.ts"])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns net diff for agent-touched files across the session",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "agent-diffs" })
        const snapshot = yield* Snapshot.Service
        const fs = yield* FSUtil.Service

        // Write an initial file before the session starts
        yield* fs.writeWithDirs(path.join(test.directory, "existing.txt"), "original content")
        // Take the session-start snapshot
        const startHash = yield* snapshot.track()
        expect(startHash).toBeTruthy()

        // Create a user message (parts are attached to it for simplicity)
        const userMsgID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        } satisfies SessionV1.User)

        // Attach step-start part (records session-start snapshot)
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-start",
          snapshot: startHash!,
        })

        // Agent writes a new file and modifies an existing one
        yield* fs.writeWithDirs(path.join(test.directory, "new-file.ts"), "export const x = 1")
        yield* fs.writeWithDirs(path.join(test.directory, "existing.txt"), "modified content")

        // Also write a file that the agent did NOT touch (external change)
        yield* fs.writeWithDirs(path.join(test.directory, "external.txt"), "external change")

        // Record a patch part (provides snapshot hash range, but files no longer feed the filter)
        const agentFiles = [path.join(test.directory, "new-file.ts"), path.join(test.directory, "existing.txt")]
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "patch",
          hash: startHash!,
          files: agentFiles,
        })

        // Record tool parts with filediff metadata — this is the agent file filter source (#742)
        const now = Date.now()
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "tool",
          callID: "call_write_1",
          tool: "write",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "new-file.ts",
            metadata: { filediff: { file: path.join(test.directory, "new-file.ts") } },
            time: { start: now, end: now },
          },
        } as any)
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "tool",
          callID: "call_edit_1",
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "existing.txt",
            metadata: { filediff: { file: path.join(test.directory, "existing.txt") } },
            time: { start: now, end: now },
          },
        } as any)

        // Query the session diff via the HTTP endpoint
        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        const diffs = (yield* response.json) as Array<{ file: string; additions: number; deletions: number }>

        // Should include agent-touched files only (not external.txt)
        const files = diffs.map((d) => d.file)
        expect(files).toContain("new-file.ts")
        expect(files).toContain("existing.txt")
        expect(files).not.toContain("external.txt")
        expect(diffs.length).toBe(2)

        // Each diff should have non-zero additions/deletions
        for (const d of diffs) {
          expect((d.additions ?? 0) + (d.deletions ?? 0)).toBeGreaterThan(0)
        }

        // Idempotency: a second call returns the exact same result (#744 flash fix)
        const response2 = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response2.status).toBe(200)
        const diffs2 = yield* response2.json
        expect(diffs2).toEqual(diffs)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "filters out files where agent edits were externally reverted (zero diff)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "reverted-diffs" })
        const snapshot = yield* Snapshot.Service
        const fs = yield* FSUtil.Service

        // Write a file
        yield* fs.writeWithDirs(path.join(test.directory, "reverted.txt"), "original")
        const startHash = yield* snapshot.track()
        expect(startHash).toBeTruthy()

        // Create a user message
        const userMsgID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        } satisfies SessionV1.User)

        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-start",
          snapshot: startHash!,
        })

        // Record the file as agent-touched via patch part (snapshot hash) and filediff
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "patch",
          hash: startHash!,
          files: [path.join(test.directory, "reverted.txt")],
        })
        const now = Date.now()
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "tool",
          callID: "call_edit_reverted",
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "reverted.txt",
            metadata: { filediff: { file: path.join(test.directory, "reverted.txt") } },
            time: { start: now, end: now },
          },
        } as any)

        // File is back to its original content → net diff is zero
        // (we didn't actually change it from the snapshot state)

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "messageID query param is accepted but ignored (backwards compat)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "compat" })

        // Passing messageID should still work (200) but returns session-scoped results
        const messageID = MessageID.ascending()
        const response = yield* requestInDirectory(
          `${pathFor(SessionPaths.diff, { sessionID: session.id })}?messageID=${messageID}`,
          test.directory,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "patch-part files alone do not feed the agent filter (#742 contamination fix)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "contamination" })
        const snapshot = yield* Snapshot.Service
        const fs = yield* FSUtil.Service

        // Write files and take a session-start snapshot
        yield* fs.writeWithDirs(path.join(test.directory, "agent-file.ts"), "original")
        const startHash = yield* snapshot.track()
        expect(startHash).toBeTruthy()

        const userMsgID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        } satisfies SessionV1.User)

        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-start",
          snapshot: startHash!,
        })

        // Simulate an external change picked up by snapshot.patch()
        yield* fs.writeWithDirs(path.join(test.directory, "agent-file.ts"), "modified by someone else")

        // Record a patch part listing the file — but NO tool part with filediff
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "patch",
          hash: startHash!,
          files: [path.join(test.directory, "agent-file.ts")],
        })

        // The diff should be empty: patch-part files should NOT feed the filter
        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        expect(yield* response.json).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "only filediff-tracked files appear even when patch parts list extra files (#742)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "partial-overlap" })
        const snapshot = yield* Snapshot.Service
        const fs = yield* FSUtil.Service

        // Write three files and take the session-start snapshot
        yield* fs.writeWithDirs(path.join(test.directory, "a.ts"), "original a")
        yield* fs.writeWithDirs(path.join(test.directory, "b.ts"), "original b")
        yield* fs.writeWithDirs(path.join(test.directory, "c.ts"), "original c")
        const startHash = yield* snapshot.track()
        expect(startHash).toBeTruthy()

        const userMsgID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        } satisfies SessionV1.User)

        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-start",
          snapshot: startHash!,
        })

        // Modify all three files on disk
        yield* fs.writeWithDirs(path.join(test.directory, "a.ts"), "modified a")
        yield* fs.writeWithDirs(path.join(test.directory, "b.ts"), "modified b")
        yield* fs.writeWithDirs(path.join(test.directory, "c.ts"), "modified c")

        // Patch part claims all three files (the contamination vector)
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "patch",
          hash: startHash!,
          files: [
            path.join(test.directory, "a.ts"),
            path.join(test.directory, "b.ts"),
            path.join(test.directory, "c.ts"),
          ],
        })

        // But the agent only edited a.ts — only it has filediff metadata
        const now = Date.now()
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "tool",
          callID: "call_edit_a",
          tool: "edit",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "a.ts",
            metadata: { filediff: { file: path.join(test.directory, "a.ts") } },
            time: { start: now, end: now },
          },
        } as any)

        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        const diffs = (yield* response.json) as Array<{ file: string }>
        const files = diffs.map((d) => d.file)

        // Only a.ts should appear — b.ts and c.ts were NOT agent-edited
        expect(files).toContain("a.ts")
        expect(files).not.toContain("b.ts")
        expect(files).not.toContain("c.ts")
        expect(diffs.length).toBe(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "returns [] for session with snapshots but no tool edits (plan-mode cross-session leak fix)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* withSession({ title: "plan-mode-leak" })
        const snapshotSvc = yield* Snapshot.Service
        const fs = yield* FSUtil.Service

        // Take the session-start snapshot (before any external edits)
        const startHash = yield* snapshotSvc.track()
        expect(startHash).toBeTruthy()

        // Create a user message
        const userMsgID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
        } satisfies SessionV1.User)

        // Attach step-start part (records session-start snapshot)
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-start",
          snapshot: startHash!,
        })

        // Simulate an external change (another session editing a file)
        yield* fs.writeWithDirs(path.join(test.directory, "foreign-edit.ts"), "edited by another session")

        // Take the step-finish snapshot (captures the foreign edit)
        const endHash = yield* snapshotSvc.track()
        expect(endHash).toBeTruthy()
        expect(endHash).not.toBe(startHash)

        // Attach step-finish part
        yield* Session.use.updatePart({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: userMsgID,
          type: "step-finish",
          snapshot: endHash!,
          reason: "done",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as any)

        // Store contaminated summary.diffs (simulating what computeDiff produces)
        // This is what summarize() does after step-finish — unfiltered snapshot diff
        yield* Session.use.updateMessage({
          id: userMsgID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "plan",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: {
            diffs: [{ file: "foreign-edit.ts", additions: 1, deletions: 0, status: "added" as const }],
          },
        } satisfies SessionV1.User)

        // NO tool parts with filediff — this is a plan-mode session

        // The diff should be empty: snapshots exist, so Fallback 1 should NOT
        // serve contaminated summary.diffs from computeDiff
        const response = yield* requestInDirectory(
          pathFor(SessionPaths.diff, { sessionID: session.id }),
          test.directory,
        )
        expect(response.status).toBe(200)
        const diffs = (yield* response.json) as Array<{ file: string }>
        expect(diffs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

// ── #1136: subagent (task_spawn) edit rollup into the viewed session's diff ──
//
// Foreground Task subagents run in child sessions but mutate the *same*
// worktree, so their bytes are already in the parent's session-start → live
// snapshot range. The only thing scoping them out was the eligible-file set,
// which was built from the viewed session's own tool parts. These tests pin
// the widened set: reachable via `task_spawn` edges, transitively, from the
// VIEWED session (a subtree walk — never a root-flat union that would fold in
// sibling subtrees and reopen the #742 contamination guarantee).
describe("Session.diff — subagent (task_spawn) edit rollup (#1136)", () => {
  // Record a session-start snapshot + step-start part on `sessionID`, and
  // return the start hash for later reference. Mirrors the harness at ~684.
  const recordStart = (sessionID: string) =>
    Effect.gen(function* () {
      const snapshot = yield* Snapshot.Service
      const startHash = yield* snapshot.track()
      const userMsgID = MessageID.ascending()
      yield* Session.use.updateMessage({
        id: userMsgID,
        sessionID: sessionID as any,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
      } satisfies SessionV1.User)
      yield* Session.use.updatePart({
        id: PartID.ascending(),
        sessionID: sessionID as any,
        messageID: userMsgID,
        type: "step-start",
        snapshot: startHash!,
      })
      return { startHash: startHash!, userMsgID }
    })

  // Record a completed edit/write tool part with filediff metadata on
  // `sessionID` (this is the ONLY thing that feeds the agent-touched filter
  // after #742). Files are absolute worktree paths.
  let toolCounter = 0
  const recordToolEdit = (sessionID: string, messageID: string, absFile: string, title: string) =>
    Session.use.updatePart({
      id: PartID.ascending(),
      sessionID: sessionID as any,
      messageID: messageID as any,
      type: "tool",
      callID: `call_${toolCounter++}`,
      tool: "edit",
      state: {
        status: "completed",
        input: {},
        output: "",
        title,
        metadata: { filediff: { file: absFile } },
        time: { start: Date.now(), end: Date.now() },
      },
    } as any)

  const diffFiles = (sessionID: string, directory: string) =>
    Effect.gen(function* () {
      const response = yield* requestInDirectory(pathFor(SessionPaths.diff, { sessionID }), directory)
      expect(response.status).toBe(200)
      const diffs = (yield* response.json) as Array<{ file: string; additions?: number; deletions?: number }>
      return diffs
    })

  it.instance(
    "rolls a task_spawn child's edit into the parent's diff (both files, once each)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-rollup" })
        // Seed files before session-start snapshot
        yield* fs.writeWithDirs(path.join(test.directory, "main.ts"), "orig main")
        yield* fs.writeWithDirs(path.join(test.directory, "sub.ts"), "orig sub")
        const { userMsgID } = yield* recordStart(parent.id)

        // Parent edits main.ts
        yield* fs.writeWithDirs(path.join(test.directory, "main.ts"), "changed main")
        yield* recordToolEdit(parent.id, userMsgID, path.join(test.directory, "main.ts"), "main.ts")

        // task_spawn child edits sub.ts (same worktree)
        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "sub" })
        const childStart = yield* recordStart(child.id)
        yield* fs.writeWithDirs(path.join(test.directory, "sub.ts"), "changed sub")
        yield* recordToolEdit(child.id, childStart.userMsgID, path.join(test.directory, "sub.ts"), "sub.ts")

        const diffs = yield* diffFiles(parent.id, test.directory)
        const files = diffs.map((d) => d.file).sort()
        expect(files).toEqual(["main.ts", "sub.ts"])
        // once each (dedup)
        expect(diffs.length).toBe(2)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "rolls a depth-2 grandchild edit into the root's diff (full-tree, not direct-children-only)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const root = yield* withSession({ title: "root-depth2" })
        yield* fs.writeWithDirs(path.join(test.directory, "deep.ts"), "orig deep")
        yield* recordStart(root.id)

        const child = yield* Session.use.create({ parentID: root.id, lineageEdgeKind: "task_spawn", title: "child" })
        const grandchild = yield* Session.use.create({
          parentID: child.id,
          lineageEdgeKind: "task_spawn",
          title: "grandchild",
        })
        const gStart = yield* recordStart(grandchild.id)
        yield* fs.writeWithDirs(path.join(test.directory, "deep.ts"), "changed deep")
        yield* recordToolEdit(grandchild.id, gStart.userMsgID, path.join(test.directory, "deep.ts"), "deep.ts")

        const diffs = yield* diffFiles(root.id, test.directory)
        expect(diffs.map((d) => d.file)).toContain("deep.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "mid-tree subagent with a sibling subtree returns ONLY its own + its descendants (sibling excluded)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        // Topology:  root
        //             ├── A (task_spawn)  ── A1 (task_spawn) edits a1.ts ; A edits a.ts
        //             └── B (task_spawn)  edits b.ts   ← sibling subtree, MUST be excluded
        const root = yield* withSession({ title: "root-midtree" })
        yield* fs.writeWithDirs(path.join(test.directory, "a.ts"), "orig a")
        yield* fs.writeWithDirs(path.join(test.directory, "a1.ts"), "orig a1")
        yield* fs.writeWithDirs(path.join(test.directory, "b.ts"), "orig b")
        yield* recordStart(root.id)

        const A = yield* Session.use.create({ parentID: root.id, lineageEdgeKind: "task_spawn", title: "A" })
        const aStart = yield* recordStart(A.id)
        yield* fs.writeWithDirs(path.join(test.directory, "a.ts"), "changed a")
        yield* recordToolEdit(A.id, aStart.userMsgID, path.join(test.directory, "a.ts"), "a.ts")

        const A1 = yield* Session.use.create({ parentID: A.id, lineageEdgeKind: "task_spawn", title: "A1" })
        const a1Start = yield* recordStart(A1.id)
        yield* fs.writeWithDirs(path.join(test.directory, "a1.ts"), "changed a1")
        yield* recordToolEdit(A1.id, a1Start.userMsgID, path.join(test.directory, "a1.ts"), "a1.ts")

        const B = yield* Session.use.create({ parentID: root.id, lineageEdgeKind: "task_spawn", title: "B" })
        const bStart = yield* recordStart(B.id)
        yield* fs.writeWithDirs(path.join(test.directory, "b.ts"), "changed b")
        yield* recordToolEdit(B.id, bStart.userMsgID, path.join(test.directory, "b.ts"), "b.ts")

        // View A (mid-tree): must see a.ts (own) + a1.ts (its task_spawn descendant),
        // and MUST NOT see b.ts (sibling subtree).
        const diffs = yield* diffFiles(A.id, test.directory)
        const files = diffs.map((d) => d.file).sort()
        expect(files).toEqual(["a.ts", "a1.ts"])
        expect(files).not.toContain("b.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a file edited at two depths appears exactly once (dedup across depth)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const root = yield* withSession({ title: "root-dedup" })
        yield* fs.writeWithDirs(path.join(test.directory, "shared.ts"), "orig")
        const rStart = yield* recordStart(root.id)

        const child = yield* Session.use.create({ parentID: root.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        const grandchild = yield* Session.use.create({
          parentID: child.id,
          lineageEdgeKind: "task_spawn",
          title: "grandchild",
        })
        const gStart = yield* recordStart(grandchild.id)

        // Both child and grandchild "touch" shared.ts; disk ends changed once.
        yield* fs.writeWithDirs(path.join(test.directory, "shared.ts"), "changed")
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "shared.ts"), "shared.ts")
        yield* recordToolEdit(grandchild.id, gStart.userMsgID, path.join(test.directory, "shared.ts"), "shared.ts")
        void rStart

        const diffs = yield* diffFiles(root.id, test.directory)
        expect(diffs.filter((d) => d.file === "shared.ts").length).toBe(1)
        expect(diffs.length).toBe(1)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a session_spawn child's edit does NOT appear in the parent's diff",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-tab" })
        yield* fs.writeWithDirs(path.join(test.directory, "tab.ts"), "orig tab")
        yield* recordStart(parent.id)

        const tab = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "session_spawn", title: "tab" })
        const tabStart = yield* recordStart(tab.id)
        yield* fs.writeWithDirs(path.join(test.directory, "tab.ts"), "changed tab")
        yield* recordToolEdit(tab.id, tabStart.userMsgID, path.join(test.directory, "tab.ts"), "tab.ts")

        const diffs = yield* diffFiles(parent.id, test.directory)
        expect(diffs.map((d) => d.file)).not.toContain("tab.ts")
        expect(diffs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a task_spawn subagent under a session_spawn tab rolls into the TAB's diff, not the tab's parent's",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        // root ──session_spawn──► tab ──task_spawn──► worker (edits worker.ts)
        const root = yield* withSession({ title: "root-tab-parent" })
        yield* fs.writeWithDirs(path.join(test.directory, "worker.ts"), "orig worker")
        yield* recordStart(root.id)

        const tab = yield* Session.use.create({ parentID: root.id, lineageEdgeKind: "session_spawn", title: "tab" })
        yield* recordStart(tab.id)
        const worker = yield* Session.use.create({
          parentID: tab.id,
          lineageEdgeKind: "task_spawn",
          title: "worker",
        })
        const wStart = yield* recordStart(worker.id)
        yield* fs.writeWithDirs(path.join(test.directory, "worker.ts"), "changed worker")
        yield* recordToolEdit(worker.id, wStart.userMsgID, path.join(test.directory, "worker.ts"), "worker.ts")

        // Viewing the tab: worker is reachable via task_spawn → rolled up.
        const tabDiffs = yield* diffFiles(tab.id, test.directory)
        expect(tabDiffs.map((d) => d.file)).toContain("worker.ts")

        // Viewing root: reachability is task_spawn-only; the session_spawn edge
        // to `tab` is NOT traversed, so worker.ts must NOT appear.
        const rootDiffs = yield* diffFiles(root.id, test.directory)
        expect(rootDiffs.map((d) => d.file)).not.toContain("worker.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a subagent edit reverted to session-start content is filtered (net-zero, incl. diffFromDisk fallback)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-revert" })
        yield* fs.writeWithDirs(path.join(test.directory, "revert.ts"), "original")
        yield* recordStart(parent.id)

        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        // Child records a filediff for revert.ts, but disk is back to original
        // → net-zero. Must be filtered, including through the per-file
        // diffFromDisk (Fallback A) path.
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "revert.ts"), "revert.ts")

        const diffs = yield* diffFiles(parent.id, test.directory)
        expect(diffs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a file created then deleted by a subagent is absent (no net change on disk)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-create-delete" })
        yield* recordStart(parent.id)

        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        const created = path.join(test.directory, "ephemeral.ts")
        yield* fs.writeWithDirs(created, "temp content")
        yield* recordToolEdit(child.id, cStart.userMsgID, created, "ephemeral.ts")
        // Delete it again — net-zero vs the (absent) session-start state.
        yield* fs.remove(created).pipe(Effect.ignore)

        const diffs = yield* diffFiles(parent.id, test.directory)
        expect(diffs.map((d) => d.file)).not.toContain("ephemeral.ts")
        expect(diffs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a legacy session (no lineage row) with a parent_id-only child returns only its own files (no rollup)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const database = yield* Database.Service
        // Legacy parent: create normally, then DELETE its lineage row so
        // SessionLineage.get returns mode "legacy".
        const parent = yield* withSession({ title: "legacy-parent" })
        yield* fs.writeWithDirs(path.join(test.directory, "own.ts"), "orig own")
        yield* fs.writeWithDirs(path.join(test.directory, "childfile.ts"), "orig child")
        const { userMsgID } = yield* recordStart(parent.id)
        yield* fs.writeWithDirs(path.join(test.directory, "own.ts"), "changed own")
        yield* recordToolEdit(parent.id, userMsgID, path.join(test.directory, "own.ts"), "own.ts")

        // A parent_id-only child edits childfile.ts
        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        yield* fs.writeWithDirs(path.join(test.directory, "childfile.ts"), "changed child")
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "childfile.ts"), "childfile.ts")

        // Force the parent into legacy mode: remove its lineage row.
        const { SessionLineageTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { eq } = yield* Effect.promise(() => import("drizzle-orm"))
        yield* database.db
          .delete(SessionLineageTable)
          .where(eq(SessionLineageTable.session_id, parent.id))
          .run()
          .pipe(Effect.orDie)

        const diffs = yield* diffFiles(parent.id, test.directory)
        const files = diffs.map((d) => d.file)
        expect(files).toContain("own.ts")
        expect(files).not.toContain("childfile.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "an external file touched by no session's tools stays excluded even with a subagent present (#742 holds)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-external" })
        yield* fs.writeWithDirs(path.join(test.directory, "sub.ts"), "orig sub")
        yield* recordStart(parent.id)

        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        yield* fs.writeWithDirs(path.join(test.directory, "sub.ts"), "changed sub")
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "sub.ts"), "sub.ts")

        // A worktree file touched by NO session's tools (no filediff anywhere).
        yield* fs.writeWithDirs(path.join(test.directory, "external.ts"), "external change")

        const diffs = yield* diffFiles(parent.id, test.directory)
        const files = diffs.map((d) => d.file)
        expect(files).toContain("sub.ts")
        expect(files).not.toContain("external.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "register() auto-creates lineage for a legacy parent and preserves edgeKind (Bug A fix)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const database = yield* Database.Service

        // Create a parent, then delete its lineage row to simulate legacy
        const parent = yield* withSession({ title: "legacy-parent-fix" })
        const { SessionLineageTable } = yield* Effect.promise(() => import("@opencode-ai/core/session/sql"))
        const { eq } = yield* Effect.promise(() => import("drizzle-orm"))
        yield* database.db
          .delete(SessionLineageTable)
          .where(eq(SessionLineageTable.session_id, parent.id))
          .run()
          .pipe(Effect.orDie)

        // Now create a task_spawn child — this should trigger Bug A fix
        yield* fs.writeWithDirs(path.join(test.directory, "parent.ts"), "orig")
        yield* fs.writeWithDirs(path.join(test.directory, "child.ts"), "orig")
        const { userMsgID } = yield* recordStart(parent.id)
        yield* fs.writeWithDirs(path.join(test.directory, "parent.ts"), "changed")
        yield* recordToolEdit(parent.id, userMsgID, path.join(test.directory, "parent.ts"), "parent.ts")

        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        yield* fs.writeWithDirs(path.join(test.directory, "child.ts"), "changed")
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "child.ts"), "child.ts")

        // The parent should now have a proper lineage row, and the child's
        // edit should roll up into the parent's diff
        const diffs = yield* diffFiles(parent.id, test.directory)
        const files = diffs.map((d) => d.file)
        expect(files).toContain("parent.ts")
        expect(files).toContain("child.ts")
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "a file edited only by a since-deleted subagent is dropped from Files Changed (lineage cascade)",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const fs = yield* FSUtil.Service
        const parent = yield* withSession({ title: "parent-deleted-sub" })
        yield* fs.writeWithDirs(path.join(test.directory, "gone.ts"), "orig gone")
        yield* recordStart(parent.id)

        const child = yield* Session.use.create({ parentID: parent.id, lineageEdgeKind: "task_spawn", title: "child" })
        const cStart = yield* recordStart(child.id)
        // Change remains on disk...
        yield* fs.writeWithDirs(path.join(test.directory, "gone.ts"), "changed gone")
        yield* recordToolEdit(child.id, cStart.userMsgID, path.join(test.directory, "gone.ts"), "gone.ts")

        // ...but the subagent session is deleted (its lineage row cascades away).
        yield* Session.use.remove(child.id)

        const diffs = yield* diffFiles(parent.id, test.directory)
        // No surviving lineage session claims gone.ts → dropped (honest drop-on-delete).
        expect(diffs.map((d) => d.file)).not.toContain("gone.ts")
        expect(diffs).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

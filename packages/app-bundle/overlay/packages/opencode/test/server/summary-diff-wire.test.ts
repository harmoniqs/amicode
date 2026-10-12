/**
 * #1778 — summary patch bodies are cut on the wire only. A real user message
 * with per-file summary diffs goes through the session store and the event-v2
 * bridge: its live global-stream frame carries file/status/counts and no patch
 * text, while the stored message — what `GET /session/:id/message/:messageID`
 * serves, the source the per-turn diff view fetches a patch from on demand —
 * keeps every patch. The durable event's sync copy (sent only to subscribers
 * that replay it into a store of their own) keeps them too.
 */
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import { GlobalEventReplay, type Frame } from "@/bus/global-replay"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { MessageID } from "@/session/schema"
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

const pathFor = (template: string, params: Record<string, string>) =>
  Object.entries(params).reduce((result, [key, value]) => result.replace(`:${key}`, value), template)

const diffs = [
  {
    file: "src/main.ts",
    patch: "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
    additions: 2,
    deletions: 1,
    status: "modified" as const,
  },
  {
    file: "src/new.ts",
    patch: `@@ -0,0 +1,300 @@\n${"+x\n".repeat(300)}`,
    additions: 300,
    deletions: 0,
    status: "added" as const,
  },
]

describe("summary diffs — wire-only projection (#1778)", () => {
  it.instance(
    "the live frame drops patch bodies; the stored message and the sync copy keep them",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const frames: Frame[] = []
        const subscription = GlobalEventReplay.subscribe(undefined, { sync: true })
        subscription.start((frame) => frames.push(frame))
        yield* Effect.addFinalizer(() => Effect.sync(() => subscription.close()))

        const session = yield* Effect.acquireRelease(Session.use.create({ title: "wire-projection" }), (created) =>
          Session.use.remove(created.id).pipe(Effect.ignore),
        )
        const messageID = MessageID.ascending()
        yield* Session.use.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("model") },
          summary: { title: "Edit", diffs },
        } satisfies SessionV1.User)

        const ours = () =>
          frames
            .map((frame) => ({ frame, event: JSON.parse(frame.data) }))
            .filter(({ event }) =>
              event.payload.type === "sync"
                ? event.payload.syncEvent.data?.info?.id === messageID
                : event.payload.type === "message.updated" && event.payload.properties.info.id === messageID,
            )
        // the bridge emits synchronously inside publish: both frames exist now
        const [live, copy, ...extra] = ours()
        expect(extra).toEqual([])

        expect(live.event.payload.type).toBe("message.updated")
        expect(live.frame.syncCopy).toBe(false)
        expect(live.frame.data).not.toContain('"patch"')
        expect(live.event.payload.properties.info.summary).toEqual({
          title: "Edit",
          diffs: diffs.map(({ patch: _patch, ...rest }) => rest),
        })

        expect(copy.event.payload.type).toBe("sync")
        expect(copy.frame.syncCopy).toBe(true)
        expect(copy.frame.seq).toBe(live.frame.seq)
        expect(copy.event.payload.syncEvent.data.info.summary.diffs).toEqual(diffs)

        // the stored record is unchanged — and it is the on-demand patch source
        const response = yield* requestInDirectory(
          pathFor(SessionPaths.message, { sessionID: session.id, messageID }),
          test.directory,
        )
        expect(response.status).toBe(200)
        const stored = (yield* response.json) as { info: { summary?: { diffs: unknown } } }
        expect(stored.info.summary?.diffs).toEqual(diffs)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

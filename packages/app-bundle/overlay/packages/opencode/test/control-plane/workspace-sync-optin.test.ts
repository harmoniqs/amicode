// #1778 — sync copies are opt-in per global-stream subscription. The workspace
// control plane is the one subscriber that replays them, so it must ask for
// them; the remote here behaves like an engine with the opt-in filter (engine-
// shaped frames, `id: <epoch>:<seq>`, sync copies only for `?sync=true`).
// Harness trimmed from workspace.test.ts (upstream) — same layers and helpers.
import { afterEach, beforeEach, describe, expect, mock } from "bun:test"
import Http from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Session as SessionNs } from "@/session/session"
import { SessionID } from "@/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventSequenceTable } from "@opencode-ai/core/event/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideTmpdirInstance, requireInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { registerAdapter } from "../../src/control-plane/adapters"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import type { WorkspaceAdapter } from "../../src/control-plane/types"
import * as Workspace from "../../src/control-plane/workspace"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const originalWorkspacesFlag = process.env.OPENCODE_EXPERIMENTAL_WORKSPACES

const it = testEffect(
  Layer.mergeAll(
    NodeHttpServer.layer(Http.createServer, { host: "127.0.0.1", port: 0 }),
    AppNodeBuilder.build(
      LayerNode.group([
        Workspace.node,
        SessionNs.node,
        SessionProjector.node,
        Database.node,
        InstanceStore.node,
        Ripgrep.node,
      ]),
      [
        [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: true })],
        [
          InstanceStore.bootstrapNode,
          Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
        ],
      ],
    ),
  ),
)

beforeEach(() => {
  process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = "true"
})

afterEach(async () => {
  mock.restore()
  await disposeAllInstances()
  if (originalWorkspacesFlag === undefined) delete process.env.OPENCODE_EXPERIMENTAL_WORKSPACES
  else process.env.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspacesFlag
  await resetDatabase()
})

const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2)}`

function remoteAdapter(url: string): WorkspaceAdapter {
  return {
    name: "remote",
    description: "remote",
    configure: (info) => info,
    async create() {},
    async remove() {},
    target: () => ({ type: "remote", url }),
  }
}

/** An engine-shaped global stream: `id: <epoch>:<seq>` + `data:` per frame, then end. */
function engineStream(frames: { seq: number; event: unknown }[]) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames)
          controller.enqueue(encoder.encode(`id: ep0ch:${frame.seq}\ndata: ${JSON.stringify(frame.event)}\n\n`))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function captureGlobalEvents() {
  const events: GlobalEvent[] = []
  const handler = (event: GlobalEvent) => events.push(event)
  GlobalBus.on("event", handler)
  return { events, dispose: () => GlobalBus.off("event", handler) }
}

function eventuallyEffect(effect: Effect.Effect<void>, timeout = 3000) {
  return Effect.gen(function* () {
    const started = Date.now()
    let last: unknown
    while (Date.now() - started < timeout) {
      const exit = yield* Effect.exit(effect)
      if (exit._tag === "Success") return
      last = exit.cause
      yield* Effect.sleep("10 millis")
    }
    throw last ?? new Error("Timed out waiting for condition")
  })
}

const insertWorkspace = (info: Workspace.Info) =>
  Database.Service.use(({ db }) =>
    db
      .insert(WorkspaceTable)
      .values({
        id: info.id,
        type: info.type,
        branch: info.branch,
        name: info.name,
        directory: info.directory,
        extra: info.extra,
        project_id: info.projectID,
        time_used: info.timeUsed,
      })
      .run()
      .pipe(Effect.orDie),
  )

const attachSessionToWorkspace = (sessionID: SessionID, workspaceID: WorkspaceV2.ID) =>
  Database.Service.use(({ db }) =>
    db.update(SessionTable).set({ workspace_id: workspaceID }).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie),
  )

const sessionSequence = (sessionID: SessionID) =>
  Database.Service.use(({ db }) =>
    db
      .select({ seq: EventSequenceTable.seq })
      .from(EventSequenceTable)
      .where(eq(EventSequenceTable.aggregate_id, sessionID))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.seq),
      ),
  )

describe("workspace control plane — sync copies are opt-in (#1778)", () => {
  it.live("the control-plane subscription requests sync copies and replays them into the local store", () => {
    const requests: { url: URL; syncCopies: string | undefined }[] = []
    let remote: { sessionID: SessionID; info: SessionNs.Info; seq: number } | undefined
    return Effect.gen(function* () {
      yield* HttpServer.serveEffect()(
        Effect.gen(function* () {
          const req = yield* HttpServerRequest.HttpServerRequest
          const url = new URL(req.url, "http://localhost")
          if (url.pathname === "/optin/global/event") {
            const syncCopies = req.headers["x-opencode-sync-copies"]
            requests.push({ url, syncCopies })
            if (!remote) return HttpServerResponse.fromWeb(engineStream([]))
            const id = `evt_${unique("optin")}`
            const event = { type: "session.updated", properties: { sessionID: remote.sessionID, info: remote.info } }
            // the engine's twin emission: the durable event, then its sync copy (same sequence)
            const frames = [{ seq: 7, event: { directory: "remote-dir", payload: { id, ...event } } }]
            if (syncCopies === "true")
              frames.push({
                seq: 7,
                event: {
                  directory: "remote-dir",
                  payload: {
                    id,
                    type: "sync",
                    syncEvent: {
                      id,
                      aggregateID: remote.sessionID,
                      seq: remote.seq,
                      type: "session.updated.1",
                      data: event.properties,
                    },
                  },
                } as never,
              })
            return HttpServerResponse.fromWeb(engineStream(frames))
          }
          if (url.pathname === "/optin/sync/history") return HttpServerResponse.fromWeb(Response.json([]))
          return HttpServerResponse.text("unexpected", { status: 500 })
        }),
      )
      const url = HttpServer.formatAddress((yield* HttpServer.HttpServer).address)
      yield* provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const workspace = yield* Workspace.Service
            const sessions = yield* SessionNs.Service
            const instance = yield* requireInstance
            const captured = captureGlobalEvents()
            try {
              const type = unique("optin")
              const info: Workspace.Info = {
                id: WorkspaceV2.ID.ascending(),
                type,
                name: unique("workspace"),
                branch: null,
                directory: null,
                extra: null,
                projectID: instance.project.id as ProjectV2.ID,
                timeUsed: Date.now(),
              }
              yield* insertWorkspace(info)
              registerAdapter(instance.project.id, type, remoteAdapter(`${url}/optin`))
              const session = yield* sessions.create({ title: "before sync" })
              yield* attachSessionToWorkspace(session.id, info.id)
              remote = {
                sessionID: session.id,
                info: { ...session, workspaceID: info.id, title: "from the remote's sync copy" },
                seq: ((yield* sessionSequence(session.id)) ?? -1) + 1,
              }

              yield* workspace.startWorkspaceSyncing(instance.project.id)

              // replayed correctly: the sync copy reached the local store
              yield* eventuallyEffect(
                Effect.gen(function* () {
                  expect((yield* sessions.get(session.id).pipe(Effect.orDie)).title).toBe("from the remote's sync copy")
                }),
              )
              expect(requests.length).toBeGreaterThan(0)
              expect(requests.every((request) => request.syncCopies === "true")).toBe(true)
              // the opt-in rides a header: the event URL keeps its routed form
              expect(requests.every((request) => request.url.pathname === "/optin/global/event" && !request.url.search)).toBe(
                true,
              )
              // and the remote's frames are still forwarded onto the local bus
              expect(
                captured.events.some((event) => event.workspace === info.id && event.payload.type === "session.updated"),
              ).toBe(true)
              yield* workspace.remove(info.id)
            } finally {
              captured.dispose()
            }
          }),
        { git: true },
      )
    })
  })
})

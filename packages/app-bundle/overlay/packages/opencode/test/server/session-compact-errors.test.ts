import { afterEach, describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable } from "@opencode-ai/core/session/sql"
import { Effect, Layer } from "effect"
import { Session } from "@/session/session"
import { Snapshot } from "@/snapshot"
import { Storage } from "@/storage/storage"
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

describe("session.compact", () => {
  it.instance(
    "maps a typed runner failure to the route's declared service-unavailable error",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const session = yield* Session.use.create({ title: "compact runner failure" })
        yield* Database.Service.use(({ db }) =>
          db
            .insert(SessionMessageTable)
            .values([
              {
                id: SessionMessage.ID.create(),
                session_id: session.id,
                type: "assistant",
                seq: 1,
                time_created: 1,
                data: {} as NonNullable<(typeof SessionMessageTable.$inferInsert)["data"]>,
              },
            ])
            .run()
            .pipe(Effect.orDie),
        )

        const response = yield* requestInDirectory(`/api/session/${session.id}/compact`, test.directory, {
          method: "POST",
        })

        expect(response.status).toBe(503)
        expect(yield* response.json).toEqual({
          _tag: "ServiceUnavailableError",
          message: "Session compact is not available yet",
          service: "session.compact",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})

import { Question } from "@/question"
import type { QuestionID } from "@/question/schema"
import { InstanceBootstrap as InstanceBootstrapService } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { SessionID } from "@opencode-ai/schema/session-id"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Fiber, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, provideInstanceEffect, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const appLayer = AppNodeBuilder.build(
  LayerNode.group([InstanceStore.node, Project.node, Question.node]),
  [[InstanceStore.bootstrapNode, noopBootstrapLayer]],
)
const it = testEffect(appLayer)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("#1730 question cancel", () => {
  it.live("a cancelled question unwinds out of an enclosing uninterruptible region", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
      return yield* Effect.gen(function* () {
        const svc = yield* Question.Service
        const sid = SessionID.make("ses_question_cancel")

        // Simulate the runner's tool-execution context: the ask runs inside an
        // enclosing uninterruptible mask. Before #1730 the wait inherited that
        // mask — Fiber.interrupt could never unwind it, the entry stayed in the
        // pending list (serving as an unanswerable card), and the session's
        // coordinator registration leaked busy until some other error unwound it.
        const asked = yield* Effect.forkScoped(
          svc.ask({
            sessionID: sid,
            questions: [{ header: "Cancel test", question: "stuck?", options: [{ label: "a", description: "the a option" }] }],
          }).pipe(Effect.uninterruptible),
        )

        // the fork races the parent: poll until the ask admits its entry
        let listed = yield* svc.list()
        const deadline = Date.now() + 2000
        while (listed.length === 0 && Date.now() < deadline) {
          yield* Effect.sleep(10)
          listed = yield* svc.list()
        }
        expect(listed.length).toBe(1)
        expect(listed[0]!.sessionID).toBe(sid)

        // the interrupt must land within the bounded window — before the fix
        // this interrupt never completed at all. Fiber.interrupt awaits the
        // fiber's exit: returning at all (vs the 5s outer bound) is the proof.
        yield* Fiber.interrupt(asked)

        // the ensuring must have removed the entry: no ghost card, and a reply
        // now honestly reports not-found instead of dangling
        listed = yield* svc.list()
        expect(listed.length).toBe(0)
        const replied = yield* Effect.exit(
          svc.reply({ requestID: "que_ghost" as QuestionID, answers: [] }),
        )
        expect(replied._tag).toBe("Failure")
      }).pipe(provideInstanceEffect(directory))
    }).pipe(
      Effect.timeout("5 seconds"),
      Effect.orDie,
      Effect.provide(AppNodeBuilder.build(CrossSpawnSpawner.node)),
    ),
  )
})

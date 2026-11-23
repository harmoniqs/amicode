import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { testEffect } from "./lib/effect"

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: () => Effect.void,
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)

const sessionID = SessionV2.ID.make("ses_response_presentation")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "response-presentation",
      directory: "/project",
      title: "response presentation",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

it.effect("preserves response presentation through durable queue promotion", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const admitted = yield* session.prompt({
      sessionID,
      prompt: { text: "Explain the result", response_presentation: "detailed" },
      delivery: "queue",
      resume: false,
    })

    expect(admitted.prompt.response_presentation).toBe("detailed")
    expect(yield* SessionInput.promoteNextQueued(db, events, sessionID)).toBe(true)
    expect(yield* session.messages({ sessionID })).toMatchObject([
      { type: "user", text: "Explain the result", response_presentation: "detailed" },
    ])
  }),
)

it.effect("normalizes an omitted response presentation to standard", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service

    const admitted = yield* session.prompt({
      sessionID,
      prompt: { text: "Explain the result" },
      resume: false,
    })

    expect(admitted.prompt.response_presentation).toBe("standard")
  }),
)

it.effect("rejects an id retry with a different response presentation", () =>
  Effect.gen(function* () {
    yield* setup
    const session = yield* SessionV2.Service
    const id = SessionMessage.ID.create()

    yield* session.prompt({
      id,
      sessionID,
      prompt: { text: "Explain the result", response_presentation: "concise" },
      resume: false,
    })
    const failure = yield* session
      .prompt({
        id,
        sessionID,
        prompt: { text: "Explain the result", response_presentation: "detailed" },
        resume: false,
      })
      .pipe(Effect.flip)

    expect(failure._tag).toBe("Session.PromptConflictError")
  }),
)

import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { RuntimeState } from "@opencode-ai/core/runtime-state"
import { Clock, Deferred, Effect, Layer, Schema, Context } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { SessionID } from "@/session/schema"
import { QuestionID } from "./schema"
import { EventV2Bridge } from "@/event-v2-bridge"
import { QuestionV1 } from "@opencode-ai/schema/question-v1"

export const Option = QuestionV1.Option
export type Option = typeof Option.Type
export const Info = QuestionV1.Info
export type Info = typeof Info.Type
export const Prompt = QuestionV1.Prompt
export type Prompt = typeof Prompt.Type
export const Tool = QuestionV1.Tool
export type Tool = typeof Tool.Type
export const Request = QuestionV1.Request
export type Request = typeof Request.Type
export const Answer = QuestionV1.Answer
export type Answer = typeof Answer.Type
export const Reply = QuestionV1.Reply
export type Reply = typeof Reply.Type
export const Replied = QuestionV1.Replied
export const Rejected = QuestionV1.Rejected
export const Event = QuestionV1.Event

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("QuestionRejectedError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Question.NotFoundError", {
  requestID: QuestionID,
}) {}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>
}

interface State {
  pending: Map<QuestionID, PendingEntry>
}

// Service

export interface Interface {
  readonly ask: (input: {
    sessionID: SessionID
    questions: ReadonlyArray<Info>
    tool?: Tool
  }) => Effect.Effect<ReadonlyArray<Answer>, RejectedError>
  readonly reply: (input: {
    requestID: QuestionID
    answers: ReadonlyArray<Answer>
  }) => Effect.Effect<void, NotFoundError>
  readonly reject: (requestID: QuestionID) => Effect.Effect<void, NotFoundError>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Question") {}

const decodeRequest = Schema.decodeUnknownOption(Request)

const pendingDirectory = Effect.gen(function* () {
  const ctx = yield* InstanceRef
  return ctx ? ctx.directory : null
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Question.state")(function* () {
        const state = {
          pending: new Map<QuestionID, PendingEntry>(),
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    // ── shared-store plumbing (#1760 P2) ─────────────────────────────────────
    // The in-memory fast path stays authoritative; the store is the cross-
    // component truth so any instance can list or resolve a pending request.

    /** The memory-hit reply core: publishes the event and settles the deferred. */
    const applyReply = Effect.fnUntraced(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
      pending.delete(input.requestID)
      yield* Effect.logInfo("replied", { requestID: input.requestID, answers: input.answers })
      yield* events.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        answers: input.answers.map((a) => [...a]),
      })
      yield* Deferred.succeed(existing.deferred, input.answers)
    })

    /** The memory-hit reject core. */
    const applyReject = Effect.fnUntraced(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (!existing) return yield* new NotFoundError({ requestID })
      pending.delete(requestID)
      yield* Effect.logInfo("rejected", { requestID })
      yield* events.publish(Event.Rejected, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
      })
      yield* Deferred.fail(existing.deferred, new RejectedError())
    })

    /**
     * Resolves a pending request this instance does not hold in memory against
     * the shared row instead of one process's memory: a live pending row gets
     * its resolution recorded (the owning ask's reconcile loop applies it); an
     * already-settled row replays idempotently; a dead or unknown row is the
     * only honest "not found".
     */
    const replyThroughStore = Effect.fnUntraced(function* (input: {
      requestID: QuestionID
      settle: "replied" | "rejected"
      resolution?: unknown
    }) {
      const runtime = RuntimeState.getGlobal()
      if (!runtime) return undefined
      const row = yield* RuntimeState.bestEffort(runtime.getPending("question", input.requestID))
      if (row === undefined) return undefined
      if (row.state !== "pending") return "settled" as const
      const now = yield* Clock.currentTimeMillis
      if (row.time_heartbeat < now - RuntimeState.TTL_MS) {
        // The owner's heartbeat lapsed: nothing can consume a resolution.
        yield* Effect.logWarning("question row expired with its owner", { requestID: input.requestID })
        return undefined
      }
      yield* RuntimeState.bestEffort(
        runtime.settlePending({
          kind: "question",
          id: input.requestID,
          state: input.settle,
          resolution: input.resolution,
        }),
      )
      return "recorded" as const
    })

    /**
     * Keeps the shared row heartbeated while the ask waits, and applies a
     * resolution recorded by a mis-routed reply.
     */
    const reconcile = (id: QuestionID, deferred: Deferred.Deferred<ReadonlyArray<Answer>, RejectedError>) =>
      Effect.gen(function* () {
        const runtime = RuntimeState.getGlobal()
        if (!runtime) return yield* Deferred.await(deferred)
        let lastHeartbeat = 0
        for (;;) {
          const now = yield* Clock.currentTimeMillis
          if (now - lastHeartbeat >= RuntimeState.HEARTBEAT_INTERVAL_MS) {
            lastHeartbeat = now
            yield* RuntimeState.bestEffort(runtime.heartbeatPending({ kind: "question", id }))
          }
          const row = yield* RuntimeState.bestEffort(runtime.getPending("question", id))
          if (row?.state === "replied") {
            yield* applyReply({ requestID: id, answers: (row.resolution ?? []) as ReadonlyArray<Answer> })
            return
          }
          if (row?.state === "rejected") {
            yield* applyReject(id)
            return
          }
          yield* Effect.sleep(RuntimeState.RECONCILE_INTERVAL_MS)
        }
      })

    const ask = Effect.fn("Question.ask")(function* (input: {
      sessionID: SessionID
      questions: ReadonlyArray<Info>
      tool?: Tool
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const id = QuestionID.ascending()
      yield* Effect.logInfo("asking", { id, questions: input.questions.length })

      const deferred = yield* Deferred.make<ReadonlyArray<Answer>, RejectedError>()
      const info: Request = {
        id,
        sessionID: input.sessionID,
        questions: input.questions,
        tool: input.tool,
      }
      pending.set(id, { info, deferred })

      // Mirror the pending request into the shared store BEFORE the event, so
      // anything that observes question.asked can also find the store row.
      const runtime = RuntimeState.getGlobal()
      if (runtime) {
        const directory = yield* pendingDirectory
        yield* RuntimeState.bestEffort(
          runtime.recordPending({ kind: "question", id, sessionID: input.sessionID, directory, data: info }),
        )
      }
      yield* events.publish(Event.Asked, info)

      // #1730: the wait must stay CANCELLABLE even under enclosing
      // uninterruptible regions. The runner executes tools inside
      // uninterruptible masks, so a bare Deferred.await was effectively
      // uninterruptible: cancelling a question-waiting turn could never
      // unwind it (session stuck busy, the question serving from the pending
      // list until the turn died some other way). Effect.interruptible forces
      // the wait cancellable through any mask; the ensuring below still
      // removes the entry on every exit path.
      return yield* Effect.ensuring(
        Effect.interruptible(Effect.raceFirst(Deferred.await(deferred), reconcile(id, deferred))),
        Effect.gen(function* () {
          pending.delete(id)
          // The owning ask exited: drop the row only while it is still
          // pending, so an already-settled row keeps its recorded state for
          // reply idempotency until the TTL prunes it.
          if (runtime) {
            yield* RuntimeState.bestEffort(runtime.discardPending({ kind: "question", id }))
          }
        }),
      )
    })

    const reply = Effect.fn("Question.reply")(function* (input: {
      requestID: QuestionID
      answers: ReadonlyArray<Answer>
    }) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(input.requestID)
      if (existing) {
        // Settle the shared row BEFORE the deferred wakes the owning ask: its
        // exit cleanup only discards still-pending rows, and this ordering
        // guarantees the row is settled by the time that cleanup can run.
        const runtime = RuntimeState.getGlobal()
        if (runtime) {
          yield* RuntimeState.bestEffort(
            runtime.settlePending({ kind: "question", id: input.requestID, state: "replied", resolution: input.answers }),
          )
        }
        yield* applyReply(input)
        return
      }
      const throughStore = yield* replyThroughStore({
        requestID: input.requestID,
        settle: "replied",
        resolution: input.answers,
      })
      if (throughStore !== undefined) return
      yield* Effect.logWarning("reply for unknown request", { requestID: input.requestID })
      return yield* new NotFoundError({ requestID: input.requestID })
    })

    const reject = Effect.fn("Question.reject")(function* (requestID: QuestionID) {
      const pending = (yield* InstanceState.get(state)).pending
      const existing = pending.get(requestID)
      if (existing) {
        const runtime = RuntimeState.getGlobal()
        if (runtime) {
          yield* RuntimeState.bestEffort(
            runtime.settlePending({ kind: "question", id: requestID, state: "rejected" }),
          )
        }
        yield* applyReject(requestID)
        return
      }
      const throughStore = yield* replyThroughStore({ requestID, settle: "rejected" })
      if (throughStore !== undefined) return
      yield* Effect.logWarning("reject for unknown request", { requestID })
      return yield* new NotFoundError({ requestID })
    })

    const list = Effect.fn("Question.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      const memory = Array.from(pending.values(), (x) => x.info)
      const runtime = RuntimeState.getGlobal()
      if (!runtime) return memory
      const directory = yield* pendingDirectory
      const rows = yield* RuntimeState.bestEffort(runtime.livePending("question"))
      if (rows === undefined) return memory
      // Memory is the truth for this instance's own rows; the store adds rows
      // held by other instances (same process, other directories) and other
      // processes entirely.
      const memoryIds = new Set(memory.map((item) => item.id))
      const merged: Request[] = [...memory]
      for (const row of rows) {
        if (row.owner_id === RuntimeState.self.owner_id && row.directory === directory) continue
        if (memoryIds.has(row.id as QuestionID)) continue
        const decoded = decodeRequest(row.data)
        if (decoded._tag === "Some") merged.push(decoded.value)
      }
      return merged
    })

    return Service.of({ ask, reply, reject, list })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as Question from "."

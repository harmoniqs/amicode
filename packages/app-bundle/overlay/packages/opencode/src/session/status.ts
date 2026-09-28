import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "./schema"
import { Effect, Layer, Context } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"

export const Info = SessionStatusEvent.Info
export type Info = SessionStatusEvent.Info

export const Event = SessionStatusEvent

// #1636 — a status transition may carry the caller's turn `generation` (the
// ordering context the drop-older guard checks). Only the TURN OWNER (run-state,
// which creates a runner per turn) stamps a generation: the same value on that
// turn's onBusy AND its onIdle. Mid-turn writers (the processor's busy / retry /
// halt-idle) pass NO generation and inherit the session's current one, so they
// neither open a new generation nor look stale. See `set`.
export interface SetOptions {
  readonly generation?: number
  // #1636 — a reconcile idle (run-state.cancel's no-runner branch) is published
  // ONLY if the session is not currently busy from a live turn. It is not a turn
  // boundary, so it carries no generation; the guard below drops it when a newer
  // turn's busy is live, honoring "cancel with no runner does not supersede a
  // newer generation."
  readonly reconcile?: boolean
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info, options?: SetOptions) => Effect.Effect<void>
  // The turn owner (run-state) draws a fresh, session-scoped, monotonic turn
  // generation here at the start of each turn and threads it through that turn's
  // busy/idle. The counter lives in the SERVICE's persistent instance state
  // (which survives across turns), never in the per-turn runner (deleted every
  // turn, so it cannot be monotonic across a session's lifetime).
  readonly nextGeneration: (sessionID: SessionID) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

// #1636 — per-session ledger in the service's persistent instance state. Kept
// separate from the public status Map so deleting a session's status on idle does
// NOT reset its seq/generation — both must be monotonic across the whole session
// lifetime. Fields:
//   seq        — the monotonic ordering key, incremented on every PUBLISHED
//                transition (busy / idle / retry) and stamped on the event data.
//   generation — the highest turn generation observed for this session. A busy /
//                idle carrying a generation greater than this advances it. An idle
//                carrying a generation strictly LESS than this is a completing
//                turn's late idle that a newer turn already superseded — DROPPED
//                (never published), so the last status published for a still-running
//                session is never a stale idle. `nextGeneration` bumps a private
//                counter (turns) and returns it, so run-state's per-turn generation
//                is unique and increasing across the session's whole lifetime.
type Ledger = { seq: number; generation: number; turns: number }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2Bridge.Service

    const status = yield* InstanceState.make(
      Effect.fn("SessionStatus.status")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const ledger = yield* InstanceState.make(
      Effect.fn("SessionStatus.ledger")(() => Effect.succeed(new Map<SessionID, Ledger>())),
    )

    const entry = (state: Map<SessionID, Ledger>, sessionID: SessionID): Ledger =>
      state.get(sessionID) ?? { seq: 0, generation: 0, turns: 0 }

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(status)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(status))
    })

    const nextGeneration = Effect.fn("SessionStatus.nextGeneration")(function* (sessionID: SessionID) {
      const state = yield* InstanceState.get(ledger)
      const prev = entry(state, sessionID)
      const turns = prev.turns + 1
      state.set(sessionID, { ...prev, turns })
      return turns
    })

    const set = Effect.fn("SessionStatus.set")(function* (
      sessionID: SessionID,
      next: Info,
      options?: SetOptions,
    ) {
      const data = yield* InstanceState.get(status)
      const state = yield* InstanceState.get(ledger)
      const prev = entry(state, sessionID)
      const generation = options?.generation

      // Drop-older guard: an idle from a turn whose generation is strictly older
      // than the newest generation observed for this session is stale — a newer
      // turn's busy already superseded it. Do NOT publish it and do NOT clear the
      // status; the still-running session's last published status stays busy.
      if (next.type === "idle" && generation !== undefined && generation < prev.generation) {
        return
      }

      // A reconcile idle (cancel with no runner) is not a turn boundary: publish
      // it only if the session is not currently busy from a live turn, so it never
      // supersedes a newer generation's busy.
      if (next.type === "idle" && options?.reconcile) {
        const current = data.get(sessionID)
        if (current?.type === "busy") return
      }

      const seq = prev.seq + 1
      // A carried generation advances the session's high-water mark; a mid-turn
      // write with no generation keeps it.
      const nextGen = generation !== undefined ? Math.max(prev.generation, generation) : prev.generation
      state.set(sessionID, { seq, generation: nextGen, turns: prev.turns })

      yield* events.publish(Event.Status, { sessionID, status: next, seq })
      if (next.type === "idle") {
        yield* events.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, next)
    })

    return Service.of({ get, list, set, nextGeneration })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2Bridge.node] })

export * as SessionStatus from "./status"

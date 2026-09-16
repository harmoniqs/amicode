import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer, Context } from "effect"
import { Session } from "./session"
import { SessionID } from "./schema"
import { SessionRunState } from "./run-state"

// The reserved session-metadata key that carries the durable Paused marker.
// It rides the existing session metadata JSON column (the same column that
// already holds spawned_by / spawned_depth), so there is no schema migration
// and the marker survives an engine restart.
export const PAUSE_KEY = "pause"

export interface Marker {
  readonly paused: true
  readonly resumable: true
  readonly steer?: string
  readonly at: number
}

export interface ResumeOutcome {
  readonly steer?: string
}

export interface Interface {
  /**
   * Bring a session's in-flight turn to a safe, resumable stopping point.
   * Interrupts the running turn through the EXISTING cancel machinery (fiber
   * interruption + dangling-tool-call reconciliation), then settles the session
   * to Paused by writing the durable marker into session metadata. Idempotent;
   * a session with no running turn is a benign no-op.
   */
  readonly pause: (sessionID: SessionID) => Effect.Effect<void, Session.NotFound>
  /**
   * Clear the Paused marker and return the optional steer message for the
   * caller to inject into the continuing turn. Resume itself is re-dispatch (a
   * fresh continuing turn), not resurrection of the interrupted fiber.
   */
  readonly resume: (sessionID: SessionID, steer?: string) => Effect.Effect<ResumeOutcome, Session.NotFound>
  /** The durable Paused marker, or undefined when the session is not paused. */
  readonly marker: (sessionID: SessionID) => Effect.Effect<Marker | undefined, Session.NotFound>
  /** Whether the session is durably marked Paused (survives restart). */
  readonly isPaused: (sessionID: SessionID) => Effect.Effect<boolean, Session.NotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionPause") {}

function readMarker(metadata: Record<string, unknown> | undefined): Marker | undefined {
  const raw = metadata?.[PAUSE_KEY]
  if (!raw || typeof raw !== "object") return undefined
  const candidate = raw as Record<string, unknown>
  if (candidate.paused !== true) return undefined
  return {
    paused: true,
    resumable: true,
    ...(typeof candidate.steer === "string" ? { steer: candidate.steer } : {}),
    at: typeof candidate.at === "number" ? candidate.at : 0,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const runState = yield* SessionRunState.Service

    const marker: Interface["marker"] = Effect.fn("SessionPause.marker")(function* (sessionID) {
      const session = yield* sessions.get(sessionID)
      return readMarker(session.metadata)
    })

    const isPaused: Interface["isPaused"] = Effect.fn("SessionPause.isPaused")(function* (sessionID) {
      return (yield* marker(sessionID)) !== undefined
    })

    const pause: Interface["pause"] = Effect.fn("SessionPause.pause")(function* (sessionID) {
      const session = yield* sessions.get(sessionID)
      // Write the durable Paused marker into the existing metadata JSON column.
      // This is the parallel outcome: the session settles to `paused` rather
      // than `cancelled`, and is marked resumable.
      yield* sessions.setMetadata({
        sessionID,
        metadata: {
          ...(session.metadata ?? {}),
          [PAUSE_KEY]: { paused: true, resumable: true, at: Date.now() } satisfies Marker,
        },
      })
      // Interrupt the running turn through the existing cancel machinery. This
      // reconciles dangling tool calls to the interrupted marker. A session
      // with no running turn cancels to idle — a benign no-op.
      yield* runState.cancel(sessionID)
    })

    const resume: Interface["resume"] = Effect.fn("SessionPause.resume")(function* (sessionID, steer) {
      const session = yield* sessions.get(sessionID)
      const rest = { ...(session.metadata ?? {}) }
      delete rest[PAUSE_KEY]
      yield* sessions.setMetadata({ sessionID, metadata: rest })
      return { ...(steer !== undefined ? { steer } : {}) }
    })

    return Service.of({ pause, resume, marker, isPaused })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [Session.node, SessionRunState.node] })

export * as SessionPause from "./pause"

// engine-toggle.ts — #1598: pure logic for the engine on/off toggle.
//
// Message-driven state machine: the extension pushes engine-state and
// fleet-role messages; this module parses them into typed state. The
// component (engine-toggle.tsx) renders from this state.

/** Engine lifecycle state as pushed by the extension.
 *  #1608: `stopping` narrates a deliberate off — the toggle grays/locks between
 *  the click and the resting `off` state. It stays in sync with the extension's
 *  EngineState (engine_state_push.ts) — the two definitions are the only two. */
export type EngineState = "on" | "booting" | "off" | "stopping"

/** Fleet role as pushed by the extension. */
export type FleetRole = "standalone" | "server" | "client"

/** Parse an engine-state message from the extension bridge. */
export function parseEngineStateMessage(
  data: unknown,
): EngineState | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as { source?: string; kind?: string; state?: string }
  if (d.source !== "amicode" || d.kind !== "engine-state") return undefined
  if (d.state === "on" || d.state === "booting" || d.state === "off" || d.state === "stopping") return d.state
  return undefined
}

/** Parse a fleet-role message from the extension bridge. */
export function parseFleetRoleMessage(
  data: unknown,
): FleetRole | undefined {
  if (!data || typeof data !== "object") return undefined
  const d = data as { source?: string; kind?: string; role?: string }
  if (d.source !== "amicode" || d.kind !== "fleet-role") return undefined
  if (d.role === "standalone" || d.role === "server" || d.role === "client") return d.role
  return undefined
}

/** Send a bridge command to the extension (stop or restart the engine). */
export function sendEngineCommand(state: EngineState): void {
  if (state === "on") {
    // Engine is on → stop it
    window.parent?.postMessage(
      { source: "amicode", kind: "command", command: "amicode.stopServer" },
      "*",
    )
  } else if (state === "off") {
    // Engine is off → restart it
    window.parent?.postMessage(
      { source: "amicode", kind: "command", command: "amicode.restartServer" },
      "*",
    )
  }
  // booting / stopping → locked transitional states, no action
}

/** Exhaustiveness helper — a future EngineState addition that isn't handled in
 *  a switch becomes a COMPILE error here (#1608 AC9), never a silent fallthrough. */
export function assertNever(x: never): never {
  throw new Error(`unhandled engine state: ${String(x)}`)
}

/** The engine dot's CSS token for a lifecycle state — the exhaustive switch the
 *  toggle renders from (#1608 AC4). `stopping` reads warning (grayed/locked),
 *  same family as `booting`. */
export function engineDotClass(state: EngineState): string {
  switch (state) {
    case "on":
      return "bg-icon-success-base"
    case "booting":
    case "stopping":
      return "bg-icon-warning-base"
    case "off":
      return "bg-border-weak-base"
    default:
      return assertNever(state)
  }
}

/** The calm off/stopping/booting narration was removed (#1608 follow-up): the
 *  toggle's own dot/lock is the whole story, per the user. See engineDotClass. */

/** Self-expiring latch resolution (#1608 BUG1). The stuck-stopping bug was the
 *  latch reading `stopping` forever when the confirming `off` push was dropped
 *  (engine dead → SSE gone → the push never arrives). This resolves the latch
 *  to its INTENDED terminal state `off` once `timeoutMs` elapses, so the toggle
 *  is never permanently grayed:
 *   - no latch (`latchedAt` undefined) → raw passes through;
 *   - raw already changed (a push landed) → raw wins immediately;
 *   - latch set, raw still `on`, inside the window → `stopping`;
 *   - latch set, raw still `on`, window elapsed → `off` (clickable to restart).
 *  Pure so it is testable without the solid signal graph or real timers. */
export function latchedEngineStateAt(
  raw: EngineState,
  latchedAt: number | undefined,
  now: number,
  timeoutMs: number,
): EngineState {
  if (latchedAt === undefined) return raw
  if (raw !== "on") return raw // a real push already moved us off `on`
  return now - latchedAt >= timeoutMs ? "off" : "stopping"
}

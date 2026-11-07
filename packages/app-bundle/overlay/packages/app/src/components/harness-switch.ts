// amicode#1549 — the harness banner's decision layer, the solver-switch twin
// (solver-switch.ts) in shape and discipline: a switch is not instant and it
// is not quiet — the extension watcher sees {status:"switching"}, performs
// the registry-gated setting persist, and RESTARTS the server underneath the
// webview. For those seconds the SSE stream is simply gone; without a signal
// that reads as an upgrade, the drop reads as a fault. Like the solver twin,
// this speaks ONLY for a switch the app itself requested.
//
// Pure helpers so the phase contract is testable without a DOM.

export type HarnessSwitchPhase = "idle" | "requested" | "restarting" | "ready"

/** Phase from the two observable facts: is a switch outstanding, and has the
 *  stream dropped yet. `sawDrop` is latched by the caller — once the server
 *  has gone down, coming back up means "ready", not "still waiting to start". */
export function harnessSwitchPhase(input: {
  target: string | undefined
  connected: boolean
  sawDrop: boolean
}): HarnessSwitchPhase {
  if (!input.target) return "idle"
  if (!input.connected) return "restarting"
  return input.sawDrop ? "ready" : "requested"
}

/** The watcher polls harness.json every 1s, so a request that has not taken
 *  the server down well inside this window is not going to — abandon quietly
 *  rather than leave a permanent pill on screen (the solver twin's discipline). */
export const HARNESS_SWITCH_STALL_MS = 12_000
/** Total ceiling: never trap the user behind theater, however wedged the
 *  restart is. */
export const HARNESS_SWITCH_MAX_MS = 90_000

export function harnessSwitchExpired(phase: HarnessSwitchPhase, elapsedMs: number): boolean {
  if (phase === "requested") return elapsedMs > HARNESS_SWITCH_STALL_MS
  if (phase === "restarting") return elapsedMs > HARNESS_SWITCH_MAX_MS
  return false
}

/** One name end to end — the banner narrates the displayName the registry
 *  published, so the banner and the select never disagree about what the user
 *  just picked. */
export function harnessSwitchLabel(phase: HarnessSwitchPhase, target: string | undefined): string | undefined {
  if (!target || phase === "idle") return undefined
  if (phase === "requested") return `Switching to ${target}…`
  if (phase === "restarting") return "Restarting session server…"
  return `${target} ready`
}

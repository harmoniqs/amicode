import type { SolverMode } from "./solver-toggle"

// AMICODE: the solver-switch banner's decision layer (opencode#78 follow-up).
//
// A switch is not instant and it is not quiet: the extension watcher sees
// {status:"switching"}, re-preps the session config, and RESTARTS the opencode
// server underneath the webview. For those seconds the SSE stream is simply
// gone. Without a signal that reads as an upgrade, the drop reads as a fault —
// or worse, as the endless "thinking" wave the reconnect loop hides behind.
//
// Deliberately narrower than the removed ConnectionBanner (unmounted 2026-08-07,
// f696388/a03aa04): this speaks ONLY for a switch the app itself requested.
// General connection drops stay silent — reintroducing that warning is a
// separate call, and not this one to make.
//
// Pure helpers so the phase contract is testable without a DOM, matching the
// decision-helper split in solver-toggle.tsx.

export type SolverSwitchPhase = "idle" | "requested" | "restarting" | "ready"

/** Phase from the two observable facts: is a switch outstanding, and has the
 *  stream dropped yet. `sawDrop` is latched by the caller — once the server has
 *  gone down, coming back up means "ready", not "still waiting to start". */
export function solverSwitchPhase(input: {
  target: SolverMode | undefined
  connected: boolean
  sawDrop: boolean
}): SolverSwitchPhase {
  if (!input.target) return "idle"
  if (!input.connected) return "restarting"
  return input.sawDrop ? "ready" : "requested"
}

/** The extension watcher polls solver-mode.json every 1s, so a request that has
 *  not taken the server down well inside this window is not going to — no
 *  extension host, a stale binary, a write that never landed. Abandon quietly
 *  rather than leave a permanent pill on screen (opencode#132's failure mode). */
export const SOLVER_SWITCH_STALL_MS = 12_000
/** Total ceiling, inherited from the stale #14 wizard's safety valve: never trap
 *  the user behind theater, however wedged the restart is. */
export const SOLVER_SWITCH_MAX_MS = 90_000

export function solverSwitchExpired(phase: SolverSwitchPhase, elapsedMs: number): boolean {
  if (phase === "requested") return elapsedMs > SOLVER_SWITCH_STALL_MS
  if (phase === "restarting") return elapsedMs > SOLVER_SWITCH_MAX_MS
  return false
}

/** The names the capsule already shows — one name end to end, so the banner and
 *  the toggle never disagree about what the user just picked. */
export function solverModeName(mode: SolverMode): string {
  return mode === "hp" ? "Piccolissimo + Altissimo" : "Piccolo"
}

export function solverSwitchLabel(phase: SolverSwitchPhase, target: SolverMode | undefined): string | undefined {
  if (!target || phase === "idle") return undefined
  if (phase === "requested") return `Switching to ${solverModeName(target)}…`
  if (phase === "restarting") return "Restarting session server…"
  return `${solverModeName(target)} ready`
}

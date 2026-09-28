// stop-server command (#1149, ADR 0020; #1598)
//
// A deliberate kill for the surviving server — alongside Restart, the two
// DELIBERATE kills. Runs directly, with NO confirmation: toggling the engine
// off (the "amicode" status row) or the "Amicode: Stop server" palette entry
// IS the intent, and Restart (toggle on) is symmetric — no prompt either.
//
// (History: #1149 gated this on an in-flight-turns warning, but the only
// available predicate was SSE stream liveness, which is true whenever the
// engine is healthy — so it fired on essentially every stop, idle or not.
// A deliberate toggle needs no nag; the guard was removed in #1598.)
//
// stop() → deleteHandshake(). deleteHandshake uses #1144's primitive — the
// handshake record is always cleared so no stale record survives the kill.
// #1608: the kill is now narrated — `stopping` before, `off` in a `finally`.

/** Dependencies injected for testability — every live seam is mockable. */
export interface StopServerDeps {
  /** Kill the server process (ServerManager.stop). */
  stop: () => Promise<void>;
  /** Delete the handshake record (#1144's primitive). */
  deleteHandshake: () => void;
  /** #1608: push a lifecycle state to the app toggle. Optional — callers that
   *  don't drive the toggle (or tests that don't assert narration) omit it.
   *  `stopping` is pushed before the kill; `off` in a `finally` so a throwing
   *  stop never strands the toggle mid-transition. */
  pushState?: (state: "stopping" | "off") => void;
}

/**
 * Stop the surviving server — the deliberate kill. No confirmation:
 * pushState("stopping") → stop() → deleteHandshake(), with pushState("off")
 * in a `finally`. The handshake is cleared AFTER the kill so no stale record
 * survives; `off` is pushed even if stop() throws so the toggle resolves to a
 * definite state (#1608 AC7) rather than staying stuck on `stopping`.
 */
export async function stopServer(deps: StopServerDeps): Promise<void> {
  deps.pushState?.("stopping");
  try {
    await deps.stop();
    deps.deleteHandshake();
  } finally {
    deps.pushState?.("off");
  }
}

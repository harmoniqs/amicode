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

/** Dependencies injected for testability — every live seam is mockable. */
export interface StopServerDeps {
  /** Kill the server process (ServerManager.stop). */
  stop: () => Promise<void>;
  /** Delete the handshake record (#1144's primitive). */
  deleteHandshake: () => void;
}

/**
 * Stop the surviving server — the deliberate kill. No confirmation:
 * stop() → deleteHandshake(). The handshake is cleared AFTER the kill so no
 * stale record survives.
 */
export async function stopServer(deps: StopServerDeps): Promise<void> {
  await deps.stop();
  deps.deleteHandshake();
}

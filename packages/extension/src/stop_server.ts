// stop-server command (#1149, ADR 0020)
//
// A deliberate kill for the surviving server — alongside Restart, the two
// DELIBERATE kills. Gated on in-flight turns: when active chat turns exist,
// the command warns with "Stop" / "Cancel" before proceeding.
//
// On confirm (or no turns): stop() → deleteHandshake().
// deleteHandshake uses #1144's primitive — the handshake record is always
// cleared so no stale record survives the kill.

/** Dependencies injected for testability — every live check is a seam. */
export interface StopServerDeps {
  /** Returns true when any chat session has an in-flight LLM turn. */
  hasInFlightTurns: () => boolean;
  /** Show a warning with "Stop" and "Cancel" options. Returns the picked label
   *  or undefined (dismissed). */
  showWarning: (message: string, ...items: string[]) => Promise<string | undefined>;
  /** Kill the server process (ServerManager.stop). */
  stop: () => Promise<void>;
  /** Delete the handshake record (#1144's primitive). */
  deleteHandshake: () => void;
}

/**
 * Stop the surviving server — the deliberate kill.
 *
 * When in-flight turns exist, warns first. On confirm (or no turns):
 * stop() → deleteHandshake(). On cancel/dismiss: no-op.
 */
export async function stopServer(deps: StopServerDeps): Promise<void> {
  if (deps.hasInFlightTurns()) {
    const choice = await deps.showWarning(
      "Amicode: there are in-flight turns. Stop the server anyway?",
      "Stop",
      "Cancel",
    );
    if (choice !== "Stop") return;
  }

  await deps.stop();
  deps.deleteHandshake();
}

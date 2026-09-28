// quit-command (#1597)
//
// A single action that stops the engine AND closes the window — the "I'm
// done" complement to Stop (engine only) and Restart.
//
// CRITICAL ORDERING: stop BEFORE close. If the window closes first,
// deactivate's detach() runs (which does NOT kill) — the engine survives
// until the idle timer fires. Stop must happen before the window teardown.
//
// On confirm (or no turns): stop() → deleteHandshake() → closeWindow().

/** Dependencies injected for testability — every live check is a seam. */
export interface QuitDeps {
  /** Returns true when any chat session has an in-flight LLM turn. */
  hasInFlightTurns: () => boolean;
  /** Show a warning with "Quit" and "Cancel" options. Returns the picked
   *  label or undefined (dismissed). */
  showWarning: (message: string, ...items: string[]) => Promise<string | undefined>;
  /** Kill the server process (ServerManager.stop). */
  stop: () => Promise<void>;
  /** Delete the handshake record (#1144's primitive). */
  deleteHandshake: () => void;
  /** Close the VS Code window. */
  closeWindow: () => void | Promise<void>;
}

/**
 * Quit Amicode — stop the engine then close the window.
 *
 * When in-flight turns exist, warns first. On confirm (or no turns):
 * stop() → deleteHandshake() → closeWindow(). On cancel/dismiss: no-op.
 */
export async function quitAmicode(deps: QuitDeps): Promise<void> {
  if (deps.hasInFlightTurns()) {
    const choice = await deps.showWarning(
      "Amicode: there are in-flight turns. Quit anyway?",
      "Quit",
      "Cancel",
    );
    if (choice !== "Quit") return;
  }

  // CRITICAL: stop BEFORE close. If we close first, deactivate's
  // detach() runs (which does NOT kill), stranding the engine.
  await deps.stop();
  deps.deleteHandshake();
  await deps.closeWindow();
}

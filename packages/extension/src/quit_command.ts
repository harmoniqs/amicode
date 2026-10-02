// quit-command (#1597; #1598)
//
// A single action that stops the engine AND closes the window — the "I'm
// done" complement to Stop (engine only) and Restart. Runs with NO
// confirmation: like Stop, invoking Quit IS the intent.
//
// (History: #1597 gated this on an in-flight-turns warning, but the only
// available predicate was SSE stream liveness, which is true whenever the
// engine is healthy — so it fired on essentially every quit. Removed in
// #1598. VS Code still guards genuinely dirty editors on window close.)
//
// CRITICAL ORDERING: stop BEFORE close. If the window closes first,
// deactivate's detach() runs (which does NOT kill) — the engine survives
// until the idle timer fires. Stop must happen before the window teardown.
//
// stop() → deleteHandshake() → closeWindow().

/** Dependencies injected for testability — every live seam is mockable. */
export interface QuitDeps {
  /** Kill the server process (ServerManager.stop). */
  stop: () => Promise<void>;
  /** Delete the handshake record (#1144's primitive). */
  deleteHandshake: () => void;
  /** Close the VS Code window. Accepts Thenable (vscode.commands.executeCommand). */
  closeWindow: () => void | PromiseLike<void>;
}

/**
 * Quit Amicode — stop the engine then close the window. No confirmation:
 * stop() → deleteHandshake() → closeWindow().
 *
 * CRITICAL: stop BEFORE close. If we close first, deactivate's detach()
 * runs (which does NOT kill), stranding the engine.
 */
export async function quitAmicode(deps: QuitDeps): Promise<void> {
  // CRITICAL: stop BEFORE close. If we close first, deactivate's
  // detach() runs (which does NOT kill), stranding the engine.
  await deps.stop();
  deps.deleteHandshake();
  await deps.closeWindow();
}

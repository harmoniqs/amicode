import * as fs from "node:fs";
import { slackFile } from "./amicode_service/credentials";

// ============================================================================
// Slack credential watcher (#1204 / #1037): the Slack MCP entry in
// OPENCODE_CONFIG_CONTENT is baked at server spawn time — credential changes
// (connect / disconnect in the Connections panel) have no effect until the
// server restarts and rebuilds the config. This watcher detects changes to
// ~/.amico/slack.json (create / delete / modify) and fires a callback so the
// extension can trigger a server restart.
//
// Pattern: poll-based (same as watchSolverMode — fs.watch is unreliable for
// rewrite-in-place on macOS). OAuth writes the file atomically (write tmp +
// rename), which can cause two rapid mtime changes in one poll window; the
// 500 ms debounce coalesces them into a single callback.
// ============================================================================

function readMtimeMs(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return undefined; // file absent or unreadable
  }
}

/** Poll-based watcher for the Slack credential file. Fires `onChange` (at
 *  most once per debounce window) when the file is created, deleted, or
 *  modified. Returns a disposable that stops the polling. */
export function watchSlackCredential(
  onChange: () => void,
  filePath: string = slackFile(),
  pollIntervalMs = 1000,
  debounceMs = 500,
): { dispose(): void } {
  let lastMtimeMs: number | undefined = readMtimeMs(filePath);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;

  const timer = setInterval(() => {
    if (busy) return;
    const currentMtimeMs = readMtimeMs(filePath);
    // undefined === undefined covers the "still absent" steady state;
    // a numeric mtime equality covers the "still the same file" case.
    if (currentMtimeMs === lastMtimeMs) return;
    lastMtimeMs = currentMtimeMs;
    // Debounce: coalesce rapid changes from atomic writes.
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      busy = true;
      try {
        onChange();
      } finally {
        busy = false;
      }
    }, debounceMs);
  }, pollIntervalMs);

  return {
    dispose() {
      clearInterval(timer);
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    },
  };
}

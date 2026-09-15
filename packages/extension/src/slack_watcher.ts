import * as fs from "node:fs";
import { slackFile } from "./amicode_service/credentials";

// ============================================================================
// Slack credential watcher (#1204 / #1037 v2): detects changes to
// ~/.amico/slack.json (create / delete / modify) and fires a callback with
// { exists: boolean } so the extension can dynamically add/remove the
// slack-mcp-server via the engine's MCP API — no server restart needed.
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
 *  modified. The callback receives `{ exists: boolean }` — true when the
 *  credential file now exists, false when it was deleted. Returns a
 *  disposable that stops the polling. */
export function watchSlackCredential(
  onChange: (state: { exists: boolean }) => void,
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
        onChange({ exists: currentMtimeMs !== undefined });
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

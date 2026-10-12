import type { SessionStatus } from "@opencode-ai/sdk/v2/client"

/**
 * #1637 — the store-readable half of the `session_working` floor, shared by both
 * implementations (the server-session store and the global-sync child store) so
 * they honor the SAME turn-active floor.
 *
 * A session is working when its turn-active flag is up (it is inside a
 * `session.execution.started` bracket whose terminal / fallback clear has not
 * arrived — this covers no-part turns and survives a stray idle) OR its status
 * is anything other than idle. The server-session store ORs its in-memory
 * streamActiveParts stream floor on top of this.
 */
export function sessionWorkingFromStore(status: SessionStatus | undefined, turnActive: boolean): boolean {
  if (turnActive) return true
  return (status?.type ?? "idle") !== "idle"
}

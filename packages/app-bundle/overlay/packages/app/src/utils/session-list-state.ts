// D2 (spec spec-20260905-045114-session-device-lifecycle): honest client
// states and the in-product panel-state reset scope. Ported from the held
// fork reference (harmoniqs/opencode#296) onto the app overlay at canonical
// v1.18.29 (issue #817). Pure and vscode/solid-free so it unit-tests headless
// (the consumers wire it to the sync stores).

export type SessionListState = "unfetched" | "empty" | "ready"

/** Distinguish "not yet fetched" (a persisted snapshot may exist but no list
 *  request has completed — incident #293's invisible failure) from "genuinely
 *  empty" (a fetch completed and the projection is empty). */
export function sessionListState(input: { fetched: boolean; count: number; searching?: boolean }): SessionListState {
  if (input.count > 0) return "ready"
  if (!input.fetched && !input.searching) return "unfetched"
  return "empty"
}

export type ResetClass = "session-cache" | "workspace-pref"

/** Classify a persisted-store key for the "Reset panel state" command: the
 *  reset clears session caches ONLY — workspace preferences (settings,
 *  archive cutoff, posture config) and user drafts (prompt content) are
 *  never destroyed by a recovery action. */
export function classifyResetTarget(key: string, target?: { draft?: boolean }): ResetClass {
  if (target?.draft) return "workspace-pref"
  if (key.startsWith("session:")) return "session-cache"
  return "workspace-pref"
}

/** The canonical list of session caches the "Reset panel state" command
 *  clears: child-store session fields plus the session-list query keys.
 *  Persisted workspace preferences are not on this list — recovery never
 *  destroys configuration. */
export function panelResetTouches(): readonly string[] {
  return [
    "session",
    "session_status",
    "sessionTotal",
    "session_diff",
    "diff_version",
    "session:snapshot",
    "loadSessions",
    "activeSessions",
  ]
}

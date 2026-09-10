/**
 * The devtools rebuild flag protocol.
 *
 * localStorage flags (amicode:devtools-rebuilding / -rebuilt / -reopen)
 * survive iframe reloads that happen mid-rebuild (e.g. a git checkout
 * inside a watched workspace folder during a remote rebuild). The
 * controller's onMount reads them to tell "still rebuilding" apart from
 * "finished while the dialog was closed".
 *
 * This module is the pure decision of what to set/clear at each lifecycle
 * event, kept separate from the SolidJS signal wiring so the protocol
 * itself is directly testable. The critical invariant it encodes: "start"
 * must never set "rebuilt" — only "done" may, and only once the extension
 * host has actually reported completion.
 */

export type RebuildFlagEvent = "start" | "done" | "failed"

export type RebuildFlagKey = "rebuilding" | "reopen" | "rebuilt"

export interface RebuildFlagMutation {
  /** Flags to set to "1". */
  set: Partial<Record<RebuildFlagKey, "1">>
  /** Flags to remove. */
  clear: RebuildFlagKey[]
}

export function rebuildFlagMutation(event: RebuildFlagEvent): RebuildFlagMutation {
  switch (event) {
    case "start":
      // Rebuild kicks off: mark it in progress and ask the app to reopen
      // settings at the devtools section after any reload. Do NOT set
      // "rebuilt" here — that was the bug (#940): it made a mid-build
      // dialog reopen show "Rebuilt!" instead of "Rebuilding...".
      return { set: { rebuilding: "1", reopen: "1" }, clear: [] }
    case "done":
      // Extension host reported success: clear the in-progress flag and
      // set the success flag onMount needs to show "Rebuilt!" after reload.
      return { set: { rebuilt: "1" }, clear: ["rebuilding"] }
    case "failed":
      // Extension host reported failure: clear in-progress, no success flag.
      return { set: {}, clear: ["rebuilding"] }
  }
}

const STORAGE_PREFIX = "amicode:devtools-"

/** Apply a mutation to localStorage. Swallows errors (storage may be unavailable). */
export function applyRebuildFlagMutation(mutation: RebuildFlagMutation): void {
  try {
    for (const key of mutation.clear) localStorage.removeItem(STORAGE_PREFIX + key)
    for (const [key, value] of Object.entries(mutation.set)) {
      if (value) localStorage.setItem(STORAGE_PREFIX + key, value)
    }
  } catch {
    // non-critical
  }
}

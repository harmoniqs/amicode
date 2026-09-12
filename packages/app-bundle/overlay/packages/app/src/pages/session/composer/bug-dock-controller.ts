// amicode/opencode#117: the bug-report dock's controller — a module-singleton
// state machine the dock component (session-bug-dock.tsx) renders against.
// Kept component-free so the contract stays unit-testable (the app has no
// component-render test surface — Solid needs its compile-time transform;
// see the issue's Testing Decisions). Lifecycle spec: amicode ADR 0004 —
// collapse never kills; only the close control (pre-file) or filing ends the
// bug session; the extension owns the real close after archiving.
//
// Bridge contract (mirrored by the extension slice, amicode#250):
//   DOWN {source:"amicode", kind:"open-bug-report",  sessionID}
//   DOWN {source:"amicode", kind:"close-bug-report", sessionID}
//   UP   {source:"amicode", kind:"bug-filed",         sessionID, url}
//   UP   {source:"amicode", kind:"bug-report-closed", sessionID}
import { createSignal } from "solid-js"
import { bugReportEnabled } from "@/utils/amicode-bug-report"
import { bugDock } from "./bug-dock"

export const OPEN_BUG_REPORT_KIND = "open-bug-report"
export const CLOSE_BUG_REPORT_KIND = "close-bug-report"
export const BUG_FILED_KIND = "bug-filed"
export const BUG_REPORT_CLOSED_KIND = "bug-report-closed"

/** "closed" — no dock. "chat" — dock live, iframe hosting the bug session.
 *  "filed" — terminal end-state (issue link) until the extension closes it. */
export type BugDockPhase = "closed" | "chat" | "filed"

// The skill's terminal sentinel (the run-telemetry idiom), printed ONLY after
// actual filing — never at the confirm gate, so a veto never emits it. On the
// browser-fallback path there is no URL and the line carries the literal
// token `filed-via-browser`. Anchored to line start, multiline (a streamed
// part's text carries whole chunks of the transcript); the separator is
// HORIZONTAL whitespace only so a bare sentinel at end-of-line can't capture
// the next line's first word.
const BUG_FILED_SENTINEL = /AMICODE_BUG_FILED\s+(https?:\/\/\S+|filed-via-browser)/

/** Match the terminal sentinel in a streamed text part — the issue URL, the
 *  `filed-via-browser` token, or undefined for non-matching traffic. */
export function matchBugFiledUrl(text: string): string | undefined {
  const match = BUG_FILED_SENTINEL.exec(text)
  if (!match) return undefined
  // Strip trailing punctuation/backticks the model might append
  return match[1].replace(/[`'")\].,;:!]+$/, "")
}

/** The sync-watch's selector: the live bug session in a synced session-info
 *  set, if any. A bug session carries `metadata.bug_report` (the extension's
 *  create envelope); archived ones are terminal (filed → archived, the
 *  end-state latches separately). Most-recently-created wins — the
 *  extension's single-open invariant means there is at most one in practice.
 *
 *  This is the open path that CANNOT be lost (QA: amicode#249 preview): the
 *  bridge's open-bug-report is the fast path, but it rides a fire-and-forget
 *  postMessage through the webview; a bug session's presence in the app's own
 *  synced session list is ground truth the dock can always see. */
export function findLiveBugSession(
  sessions: Iterable<{ id?: unknown; metadata?: unknown; time?: { created?: unknown; archived?: unknown } } | undefined>,
): string | undefined {
  const cutoff = Date.now() - 90 * 1000 // skip sessions older than 90 seconds
  let best: { id: string; created: number } | undefined
  for (const s of sessions) {
    if (!s || typeof s.id !== "string" || s.id === "") continue
    const meta = s.metadata
    if (!meta || typeof meta !== "object" || !("bug_report" in meta)) continue
    if (s.time?.archived) continue
    const created = typeof s.time?.created === "number" ? s.time.created : 0
    if (created < cutoff) continue // stale session from a previous run
    if (!best || created > best.created) best = { id: s.id, created }
  }
  return best?.id
}

// ---------------------------------------------------------------------------
// The progress strip (amicode#249 QA): a live "where is the agent" line for
// the dock, derived from the bug session's OWN streamed tool calls — the
// skill's phases are observable (dedup search → upstream/pin check → filing),
// so the dock narrates them instead of sitting silent between turns.
// ---------------------------------------------------------------------------

/** Classify one bash command into a progress step, when it tells us anything. */

/** Where is the agent, from observable state. Priority: a pending request
 *  (the agent is blocked on the user) beats a turn error (the turn is OVER —
 *  never narrate progress over a dead one; amicode#249 QA — a balance/auth
 *  failure otherwise reads as "Working…" forever) beats tool progress; the
 *  LATEST informative tool call wins; completed tools count as much as
 *  running ones (a finished dedup search still narrates "checking", until
 *  the next informative call supersedes it). */
/** Scan a session's message parts for the sentinel. Text parts only; the
 *  first match wins. The caller scopes the parts to the bug session — the
 *  watcher only ever observes the session the dock hosts. */
export function findBugFiledUrl(parts: Iterable<{ type: string; text?: string }>): string | undefined {
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue
    const url = matchBugFiledUrl(part.text)
    if (url) return url
  }
  return undefined
}

export type BugDockControllerDeps = {
  /** the boot-param gate (amicode_bug_report=1) — the dock is inert without it */
  enabled?: () => boolean
  /** bridge up-post — defaults to the amicode message envelope */
  post?: (kind: string, payload: Record<string, unknown>) => void
  /** the #116 open-state seam — the dock owns open()/close() */
  dock?: Pick<typeof bugDock, "open" | "close">
}

const defaultPost = (kind: string, payload: Record<string, unknown>) => {
  try {
    window.parent?.postMessage({ source: "amicode", kind, ...payload }, "*")
  } catch {}
}

export function createBugDockController(deps: BugDockControllerDeps = {}) {
  const enabled = deps.enabled ?? bugReportEnabled
  const post = deps.post ?? defaultPost
  const dock = deps.dock ?? bugDock

  const [sessionID, setSessionID] = createSignal<string>()
  const [open, setOpen] = createSignal(false)
  const [collapsed, setCollapsed] = createSignal(false)
  const [filedUrl, setFiledUrl] = createSignal<string>()
  /** amicode#249: a 2 s window between filing and the terminal end-state
   *  so the strip narrates "Submitted!" before the archive state lands. */
  /** The last dismissed session — the sync watch must never resurrect it
   *  (amicode#249 QA): close dismisses locally BEFORE the extension's
   *  abort+delete lands, and an unguarded watch re-adopts the still-living
   *  session in that window — the dock fought the close. A NEW session (a
   *  different id) always adopts; a dismissed id never does. Tracks ALL
   *  dismissed sessions (not just the last) so stale bug sessions from
   *  previous runs can't resurrect the dock either. */
  const dismissedIDs = new Set<string>()

  const phase = (): BugDockPhase => {
    if (!open()) return "closed"
    return filedUrl() ? "filed" : "chat"
  }

  const adopt = (id: string) => {
    setSessionID(id)
    setCollapsed(false)
    setFiledUrl(undefined)
    setOpen(true)
    dock.open()
  }

  const dismiss = () => {
    const id = sessionID()
    if (id) dismissedIDs.add(id)
    setOpen(false)
    setSessionID(undefined)
    setCollapsed(false)
    setFiledUrl(undefined)
    dock.close()
  }

  const handleBridgeMessage = (data: unknown) => {
    if (typeof data !== "object" || !data) return
    const message = data as { source?: unknown; kind?: unknown; sessionID?: unknown }
    if (message.source !== "amicode") return
    if (message.kind === OPEN_BUG_REPORT_KIND) {
      if (!enabled()) return
      if (typeof message.sessionID !== "string" || !message.sessionID) return
      if (!open() && dismissedIDs.has(message.sessionID as string)) {
        // A dismissed session is never resurrected — not by the bridge, not
        // by the sync watch (which adopts through this same path).
        return
      }
      if (open()) {
        // One bug dock per window. A duplicate open for the hosted session is
        // a reveal (re-expand; crucially NOT a re-adopt — the filed end-state
        // must survive it). A different session id is dropped: the
        // extension's single-open guard owns which bug session is live.
        if (message.sessionID === sessionID()) reveal()
        return
      }
      adopt(message.sessionID)
      return
    }
    if (message.kind === CLOSE_BUG_REPORT_KIND) {
      // Extension-initiated close (post-archive teardown): close quietly —
      // the extension already knows, posting bug-report-closed back would lie.
      // BUT: never auto-close if the dock is showing the filed end-state —
      // that IS the terminal state the user sees; only they close it.
      if (!open() || message.sessionID !== sessionID()) return
      if (filedUrl()) return
      dismiss()
    }
  }

  /** The chevron — collapse/re-expand only. Never posts, never closes:
   *  collapsing the dock keeps the bug session alive (ADR 0004). */
  const toggleCollapsed = () => {
    if (!open()) return
    setCollapsed((value) => !value)
  }

  /** Re-expand an open-but-collapsed dock — the button's revealNonce path.
   *  Never posts. */
  const reveal = () => {
    if (!open()) return
    setCollapsed(false)
  }

  /** The close control — the ONLY user action that ends an unfiled session.
   *  Posts bug-report-closed exactly once (the dock is closed after the first
   *  request, so there is no second), then dismisses locally; the extension
   *  aborts + hard-deletes the session. */
  const requestClose = () => {
    const id = sessionID()
    if (!open() || !id) return
    post(BUG_REPORT_CLOSED_KIND, { sessionID: id })
    dismiss()
  }

  /** The sentinel watcher matched — the skill filed. Posts bug-filed exactly
   *  once (latched: the sentinel keeps matching in the persisted transcript,
   *  so the phase guard is load-bearing) and switches to the terminal
   *  end-state; the dock stays open until the extension closes it. */
  const file = (url: string) => {
    const id = sessionID()
    if (!open() || !id || filedUrl()) return
    post(BUG_FILED_KIND, { sessionID: id, url })
    setFiledUrl(url)
  }

  return {
    phase,
    sessionID,
    collapsed,
    filedUrl,
    handleBridgeMessage,
    toggleCollapsed,
    reveal,
    requestClose,
    file,
  }
}

export type BugDockController = ReturnType<typeof createBugDockController>

/** The one dock per window — the component renders against this instance. */
export const bugDockController = createBugDockController()

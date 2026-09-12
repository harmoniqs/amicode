// amicode/opencode#116: the report-a-bug button in the v2 composer is a
// fork-only feature, gated on the `amicode_bug_report=1` boot param the
// extension passes — standalone opencode never sets it, so the composer's
// control row stays byte-identical there. Read once at boot from entry.tsx
// (same convention as amicode-hide-project): the router rewrites the URL
// after boot, so a live read of window.location.search would flip mid-flight.
let enabled = false

/** Adopt the boot flag from a URL search string — sets the gate to whether
 *  `amicode_bug_report=1` is present (deterministic, so tests can drive both
 *  directions; entry.tsx calls this exactly once with the real boot URL). */
export function adoptBugReportFlag(search: string): void {
  enabled = new URLSearchParams(search).get("amicode_bug_report") === "1"
}

/** Whether the report-a-bug composer button renders. */
export function bugReportEnabled(): boolean {
  return enabled
}

/** UP kind: the app's boot catch-up for the bug-report dock. Posted once per
 *  app-frame boot when the flag is on; the extension re-posts open-bug-report
 *  when a bug session is live. Heals a lost one-shot open (cold-boot race,
 *  webview reload) — the dock contract's pull half (QA: amicode#249 preview). */
export const BUG_REPORT_POKE_KIND = "bug-report-poke"

/** Post the boot poke to the extension host — only embedded (a webview parent
 *  exists) and only with the flag on (standalone opencode never pokes). Safe
 *  to call on every app boot: the extension treats it as cheap idempotent
 *  noise when no bug session is live. */
export function postBugReportPoke(post: (envelope: { source: string; kind: string }) => void = defaultPokePost): void {
  if (!bugReportEnabled()) return
  post({ source: "amicode", kind: BUG_REPORT_POKE_KIND })
}

function defaultPokePost(envelope: { source: string; kind: string }): void {
  try {
    if (window.parent && window.parent !== window) window.parent.postMessage(envelope, "*")
  } catch {
    /* a detached frame never blocks boot */
  }
}

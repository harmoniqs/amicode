// amicode#116: the report-a-bug button's click behavior, kept component-free
// so the contract stays unit-testable (the app has no component-render test
// surface — Solid needs its compile-time transform; see Testing Decisions on
// the issue). The button calls reportBug(); the dock seam stays injectable so
// tests can drive it directly.
import { bugDock } from "./bug-dock"

/** The bridge command the extension host relays to its bug-report flow. */
export const REPORT_BUG_COMMAND = "amicode.reportBug"

export function reportBug(dock: Pick<typeof bugDock, "isOpen" | "reveal"> = bugDock): void {
  // Dock already open → reveal/re-expand it and post nothing; the flow is
  // already alive, a second bridge post would spawn a duplicate.
  if (dock.isOpen()) {
    dock.reveal()
    return
  }
  try {
    window.parent?.postMessage({ source: "amicode", kind: "command", command: REPORT_BUG_COMMAND }, "*")
  } catch {}
}

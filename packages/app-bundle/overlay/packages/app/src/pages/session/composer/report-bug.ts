// amicode#116: the report-a-bug button's click behavior, kept component-free
// so the contract stays unit-testable (the app has no component-render test
// surface — Solid needs its compile-time transform; see Testing Decisions on
// the issue). The button calls reportBug(); the dock seam stays injectable so
// tests can drive it directly.
import { bugDock } from "./bug-dock"

/** The bridge command the extension host relays to its bug-report flow. */
export const REPORT_BUG_COMMAND = "amicode.reportBug"

/** Live model selection carried onto the bug session (amicode#277). */
export interface ReportBugModel {
  providerID: string
  modelID: string
  variant?: string
}

export function reportBug(
  dock: Pick<typeof bugDock, "isOpen" | "reveal"> = bugDock,
  model?: ReportBugModel,
): void {
  // #476: a second click while the dock is open must NOT be swallowed.
  // Reveal (focus/re-expand) the existing dock AND still post the command so
  // the extension can prompt to start a new report. The extension owns the
  // single-open invariant and will either re-reveal the existing session or,
  // after confirmation, close it and open a fresh one.
  if (dock.isOpen()) {
    dock.reveal()
  }
  try {
    const envelope: Record<string, unknown> = { source: "amicode", kind: "command", command: REPORT_BUG_COMMAND }
    if (
      model &&
      typeof model.providerID === "string" &&
      model.providerID !== "" &&
      model.providerID.length <= 200 &&
      typeof model.modelID === "string" &&
      model.modelID !== "" &&
      model.modelID.length <= 200
    ) {
      const payload: Record<string, string> = { providerID: model.providerID, modelID: model.modelID }
      if (typeof model.variant === "string" && model.variant !== "" && model.variant.length <= 200) {
        payload.variant = model.variant
      }
      envelope.model = payload
    }
    window.parent?.postMessage(envelope, "*")
  } catch {}
}

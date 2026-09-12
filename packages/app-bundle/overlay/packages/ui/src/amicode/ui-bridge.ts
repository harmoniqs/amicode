import { createSignal } from "solid-js"
import type { WidgetHostCallbacks } from "./widget-frame"
import type { ProblemView, RunStatusView } from "./problem"

// AMICODE: register/dispatch singleton connecting receipt/chip clicks to the
// one component that holds app context (the entity rail registers handlers on
// mount, unregisters on cleanup — the ask-bridge idiom). Unregistered → no-op.
//
// The bridge is a SIGNAL, not a plain let: the message cards mount BEFORE the
// rail (the rail renders after the message list in the timeline JSX), so the
// registration has to be reactive — a card that read an unregistered bridge
// would otherwise never upgrade from its compact chip to the inline entity
// view once the rail mounts.

// Stage 2 chat authoring: the in-chat widget preview needs the same server
// context the home grid has (frame src base, host callbacks) plus a pin verb.
// Provided by the app alongside fetchRunSeries; optional so a host that can't
// render widgets (e.g. TUI) simply shows a fallback note.
export type AmicodeWidgetHost = {
  frameSrc: (id: string, hash: string) => string
  callbacks: WidgetHostCallbacks
  pin: (id: string, size: "hero" | "tile") => Promise<unknown>
}

export type AmicodeUiBridge = {
  openEntity: (kind: string, seq?: number) => void
  // spec C: transport for the in-chat run window, provided by the app (the rail
  // holds server context). Optional so older registrations stay valid.
  fetchRunSeries?: (run: string, lab?: string) => Promise<unknown>
  widgetHost?: AmicodeWidgetHost
  // Inline entity views (Kate 2026-07-24): the receipt renders the full entity
  // view in-transcript instead of opening a modal. The rail already owns the
  // live problem view + run statuses + a refetch, so it registers them here;
  // draftPrompt/labels come from the app (composer + i18n). All optional →
  // an undefined problemView ⇒ the card falls back to its compact chip.
  problemView?: () => ProblemView | undefined
  runStatus?: () => RunStatusView[]
  draftPrompt?: (text: string) => void
  refetchProblem?: () => void
  retryLabel?: string
  editLabel?: string
}
const [bridge, setBridge] = createSignal<AmicodeUiBridge | undefined>(undefined)
export function registerAmicodeUiBridge(next: AmicodeUiBridge): () => void {
  setBridge(next)
  return () => {
    if (bridge() === next) setBridge(undefined)
  }
}
export function openAmicodeEntity(kind: string, seq?: number): void {
  bridge()?.openEntity(kind, seq)
}
/** Returns undefined when no transport is registered (no-op, like the openers). */
export function fetchAmicodeRunSeries(run: string, lab?: string): Promise<unknown> | undefined {
  return bridge()?.fetchRunSeries?.(run, lab)
}
/** The widget-host transport for the in-chat preview; undefined ⇒ no host. */
export function amicodeWidgetHost(): AmicodeWidgetHost | undefined {
  return bridge()?.widgetHost
}
/** Live problem view for the in-transcript entity view; undefined ⇒ no rail / loading. */
export function amicodeProblemView(): ProblemView | undefined {
  return bridge()?.problemView?.()
}
/** Live run statuses (for the Run verdict); [] when no rail is registered. */
export function amicodeRunStatus(): RunStatusView[] {
  return bridge()?.runStatus?.() ?? []
}
/** Draft the ✎ edit-in-chat prompt into the composer; no-op without a rail. */
export function amicodeDraftPrompt(text: string): void {
  bridge()?.draftPrompt?.(text)
}
/** Re-fetch the problem after an error retry; no-op without a rail. */
export function amicodeRefetchProblem(): void {
  bridge()?.refetchProblem?.()
}
/** i18n labels for the inline entity view, with English fallbacks. */
export function amicodeEntityLabels(): { retry: string; edit: string } {
  const b = bridge()
  return { retry: b?.retryLabel ?? "Retry", edit: b?.editLabel ?? "Edit in chat" }
}

import { createSignal } from "solid-js"
import type { WidgetHostCallbacks } from "./widget-frame"

// AMICODE: register/dispatch singleton connecting in-transcript surfaces to
// the one component that holds app context (the session timeline registers
// handlers on mount, unregisters on cleanup — the ask-bridge idiom).
// Unregistered → no-op.
//
// The bridge is a SIGNAL, not a plain let: the message cards mount BEFORE the
// timeline body registers (the cards render inside the timeline JSX), so the
// registration has to be reactive — a card that read an unregistered bridge
// would otherwise never upgrade once the host mounts.
//
// #1818: the deprecated entity surfaces (rail chips, entity views, the
// openEntity / problemView / runStatus transport they consumed) are REMOVED.
// What the bridge still carries is the LIVE transport: fetchRunSeries (the
// in-transcript RunWindow's poll) and widgetHost (the in-chat widget preview's
// frame src + host callbacks + pin).

// Stage 2 chat authoring: the in-chat widget preview needs the same server
// context the home grid has (frame src base, host callbacks) plus a pin verb.
// Provided by the app; optional so a host that can't render widgets (e.g.
// TUI) simply shows a fallback note.
export type AmicodeWidgetHost = {
  frameSrc: (id: string, hash: string) => string
  callbacks: WidgetHostCallbacks
  pin: (id: string, size: "hero" | "tile") => Promise<unknown>
}

export type AmicodeUiBridge = {
  // spec C: transport for the in-chat run window, provided by the app.
  fetchRunSeries?: (run: string, lab?: string) => Promise<unknown>
  widgetHost?: AmicodeWidgetHost
}
const [bridge, setBridge] = createSignal<AmicodeUiBridge | undefined>(undefined)
export function registerAmicodeUiBridge(next: AmicodeUiBridge): () => void {
  setBridge(next)
  return () => {
    if (bridge() === next) setBridge(undefined)
  }
}
/** Returns undefined when no transport is registered (no-op, like the openers). */
export function fetchAmicodeRunSeries(run: string, lab?: string): Promise<unknown> | undefined {
  return bridge()?.fetchRunSeries?.(run, lab)
}
/** The widget-host transport for the in-chat preview; undefined ⇒ no host. */
export function amicodeWidgetHost(): AmicodeWidgetHost | undefined {
  return bridge()?.widgetHost
}

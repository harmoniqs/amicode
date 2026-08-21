// amicode(split): the right half of an in-app split is the APP ITSELF iframed
// with ?amicode_pane=<id> — a pane is a full instance (its own titlebar, its
// own tab strip) whose GLOBAL UI state is namespaced by that id so it never
// fights the main instance (persisted stores read at boot and don't live-sync
// across documents — a shared "tabs" key would be last-writer-wins).
// Captured at MODULE LOAD: the router rewrites the URL as the pane navigates
// internally, so a live read of window.location.search would flip mid-flight.
export const AMICODE_PANE_ID: string | undefined =
  new URLSearchParams(window.location.search).get("amicode_pane") || undefined

export const IS_AMICODE_PANE = AMICODE_PANE_ID !== undefined


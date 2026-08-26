// amicode(deck): a framing host webview (Amicode's Chat Deck shell) wants each
// pane's live route + label so its tab strip can show real names (and rebuild a
// dragged pane at its current route). Posted to window.parent over the same
// {source:"amicode"} envelope as the clipboard/link bridges; no-op unframed so
// plain browser tabs are unaffected. `path` is same-origin only (pathname +
// search — the draft's draftId rides the search, and the shell needs it to
// keep draft text across pane rebuilds).
export function postRouteInfo(path: string, title?: string) {
  if (window.parent === window) return
  window.parent.postMessage({ source: "amicode", kind: "route-info", path, title }, "*")
}

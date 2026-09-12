// AMICODE: imperative side of the iframe→extension bridge for OPENING FILES.
// Anchors handle chat-markdown links declaratively (session-ui markdown.tsx
// posts on click); chips and tool cards outside markdown call this instead.
// No-op outside the framed VS Code webview. The host (extension chat_bridge.ts)
// validates absolute + exists on every message, so a stale path fails quiet.
export function openFileInEditor(absPath: string): void {
  if (window.parent === window) return
  window.parent.postMessage({ source: "amicode", kind: "open-file", url: "file://" + encodeURI(absPath) }, "*")
}

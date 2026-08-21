// Clipboard write that survives the Amicode VS Code webview. Inside the
// sandboxed chat iframe, navigator.clipboard and execCommand("copy") never
// reach the OS clipboard — the extension host owns it, so post the
// "clipboard-write" envelope over the same bridge the app uses
// (prompt-input/clipboard-bridge.ts). Unframed (desktop shell, plain
// browser), the native paths stand. session-ui twin of the app's helper
// (@opencode-ai/ui exports only components/*.tsx, so util/clipboard is
// unreachable across the package boundary).
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ source: "amicode", kind: "clipboard-write", text }, "*")
    return true // fire-and-forget, matching the app's writeClipboardViaBridge
  }
  const body = typeof document === "undefined" ? undefined : document.body
  if (body) {
    const textarea = document.createElement("textarea")
    textarea.value = text
    textarea.setAttribute("readonly", "")
    textarea.style.position = "fixed"
    textarea.style.opacity = "0"
    textarea.style.pointerEvents = "none"
    body.appendChild(textarea)
    textarea.select()
    const copied = document.execCommand("copy")
    body.removeChild(textarea)
    if (copied) return true
  }
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.writeText) return false
  return clipboard.writeText(text).then(
    () => true,
    () => false,
  )
}

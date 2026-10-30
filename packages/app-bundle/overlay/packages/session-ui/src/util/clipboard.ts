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

// Image copy. The OS clipboard belongs to the VS Code extension host, which
// runs on the machine the user is sitting at (an interface machine, not
// necessarily the server that rendered the image), so inside the chat iframe
// the PNG rides the bridge as "clipboard-image-write" and the host writes it
// natively (vscode.env.clipboard is text-only). Unframed, the async Clipboard
// API stands. Non-PNG sources are rasterized first: PNG is the one image type
// every clipboard target (Slides, Keynote, Docs) accepts.
export async function copyImageToClipboard(src: string): Promise<boolean> {
  const png = await pngDataUrl(src)
  if (!png) return false
  if (typeof window !== "undefined" && window.parent !== window) {
    window.parent.postMessage({ source: "amicode", kind: "clipboard-image-write", dataUrl: png }, "*")
    return true // fire-and-forget, like copyTextToClipboard
  }
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.write || typeof ClipboardItem === "undefined") return false
  const blob = await fetch(png).then((res) => res.blob())
  return clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
    () => true,
    () => false,
  )
}

export async function pngDataUrl(src: string): Promise<string | undefined> {
  if (src.startsWith("data:image/png;base64,")) return src
  if (typeof document === "undefined") return undefined
  const image = new Image()
  image.src = src
  const loaded = await image.decode().then(
    () => true,
    () => false,
  )
  if (!loaded || !image.naturalWidth) return undefined
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  canvas.getContext("2d")?.drawImage(image, 0, 0)
  return canvas.toDataURL("image/png")
}

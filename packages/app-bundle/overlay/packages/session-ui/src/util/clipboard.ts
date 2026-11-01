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
// natively (vscode.env.clipboard is text-only). Unlike text copy this is NOT
// fire-and-forget: the host's native write can fail (no xclip, a sandboxed
// osascript), so the caller awaits the nonce'd "clipboard-image-written" reply
// and only reports success on `ok: true` — no reply within the timeout is a
// failure. Unframed, the async Clipboard API stands. Non-PNG sources are
// rasterized first: PNG is the one image type every clipboard target (Slides,
// Keynote, Docs) accepts.
export async function copyImageToClipboard(src: string, opts: { timeoutMs?: number } = {}): Promise<boolean> {
  const png = await pngDataUrl(src)
  if (!png) return false
  if (typeof window !== "undefined" && window.parent !== window)
    return requestHostImageWrite(window, png, opts.timeoutMs)
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
  if (!clipboard?.write || typeof ClipboardItem === "undefined") return false
  try {
    const blob = await fetch(png).then((res) => res.blob())
    await clipboard.write([new ClipboardItem({ "image/png": blob })])
    return true
  } catch {
    return false
  }
}

/** Post "clipboard-image-write" to the framing webview and resolve with the
 *  host's verdict: true only on a "clipboard-image-written" reply carrying OUR
 *  nonce and `ok: true`; false on `ok: false` or no reply within `timeoutMs`
 *  (the host's own writer gives up at 5 s). Exported for the bridge test. */
export function requestHostImageWrite(win: Window, dataUrl: string, timeoutMs = 10_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36)
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean) => {
      win.removeEventListener("message", onMessage)
      if (timer !== undefined) clearTimeout(timer)
      resolve(ok)
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; kind?: string; nonce?: string; ok?: unknown } | undefined
      if (data?.source !== "amicode" || data.kind !== "clipboard-image-written" || data.nonce !== nonce) return
      finish(data.ok === true)
    }
    win.addEventListener("message", onMessage)
    timer = setTimeout(() => finish(false), timeoutMs)
    try {
      win.parent.postMessage({ source: "amicode", kind: "clipboard-image-write", dataUrl, nonce }, "*")
    } catch {
      finish(false)
    }
  })
}

/** The PNG data URL for `src`, or undefined when it can't be produced. Never
 *  throws: a cross-origin image taints the canvas and toDataURL raises a
 *  SecurityError — that is a failed copy, not an unhandled rejection. */
export async function pngDataUrl(src: string): Promise<string | undefined> {
  if (src.startsWith("data:image/png;base64,")) return src
  if (typeof document === "undefined") return undefined
  try {
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
    const ctx = canvas.getContext("2d")
    if (!ctx) return undefined
    ctx.drawImage(image, 0, 0)
    return canvas.toDataURL("image/png")
  } catch {
    return undefined
  }
}

// ⌘V inside the Amicode chat: the app runs as a cross-origin iframe inside the
// VS Code webview, where native paste and navigator.clipboard deliver no data
// (the webview parent holds no clipboard-read permission to delegate down). The
// extension host CAN read it, so we ask over the amicode postMessage bridge —
// chat_panel.ts reads vscode.env.clipboard and replies with {kind:"clipboard"}.
// Mirrors the profile-input fallback in @opencode-ai/ui's home-cards.
//
// Resolves "" when unframed (plain web/desktop, where native paste already
// works), on a malformed reply, or after `timeoutMs` with no answer — callers
// treat "" as "nothing to insert", so a missing or dead bridge degrades to a
// no-op rather than a hang.

const BRIDGE_TIMEOUT_MS = 1500

// ⌘C inside the Amicode chat is the mirror image of ⌘V: the sandboxed iframe's
// native copy (and navigator.clipboard.writeText) never reaches the OS
// clipboard, so a subsequent ⌘V — which DOES read the OS clipboard over the
// bridge — pastes whatever stale thing was there before, not what you copied.
// Push the copied text to the extension host, which writes vscode.env.clipboard
// so read and write hit the same clipboard. Fire-and-forget: the host write is
// near-instant and callers have nothing to await. Resolves false (no-op) when
// unframed — native copy already works there.
export function writeClipboardViaBridge(text: string, win: Window = window): boolean {
  if (win.parent === win) return false
  win.parent.postMessage({ source: "amicode", kind: "clipboard-write", text }, "*")
  return true
}

// The bridge only answers inside the AMICODE webview — its parent runs the
// relay. Every OTHER framed host (VS Code Simple Browser pointed at :3002, any
// plain iframe embed) posts into the void, times out, and — because the ⌘V
// handlers preventDefault before asking — pastes NOTHING, silently. So an
// empty/timed-out bridge reply falls through to navigator.clipboard.readText():
// dead in the VS Code webview (no permission to lose), but it restores paste in
// every framed host that grants clipboard-read. API-key entry was the reported
// casualty (credential fields are exactly what you paste into an embedded app).
async function readTextDirect(win: Window): Promise<string> {
  try {
    const text = await win.navigator?.clipboard?.readText?.()
    return typeof text === "string" ? text : ""
  } catch {
    return "" // no permission / no API — the caller's no-op stands
  }
}

export function readClipboardViaBridge(win: Window = window, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<string> {
  return new Promise<string>((resolve) => {
    // Unframed: native paste works — don't post into the void or wait out the timeout.
    if (win.parent === win) {
      resolve("")
      return
    }

    const nonce = Math.random().toString(36).slice(2)
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (text: string) => {
      win.removeEventListener("message", onMessage)
      if (timer !== undefined) clearTimeout(timer)
      if (text) {
        resolve(text)
        return
      }
      // The bridge replied (or timed out) with empty text. Only fall back to
      // navigator.clipboard.readText() on framed hosts WITHOUT the amicode relay
      // (e.g. VS Code Simple Browser) — identified by the bridge timing out
      // (no reply at all). When the bridge DID reply with empty, trust it: the
      // extension host's vscode.env.clipboard.readText() is authoritative, and
      // readTextDirect() can spuriously succeed with stale/unrelated text when
      // the iframe has transient user activation, blocking the image paste path.
      if (bridgeReplied) {
        resolve("")
        return
      }
      void readTextDirect(win).then(resolve)
    }

    let bridgeReplied = false
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; kind?: string; nonce?: string; text?: string } | undefined
      if (data?.source !== "amicode" || data.kind !== "clipboard" || data.nonce !== nonce) return
      bridgeReplied = true
      finish(typeof data.text === "string" ? data.text : "")
    }

    win.addEventListener("message", onMessage)
    win.parent.postMessage({ source: "amicode", kind: "clipboard-request", nonce }, "*")
    timer = setTimeout(() => finish(""), timeoutMs)
  })
}

// ⌘V image paste inside the Amicode chat. Unlike text (which the extension host
// reads via vscode.env.clipboard — text-only, no image API), an image can only
// come from the OUTER webview reading navigator.clipboard.read() client-side.
// So we ask the parent relay (chat_panel.ts) rather than the host: it grabs the
// first image/* clipboard item, encodes it as a data URL, and replies. We
// rebuild a File from the reply so callers reuse the normal attachment path.
// Resolves null when unframed, on a text-only clipboard, or after `timeoutMs`.
export function readClipboardImageViaBridge(win: Window = window, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    if (win.parent === win) {
      resolve(null)
      return
    }

    const nonce = Math.random().toString(36).slice(2)
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (file: File | null) => {
      win.removeEventListener("message", onMessage)
      if (timer !== undefined) clearTimeout(timer)
      resolve(file)
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { source?: string; kind?: string; nonce?: string; dataUrl?: string; mime?: string; filename?: string }
        | undefined
      if (data?.source !== "amicode" || data.kind !== "clipboard-image" || data.nonce !== nonce) return
      finish(fileFromDataUrl(data.dataUrl, data.mime, data.filename))
    }

    win.addEventListener("message", onMessage)
    win.parent.postMessage({ source: "amicode", kind: "clipboard-image-request", nonce }, "*")
    timer = setTimeout(() => finish(null), timeoutMs)
  })
}

function fileFromDataUrl(dataUrl?: string, mime?: string, filename?: string): File | null {
  if (!dataUrl || !mime) return null
  const comma = dataUrl.indexOf(",")
  if (comma === -1) return null
  try {
    const binary = atob(dataUrl.slice(comma + 1))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new File([bytes], filename || "pasted-image.png", { type: mime })
  } catch {
    return null
  }
}

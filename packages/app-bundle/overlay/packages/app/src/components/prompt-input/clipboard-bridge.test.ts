import { describe, expect, test } from "bun:test"
import { readClipboardViaBridge, writeClipboardViaBridge } from "./clipboard-bridge"

type Listener = (event: MessageEvent) => void

// A stand-in for a framed window (parent !== self) that records outgoing
// clipboard-requests and lets a test play back the host's reply. `readText`
// simulates the host's navigator.clipboard grant: a function to grant it,
// absent to model the VS Code webview iframe (no permission).
function fakeFramedWindow(readText?: () => Promise<string>) {
  const listeners = new Set<Listener>()
  const posted: Array<Record<string, unknown>> = []
  const win = {
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
    navigator: readText ? { clipboard: { readText } } : {},
    parent: {
      postMessage: (message: Record<string, unknown>) => posted.push(message),
    },
  } as unknown as Window
  return {
    win,
    posted,
    reply: (message: Record<string, unknown>) => listeners.forEach((fn) => fn({ data: message } as MessageEvent)),
    listenerCount: () => listeners.size,
  }
}

describe("readClipboardViaBridge", () => {
  test("requests the OS clipboard from the host and resolves with the reply", async () => {
    const bridge = fakeFramedWindow()
    const pending = readClipboardViaBridge(bridge.win)

    expect(bridge.posted).toHaveLength(1)
    const request = bridge.posted[0]
    expect(request.source).toBe("amicode")
    expect(request.kind).toBe("clipboard-request")
    expect(typeof request.nonce).toBe("string")

    bridge.reply({ source: "amicode", kind: "clipboard", nonce: request.nonce, text: "solve a CZ gate" })

    expect(await pending).toBe("solve a CZ gate")
    expect(bridge.listenerCount()).toBe(0) // listener cleaned up
  })

  test("ignores replies whose nonce does not match the request", async () => {
    const bridge = fakeFramedWindow()
    const pending = readClipboardViaBridge(bridge.win, 15)

    // A stale reply from an earlier request must not resolve this one.
    bridge.reply({ source: "amicode", kind: "clipboard", nonce: "someone-elses-nonce", text: "leaked" })

    expect(await pending).toBe("") // falls through to the timeout instead
  })

  test("resolves empty on a malformed reply body", async () => {
    const bridge = fakeFramedWindow()
    const pending = readClipboardViaBridge(bridge.win, 15)
    const request = bridge.posted[0]

    bridge.reply({ source: "amicode", kind: "clipboard", nonce: request.nonce }) // no text field

    expect(await pending).toBe("")
  })

  test("framed host WITHOUT the amicode relay (Simple Browser, plain embeds) falls back to navigator.clipboard", async () => {
    // No reply ever comes — the request went into the void. The API key being
    // pasted must still arrive via the host's own clipboard-read grant.
    const bridge = fakeFramedWindow(() => Promise.resolve("sk-cloud-key-123"))
    expect(await readClipboardViaBridge(bridge.win, 15)).toBe("sk-cloud-key-123")
  })

  test("a live bridge reply wins — navigator.clipboard is not consulted", async () => {
    const bridge = fakeFramedWindow(() => {
      throw new Error("must not be called when the bridge answered")
    })
    const pending = readClipboardViaBridge(bridge.win)
    const request = bridge.posted[0]
    bridge.reply({ source: "amicode", kind: "clipboard", nonce: request.nonce, text: "from the bridge" })
    expect(await pending).toBe("from the bridge")
  })

  test("no relay AND no clipboard permission resolves empty (the caller's no-op stands)", async () => {
    const bridge = fakeFramedWindow(() => Promise.reject(new Error("NotAllowedError")))
    expect(await readClipboardViaBridge(bridge.win, 15)).toBe("")
  })

  test("resolves empty without posting when the app is not framed", async () => {
    const posted: unknown[] = []
    const win = {
      addEventListener: () => {},
      removeEventListener: () => {},
      postMessage: (message: unknown) => posted.push(message),
    } as unknown as Window
    // parent === self → not inside a webview iframe
    ;(win as unknown as { parent: Window }).parent = win

    expect(await readClipboardViaBridge(win)).toBe("")
    expect(posted).toHaveLength(0)
  })
})

describe("writeClipboardViaBridge", () => {
  test("pushes the copied text to the host so the OS clipboard matches ⌘V's read", () => {
    const bridge = fakeFramedWindow()

    expect(writeClipboardViaBridge("solve a CZ gate", bridge.win)).toBe(true)
    expect(bridge.posted).toHaveLength(1)
    const message = bridge.posted[0]
    expect(message.source).toBe("amicode")
    expect(message.kind).toBe("clipboard-write")
    expect(message.text).toBe("solve a CZ gate")
  })

  test("is a no-op that posts nothing when the app is not framed", () => {
    const posted: unknown[] = []
    const win = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window
    // parent === self → plain web/desktop, where native copy already works
    ;(win as unknown as { parent: Window }).parent = win

    expect(writeClipboardViaBridge("ignored", win)).toBe(false)
    expect(posted).toHaveLength(0)
  })
})

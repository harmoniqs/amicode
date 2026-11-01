import { describe, expect, test } from "bun:test"
import { pngDataUrl, requestHostImageWrite } from "./clipboard"

type Listener = (event: MessageEvent) => void

// A stand-in for the framed chat iframe (parent !== self): records the
// outgoing clipboard-image-write and lets a test play back the host's reply.
function fakeFramedWindow() {
  const listeners = new Set<Listener>()
  const posted: Array<Record<string, unknown>> = []
  const win = {
    addEventListener: (_type: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_type: string, fn: Listener) => listeners.delete(fn),
    parent: { postMessage: (message: Record<string, unknown>) => posted.push(message) },
  } as unknown as Window
  return {
    win,
    posted,
    reply: (message: Record<string, unknown>) => listeners.forEach((fn) => fn({ data: message } as MessageEvent)),
    listenerCount: () => listeners.size,
  }
}

const PNG = "data:image/png;base64,iVBORw0KGgo="

describe("requestHostImageWrite (image copy bridge)", () => {
  test("posts a nonce'd clipboard-image-write and resolves true only on the matching ok reply", async () => {
    const bridge = fakeFramedWindow()
    let settled: boolean | undefined
    const pending = requestHostImageWrite(bridge.win, PNG).then((ok) => (settled = ok))

    expect(bridge.posted).toHaveLength(1)
    const request = bridge.posted[0]!
    expect(request).toMatchObject({ source: "amicode", kind: "clipboard-image-write", dataUrl: PNG })
    expect(typeof request.nonce).toBe("string")

    // Not "Copied" yet: nothing resolves before the host answers.
    await Promise.resolve()
    expect(settled).toBeUndefined()

    // A reply for someone else's nonce is ignored.
    bridge.reply({ source: "amicode", kind: "clipboard-image-written", nonce: "other", ok: true })
    await Promise.resolve()
    expect(settled).toBeUndefined()

    bridge.reply({ source: "amicode", kind: "clipboard-image-written", nonce: request.nonce, ok: true })
    expect(await pending).toBe(true)
    expect(bridge.listenerCount()).toBe(0)
  })

  test("a host-side failure (ok: false) resolves false", async () => {
    const bridge = fakeFramedWindow()
    const pending = requestHostImageWrite(bridge.win, PNG)
    bridge.reply({ source: "amicode", kind: "clipboard-image-written", nonce: bridge.posted[0]!.nonce, ok: false })
    expect(await pending).toBe(false)
  })

  test("no reply within the timeout resolves false and detaches the listener", async () => {
    const bridge = fakeFramedWindow()
    expect(await requestHostImageWrite(bridge.win, PNG, 20)).toBe(false)
    expect(bridge.listenerCount()).toBe(0)
  })
})

describe("pngDataUrl", () => {
  test("a PNG data URL passes straight through", async () => {
    expect(await pngDataUrl(PNG)).toBe(PNG)
  })

  test("a tainted canvas (cross-origin image) is a failed copy, not a throw", async () => {
    const OriginalImage = globalThis.Image
    const originalCreate = document.createElement.bind(document)
    class LoadedImage {
      src = ""
      naturalWidth = 4
      naturalHeight = 4
      decode() {
        return Promise.resolve()
      }
    }
    ;(globalThis as { Image: unknown }).Image = LoadedImage
    ;(document as { createElement: unknown }).createElement = (tag: string) => {
      if (tag !== "canvas") return originalCreate(tag)
      return {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: () => {} }),
        toDataURL: () => {
          throw new DOMException("Tainted canvases may not be exported.", "SecurityError")
        },
      }
    }
    try {
      expect(await pngDataUrl("https://elsewhere.example/plot.jpg")).toBeUndefined()
    } finally {
      ;(globalThis as { Image: unknown }).Image = OriginalImage
      ;(document as { createElement: unknown }).createElement = originalCreate
    }
  })
})

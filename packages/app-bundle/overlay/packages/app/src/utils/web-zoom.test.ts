import { describe, expect, test } from "bun:test"
import { webZoom, webZoomIn, webZoomOut, webZoomReset } from "./web-zoom"

// Zoom routing (amicode#266): ONE zoom owner — the app document itself. The
// workbench can never see keydowns from inside the webview documents
// (cross-origin iframe), so there is no bridge, no "framed" branch, and no
// host interception to route around: webZoomIn/Out/Reset always apply the
// in-app CSS zoom, and the module-scope capture listener (registered on
// import, below) applies it from the raw chords in every document that loads
// the bundle — the main frame and each split pane.

describe("web-zoom signal (amicode#266)", () => {
  test("zoom in/out/reset always move the in-app signal", () => {
    const before = webZoom()
    webZoomIn()
    expect(webZoom()).toBe(Math.round((before + 0.1) * 100) / 100)
    webZoomOut()
    expect(webZoom()).toBe(Math.round(before * 100) / 100)
    webZoomReset()
    expect(webZoom()).toBe(1)
  })

  test("the raw chord listener is registered on the document", () => {
    webZoomReset()
    const fired = new KeyboardEvent("keydown", { key: "=", ctrlKey: true, cancelable: true })
    document.dispatchEvent(fired)
    expect(fired.defaultPrevented).toBe(true)
    expect(webZoom()).toBe(1.1)
  })
})

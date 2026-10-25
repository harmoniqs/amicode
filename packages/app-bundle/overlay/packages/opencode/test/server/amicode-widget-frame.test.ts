import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { WIDGET_CSP, buildFrameHtml, embedCode, widgetFrameHtml } from "../../src/server/amicode/widget-frame-html"

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  delete process.env.AMICODE_WIDGETS_DIR
})

describe("buildFrameHtml", () => {
  const doc = buildFrameHtml("export default { mount() {} }")

  test("carries the exact normative CSP (meta mirrors the response header)", () => {
    expect(WIDGET_CSP).toBe(
      "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src https: data:",
    )
    expect(WIDGET_CSP).not.toContain("unsafe-eval")
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">`)
  })

  test("baked tokens on :root, runtime + code present", () => {
    expect(doc).toContain("--amc-bg: #0B0E15;")
    expect(doc).toContain("amc:init") // runtime marker
    expect(doc).toContain("__amcWidgetCode")
  })

  test("accent defaults to the current brand yellow, never the retired #FFF676", () => {
    expect(doc).toContain("--amc-accent: #FFE614;")
    expect(doc).toContain("--amc-accent-fill: #FFE614;")
    expect(doc.toUpperCase()).not.toContain("#FFF676")
  })

  test("</script> in widget code cannot break out", () => {
    const hostile = buildFrameHtml('var x = "</script><script>alert(1)"')
    expect(hostile).not.toContain('alert(1)"</script>')
    expect(embedCode("</script>")).not.toContain("</script>")
  })
})

describe("widgetFrameHtml", () => {
  test("serves a frame for a registered widget; bad/unknown ids get inert documents", () => {
    dir = mkdtempSync(path.join(tmpdir(), "amc-frame-"))
    process.env.AMICODE_WIDGETS_DIR = dir
    // #1818: no built-ins ship — seed a user widget as the frame fixture.
    mkdirSync(path.join(dir, "my-widget"), { recursive: true })
    writeFileSync(path.join(dir, "my-widget", "manifest.toml"), 'id = "my-widget"\nname = "Mine"')
    writeFileSync(path.join(dir, "my-widget", "widget.js"), "export default { mount() {} }")
    const ok = widgetFrameHtml("my-widget")
    expect(ok.ok).toBe(true)
    expect(ok.html).toContain("__amcWidgetCode")
    expect(widgetFrameHtml("../etc").ok).toBe(false)
    expect(widgetFrameHtml("ghost-widget").ok).toBe(false)
    expect(widgetFrameHtml(undefined).ok).toBe(false)
  })
})

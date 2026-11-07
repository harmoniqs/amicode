import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  authorWidget,
  forkManifestToml,
  forkWidgetResponse,
  loadRegistry,
  widgetCodeResponse,
  widgetsResponse,
} from "../../src/server/amicode/widgets"

let dir: string | undefined
const userDir = () => {
  dir = mkdtempSync(path.join(tmpdir(), "amc-widgets-reg-"))
  process.env.AMICODE_WIDGETS_DIR = dir
  return dir
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  delete process.env.AMICODE_WIDGETS_DIR
})

describe("loadRegistry", () => {
  test("ships no built-in widgets (#1818: the jump-back-in tile's feed was removed)", () => {
    userDir()
    const { widgets, warnings } = loadRegistry()
    expect(widgets).toEqual([])
    expect(widgets.every((w) => !w.builtin)).toBe(true)
    expect(warnings).toEqual([])
  })

  test("a user widget appears in the registry", () => {
    const root = userDir()
    mkdirSync(path.join(root, "my-widget"))
    writeFileSync(path.join(root, "my-widget", "manifest.toml"), 'id = "my-widget"\nname = "Mine"')
    writeFileSync(path.join(root, "my-widget", "widget.js"), "export default { mount() {} }")

    const { widgets, warnings } = loadRegistry()
    const mine = widgets.find((w) => w.manifest.id === "my-widget")!
    expect(mine.builtin).toBe(false)
    expect(mine.path).toContain("my-widget")
    expect(warnings).toEqual([])
    // hashes are stable across loads
    const again = loadRegistry()
    expect(again.widgets.map((w) => w.hash)).toEqual(widgets.map((w) => w.hash))
  })

  test("bad user manifest → warning, widget skipped", () => {
    const root = userDir()
    mkdirSync(path.join(root, "broken"))
    writeFileSync(path.join(root, "broken", "manifest.toml"), 'id = "mismatch"\nname = "X"')
    writeFileSync(path.join(root, "broken", "widget.js"), "export default { mount() {} }")
    const { widgets, warnings } = loadRegistry()
    expect(widgets.some((w) => w.manifest.id === "mismatch")).toBe(false)
    expect(warnings.some((w) => w.id === "broken")).toBe(true)
  })
})

describe("widget routes", () => {
  test("widgetsResponse carries manifests + hash; widgetCodeResponse serves code", () => {
    userDir()
    authorWidget({ id: "recent-runs", name: "Recent Runs", size: "hero", height: 220, js: "export default { mount() {} }" })
    const list = JSON.parse(widgetsResponse())
    expect(list.ok).toBe(true)
    expect(list.widgets).toHaveLength(1)
    expect(list.widgets[0].hash).toMatch(/^[0-9a-f]{16}$/)

    const code = JSON.parse(widgetCodeResponse("recent-runs"))
    expect(code.ok).toBe(true)
    expect(code.code).toContain("mount")
    expect(code.hash).toBe(list.widgets[0].hash)
  })

  test("bad ids rejected without throwing", () => {
    userDir()
    expect(JSON.parse(widgetCodeResponse("../etc/passwd")).ok).toBe(false)
    expect(JSON.parse(widgetCodeResponse(undefined)).ok).toBe(false)
    expect(JSON.parse(widgetCodeResponse("nope-widget")).ok).toBe(false)
  })

  test("fork copies a user widget, rewrites id, appends origin; forked widget is valid in registry", () => {
    const root = userDir()
    authorWidget({
      id: "source-widget",
      name: "Source",
      size: "tile",
      height: 120,
      js: "export default { mount() {} }",
    })
    const r = JSON.parse(
      forkWidgetResponse(JSON.stringify({ id: "source-widget", new_id: "my-fork", session: "s1" })),
    )
    expect(r.ok).toBe(true)
    expect(r.id).toBe("my-fork")
    expect(existsSync(path.join(root, "my-fork", "widget.js"))).toBe(true)
    const manifest = readFileSync(path.join(root, "my-fork", "manifest.toml"), "utf8")
    expect(manifest).toContain('id = "my-fork"')
    expect(manifest).toContain("[origin]")
    expect(manifest).toContain('session = "s1"')

    const { widgets, warnings } = loadRegistry()
    const forked = widgets.find((w) => w.manifest.id === "my-fork")!
    expect(forked.builtin).toBe(false)
    expect(forked.manifest.origin?.session).toBe("s1")
    expect(warnings).toEqual([])
  })

  test("fork errors: unknown source, existing target, bad body", () => {
    userDir()
    authorWidget({
      id: "source-widget",
      name: "Source",
      size: "tile",
      height: 120,
      js: "export default { mount() {} }",
    })
    expect(JSON.parse(forkWidgetResponse(JSON.stringify({ id: "ghost" }))).ok).toBe(false)
    expect(JSON.parse(forkWidgetResponse(JSON.stringify({ id: "source-widget", new_id: "source-widget" }))).ok).toBe(
      false,
    )
    expect(JSON.parse(forkWidgetResponse("not json")).ok).toBe(false)
  })

  test("forkManifestToml rewrites only the id line", () => {
    const out = forkManifestToml('id = "a"\nname = "A"\nheight = 96', "b", undefined)
    expect(out).toContain('id = "b"')
    expect(out).toContain('name = "A"')
    expect(out).toContain("[origin]")
  })
})

describe("authorWidget (Stage 2 chat authoring)", () => {
  const validJs = "export default { mount: function (el, amico) { el.innerHTML = 'hi' } }"

  test("writes a user widget the registry then loads, returns a hash", () => {
    userDir()
    const r = authorWidget({ id: "recent-runs", name: "Recent Runs", size: "hero", height: 220, js: validJs })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.id).toBe("recent-runs")
    expect(r.size).toBe("hero")
    expect(r.height).toBe(220)
    expect(r.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(existsSync(path.join(dir!, "recent-runs", "manifest.toml"))).toBe(true)
    expect(existsSync(path.join(dir!, "recent-runs", "widget.js"))).toBe(true)
    const { widgets } = loadRegistry()
    const w = widgets.find((x) => x.manifest.id === "recent-runs")
    expect(w?.manifest.name).toBe("Recent Runs")
    expect(w?.builtin).toBe(false)
  })

  test("re-authoring the same id overwrites and changes the hash (hot-reload)", () => {
    userDir()
    const first = authorWidget({ id: "records", name: "Records", size: "tile", height: 160, js: validJs })
    const second = authorWidget({
      id: "records",
      name: "Records",
      size: "tile",
      height: 160,
      js: validJs.replace("hi", "bye"),
    })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.hash).not.toBe(first.hash)
    expect(readFileSync(path.join(dir!, "records", "widget.js"), "utf8")).toContain("bye")
  })

  test("names with quotes/punctuation round-trip through the manifest", () => {
    userDir()
    const r = authorWidget({
      id: "coverage-map",
      name: 'Coverage "Map" (β)',
      size: "tile",
      height: 140,
      description: "platform x gate",
      js: validJs,
    })
    expect(r.ok).toBe(true)
    const { widgets, warnings } = loadRegistry()
    expect(warnings.find((w) => w.id === "coverage-map")).toBeUndefined()
    expect(widgets.find((x) => x.manifest.id === "coverage-map")?.manifest.name).toBe('Coverage "Map" (β)')
  })

  test("sticky: true writes the manifest flag; it reaches the registry and the widget wire (#1856)", () => {
    userDir()
    const r = authorWidget({ id: "live-solve", name: "Live solve", size: "hero", height: 220, sticky: true, js: validJs })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sticky).toBe(true)
    expect(readFileSync(path.join(dir!, "live-solve", "manifest.toml"), "utf8")).toContain("sticky = true")
    expect(loadRegistry().widgets.find((x) => x.manifest.id === "live-solve")?.manifest.sticky).toBe(true)
    expect(JSON.parse(widgetsResponse()).widgets[0].sticky).toBe(true)
  })

  test("sticky omitted (or non-boolean) writes no flag and the widget is non-sticky (#1856)", () => {
    userDir()
    const plain = authorWidget({ id: "plain", name: "Plain", size: "tile", height: 120, js: validJs })
    const odd = authorWidget({ id: "odd", name: "Odd", size: "tile", height: 120, sticky: "yes", js: validJs })
    expect(plain.ok && odd.ok).toBe(true)
    if (!plain.ok || !odd.ok) return
    expect(plain.sticky).toBe(false)
    expect(odd.sticky).toBe(false)
    expect(readFileSync(path.join(dir!, "plain", "manifest.toml"), "utf8")).not.toContain("sticky")
    expect(readFileSync(path.join(dir!, "odd", "manifest.toml"), "utf8")).not.toContain("sticky")
    expect(JSON.parse(widgetsResponse()).widgets.every((w: { sticky: boolean }) => w.sticky === false)).toBe(true)
  })

  test("rejects bad input without writing", () => {
    userDir()
    expect(authorWidget({ id: "Bad_Id", name: "x", size: "tile", height: 100, js: validJs }).ok).toBe(false)
    expect(authorWidget({ id: "ok", name: "", size: "tile", height: 100, js: validJs }).ok).toBe(false)
    expect(authorWidget({ id: "ok", name: "x", size: "big", height: 100, js: validJs }).ok).toBe(false)
    expect(authorWidget({ id: "ok", name: "x", size: "tile", height: 5, js: validJs }).ok).toBe(false)
    expect(authorWidget({ id: "ok", name: "x", size: "tile", height: 100, js: "" }).ok).toBe(false)
    expect(authorWidget({ id: "ok", name: "x", size: "tile", height: 100, js: "export default {}" }).ok).toBe(false)
    expect(existsSync(path.join(dir!, "ok"))).toBe(false)
  })
})

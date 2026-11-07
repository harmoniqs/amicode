import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { revealInSidebarMessage } from "./preview-file-target"

// #1036: the Preview tab's "Find in sidebar" posts a DEDICATED `reveal-in-sidebar`
// message (the `command` bridge lane forwards no arguments) carrying the tab's path.

const previewTab = readFileSync(join(import.meta.dir, "session-preview-tab.tsx"), "utf8")

describe("revealInSidebarMessage", () => {
  test("carries the file path on a dedicated message kind", () => {
    expect(revealInSidebarMessage("/w/p/a.md")).toEqual({ source: "amicode", kind: "reveal-in-sidebar", path: "/w/p/a.md" })
  })

  test("an empty path yields no message (the menu item is disabled)", () => {
    expect(revealInSidebarMessage("")).toBeUndefined()
    expect(revealInSidebarMessage(undefined)).toBeUndefined()
  })
})

describe("Preview tab context menu", () => {
  const menu = previewTab.slice(previewTab.indexOf("<MenuV2.Content"))

  test("Find in sidebar is the FIRST item, separated from the copy items by a divider", () => {
    const find = menu.indexOf("Find in sidebar")
    const separator = menu.indexOf("<MenuV2.Separator")
    const copyName = menu.indexOf("Copy filename")
    const copyPath = menu.indexOf("Copy filepath")
    expect(find).toBeGreaterThan(-1)
    expect(find).toBeLessThan(separator)
    expect(separator).toBeLessThan(copyName)
    expect(copyName).toBeLessThan(copyPath)
  })

  test("it posts the dedicated message to the host and is disabled without a path", () => {
    expect(previewTab).toContain("revealInSidebarMessage(")
    expect(previewTab).toMatch(/window\.parent\?*\.postMessage\(message, "\*"\)/)
    expect(menu).toMatch(/disabled=\{!tabContextMenu\(\)\?\.path\}/)
  })
})

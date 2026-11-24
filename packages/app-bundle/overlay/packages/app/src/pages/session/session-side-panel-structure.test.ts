import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#105 structural ACs, locked against resurrection on the next upstream
// merge (this file is merge-hot — the ADR names these deletions deliberately):
//   store_mirror_effects == 0  — no createEffect mirrors between the global
//                                vaultPanel store and the per-session reviewPanel
//   vault_sidepanel_hosts == 0 — the vault's only host is the global drawer;
//                                the side-panel tab is retired
// Behavioral consequence: the sidebar-right toggle's store has a single writer,
// so its pressed state cannot disagree with the screen.
const source = readFileSync(join(import.meta.dir, "session-side-panel.tsx"), "utf8")

describe("work column is vault-free (amicode#105)", () => {
  test("no vaultPanel store references (no mirror effects, no vault tab logic)", () => {
    expect(source).not.toContain("vaultPanel")
  })

  test("no vault tab trigger or content", () => {
    expect(source).not.toContain('value="vault"')
    expect(source).not.toContain("vaultOpen")
  })

  test("persists and sorts only the named surface tabs", () => {
    expect(source).toContain("layout.sidePanelTabs.order()")
    expect(source).toContain("SortableSidePanelSurfaceTab")
    expect(source).toContain("handleSurfaceTabDragEnd")
  })
})

// amicode#2188: wide mode must widen the side panel itself, not just its work
// column container. The <aside> fills the widened column ("100%") and its own
// resize handle is hidden (dragging it would only change the stored pixel
// width, which is ignored while wide). Outside wide mode the stored pixel width
// and a working handle stay as before.
describe("wide mode fills the work column (amicode#2188)", () => {
  const panelWidthBody = source.slice(
    source.indexOf("const panelWidth = createMemo("),
    source.indexOf("const treeWidth = createMemo("),
  )

  test("panelWidth returns 100% while wide and the panel is open", () => {
    const wideIdx = panelWidthBody.indexOf('if (props.isWide?.()) return "100%"')
    expect(wideIdx).toBeGreaterThan(-1)
    // the closed guard still wins, and wide takes precedence over the stored width
    expect(panelWidthBody.indexOf('if (!open()) return "0px"')).toBeLessThan(wideIdx)
    expect(wideIdx).toBeLessThan(panelWidthBody.indexOf("floorPanelColumnWidth(layout.panelColumn.width())"))
  })

  test("outside wide mode the stored pixel width is still applied", () => {
    expect(panelWidthBody).toContain("return `${floorPanelColumnWidth(layout.panelColumn.width())}px`")
    expect(source).toContain("style={{ width: panelWidth() }}")
  })

  test("the aside's resize handle is hidden while wide", () => {
    const asideHandle = source.slice(source.indexOf("style={{ width: panelWidth() }}"))
    const showIdx = asideHandle.indexOf("<Show when={tabsOpen() && !props.isWide?.()}>")
    expect(showIdx).toBeGreaterThan(-1)
    expect(showIdx).toBeLessThan(asideHandle.indexOf("<ResizeHandle"))
    expect(asideHandle.indexOf("layout.panelColumn.resize(width)")).toBeGreaterThan(showIdx)
  })
})

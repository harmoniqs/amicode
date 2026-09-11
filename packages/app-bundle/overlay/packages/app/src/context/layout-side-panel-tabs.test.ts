import { describe, expect, test } from "bun:test"
import {
  DEFAULT_SIDE_PANEL_TAB_ORDER,
  normalizeSidePanelTabOrder,
  reorderSidePanelTabs,
} from "./layout-side-panel-tabs"

describe("side panel tab order", () => {
  test("normalizes persisted orders without dropping named surfaces", () => {
    expect(normalizeSidePanelTabOrder(["preview", "context", "preview", "unknown"])).toEqual([
      "home",
      "preview",
      "context",
      "review",
      "pulseInspector",
    ])
  })

  test("keeps Home first when a surface is moved before it", () => {
    expect(reorderSidePanelTabs(DEFAULT_SIDE_PANEL_TAB_ORDER, "preview", 0)).toEqual([
      "home",
      "preview",
      "review",
      "context",
      "pulseInspector",
    ])
  })

  test("does not move Home", () => {
    expect(reorderSidePanelTabs(DEFAULT_SIDE_PANEL_TAB_ORDER, "home", 4)).toEqual(DEFAULT_SIDE_PANEL_TAB_ORDER)
  })
})

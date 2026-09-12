import { describe, expect, test } from "bun:test"
import {
  GLOBAL_STATUS_DEFAULT_TAB,
  GLOBAL_STATUS_TABS,
  statusPopoverLayout,
  statusTriggerVisibility,
} from "./status-popover-model"

describe("statusTriggerVisibility", () => {
  // amicode#174 AC2: the status trigger is the only per-session entry to the
  // global Connections surface — it must render whenever a session is open,
  // independent of the "Server status" desktop setting.
  test("trigger always renders, regardless of the show-status setting", () => {
    expect(statusTriggerVisibility({ desktopV2: true, showStatus: false }).trigger).toBe(true)
    expect(statusTriggerVisibility({ desktopV2: true, showStatus: true }).trigger).toBe(true)
    expect(statusTriggerVisibility({ desktopV2: false, showStatus: false }).trigger).toBe(true)
    expect(statusTriggerVisibility({ desktopV2: false, showStatus: true }).trigger).toBe(true)
  })

  test("on desktop v2 the health dot follows the show-status setting", () => {
    expect(statusTriggerVisibility({ desktopV2: true, showStatus: false }).healthDot).toBe(false)
    expect(statusTriggerVisibility({ desktopV2: true, showStatus: true }).healthDot).toBe(true)
  })

  test("off desktop v2 the health dot always renders (setting is desktop-only)", () => {
    expect(statusTriggerVisibility({ desktopV2: false, showStatus: false }).healthDot).toBe(true)
    expect(statusTriggerVisibility({ desktopV2: false, showStatus: true }).healthDot).toBe(true)
  })
})

describe("global status surface (home chrome entry)", () => {
  // amicode#202: vaults moved to the native Armonia sidebar panel, so the
  // home-chrome entry hosts Connections only (was vaults + connections in
  // #174). The per-directory tabs (mcp/lsp/plugins) are NOT part of the global
  // surface — home has no directory-scoped sync context.
  test("global surface hosts connections only (vaults moved to the sidebar)", () => {
    expect([...GLOBAL_STATUS_TABS]).toEqual(["connections"])
    expect([...GLOBAL_STATUS_TABS]).not.toContain("vaults")
  })

  test("connections is the pre-selected tab", () => {
    expect(GLOBAL_STATUS_DEFAULT_TAB).toBe("connections")
    expect(GLOBAL_STATUS_TABS).toContain(GLOBAL_STATUS_DEFAULT_TAB)
  })
})

describe("status popover layout (amicode#105)", () => {
  // AC popover_magic_shift == 0: the popover anchors bottom-end with standard
  // collision handling — the shift={-168} magic offset is deleted and must
  // never come back (it positioned the panel by guesswork and clipped off-anchor).
  test("anchors bottom-end with the standard gutter", () => {
    const layout = statusPopoverLayout()
    expect(layout.placement).toBe("bottom-end")
    expect(layout.gutter).toBe(4)
  })

  test("carries NO hardcoded shift", () => {
    expect("shift" in statusPopoverLayout()).toBe(false)
  })
})

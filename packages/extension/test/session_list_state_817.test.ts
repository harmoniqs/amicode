// Issue #817 — D2 (spec spec-20260905-045114-session-device-lifecycle): honest
// client states and the in-product panel-state reset scope, ported from the
// held fork reference (harmoniqs/opencode#296) onto the app overlay at
// canonical v1.18.29. Pure and vscode/solid-free so it unit-tests headless
// (the consumers wire it to the sync stores).
import { describe, expect, test } from "vitest"
import { classifyResetTarget, panelResetTouches, sessionListState } from "../../app-bundle/overlay/packages/app/src/utils/session-list-state"

describe("sessionListState (D2: honest states)", () => {
  test("renders 'not yet fetched' while the list fetch is in flight", () => {
    expect(sessionListState({ fetched: false, count: 0 })).toBe("unfetched")
  })

  test("renders 'genuinely empty' only once a fetch has completed", () => {
    expect(sessionListState({ fetched: true, count: 0 })).toBe("empty")
  })

  test("a populated list is ready regardless of fetch bookkeeping", () => {
    expect(sessionListState({ fetched: false, count: 3 })).toBe("ready")
    expect(sessionListState({ fetched: true, count: 3 })).toBe("ready")
  })

  test("a search never shows the unfetched state (results are filtered, not loading)", () => {
    expect(sessionListState({ fetched: false, count: 0, searching: true })).toBe("empty")
  })

  test("home contract: the index query's success is the fetched source", () => {
    // Boot: the home session-index query is pending and has never succeeded.
    expect(sessionListState({ fetched: false, count: 0 })).toBe("unfetched")
    // After the first successful fetch (even a refetch with data present),
    // an empty projection is genuinely empty.
    expect(sessionListState({ fetched: true, count: 0 })).toBe("empty")
  })
})

describe("panel reset scope (D2: clears session caches only)", () => {
  test("session-scoped cache keys are cleared", () => {
    expect(classifyResetTarget("session:ses_1:layout")).toBe("session-cache")
    expect(classifyResetTarget("session:ses_1:comments")).toBe("session-cache")
  })

  test("workspace preferences survive the reset", () => {
    expect(classifyResetTarget("workspace:settings")).toBe("workspace-pref")
    expect(classifyResetTarget("workspace:vcs")).toBe("workspace-pref")
    expect(classifyResetTarget("workspace:project")).toBe("workspace-pref")
    expect(classifyResetTarget("settings.v3")).toBe("workspace-pref")
  })

  test("user drafts are never destroyed by a reset", () => {
    expect(classifyResetTarget("session:ses_1:prompt", { draft: true })).toBe("workspace-pref")
  })

  test("the reset's touch-list holds only session caches, never workspace preferences", () => {
    const touches = panelResetTouches()
    expect(touches).toContain("session")
    for (const pref of ["workspace:settings", "workspace:vcs", "workspace:project", "settings.v3", "workspace:archive-cutoff"]) {
      expect(touches).not.toContain(pref)
    }
    for (const touch of touches) {
      expect(classifyResetTarget(`session:x:${touch}`)).toBe("session-cache")
    }
  })
})

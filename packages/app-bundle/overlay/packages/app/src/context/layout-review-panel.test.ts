import { describe, expect, test } from "bun:test"
import { createStore } from "solid-js/store"
import { createSessionReviewPanel, type SessionReviewPanelView } from "./layout-review-panel"

const setup = (initial: Record<string, SessionReviewPanelView> = {}) => {
  const [store, setStore] = createStore({ sessionView: initial })
  const panel = createSessionReviewPanel({
    views: () => store.sessionView,
    write: (session, opened) => {
      if (!store.sessionView[session]) {
        setStore("sessionView", session, { scroll: {}, reviewPanelOpened: opened })
        return
      }
      setStore("sessionView", session, "reviewPanelOpened", opened)
    },
  })
  return { store, panel }
}

describe("per-session review panel (#1966)", () => {
  test("opening session A's panel leaves session B closed, and A stays open", () => {
    const { panel } = setup()

    panel.set("A", true, "other")

    expect(panel.opened("A")).toBe(true)
    expect(panel.opened("B")).toBe(false)
    expect(panel.opened("A")).toBe(true)
  })

  test("a session that never set its panel is closed even after another session closed and reopened", () => {
    const { panel } = setup()

    panel.set("A", true, "other")
    panel.set("B", false, "other")
    panel.set("A", true, "other")

    expect(panel.opened("A")).toBe(true)
    expect(panel.opened("B")).toBe(false)
    expect(panel.opened("C")).toBe(false)
  })

  test("closing session B does not close session A", () => {
    const { panel } = setup()

    panel.set("A", true, "other")
    panel.set("B", true, "other")
    panel.set("B", false, "other")

    expect(panel.opened("A")).toBe(true)
    expect(panel.opened("B")).toBe(false)
  })

  test("open state survives a reload-style re-read of persisted sessionView", () => {
    const first = setup()
    first.panel.set("A", true, "other")

    const persisted = JSON.parse(JSON.stringify(first.store.sessionView))
    const reloaded = setup(persisted)

    expect(reloaded.panel.opened("A")).toBe(true)
    expect(reloaded.panel.opened("B")).toBe(false)
  })

  test("the open source stays with the session that opened the panel", () => {
    const { panel } = setup()

    panel.set("A", true, "context-button")

    expect(panel.source("A")).toBe("context-button")
    expect(panel.source("B")).toBe("other")

    panel.set("B", true, "other")
    expect(panel.source("A")).toBe("context-button")
    expect(panel.source("B")).toBe("other")

    panel.set("A", false, "other")
    expect(panel.source("A")).toBe("other")
  })

  test("a persisted open panel reads source 'other' after reload (source is ephemeral)", () => {
    const { panel } = setup({ A: { scroll: {}, reviewPanelOpened: true } })
    expect(panel.opened("A")).toBe(true)
    expect(panel.source("A")).toBe("other")
  })
})

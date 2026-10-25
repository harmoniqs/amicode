import { describe, expect, test } from "bun:test"
import { DOCK_STRIP_HEIGHT, dockDensity, dockedKey, slotAboveRoot, type DockCandidate } from "./widget-dock"

const card = (key: string, over: Partial<DockCandidate> = {}): DockCandidate => ({
  key,
  sticky: true,
  hidden: false,
  empty: false,
  outOfView: true,
  ...over,
})

describe("dockedKey (#1856)", () => {
  test("a sticky card scrolled out of view docks; back in view it undocks", () => {
    expect(dockedKey({ enabled: true, mode: undefined, entries: [card("live")] })).toBe("live")
    expect(dockedKey({ enabled: true, mode: undefined, entries: [card("live", { outOfView: false })] })).toBeUndefined()
  })

  test("one docked at most: with two sticky cards out of view, the most recently pinned (last) wins", () => {
    const entries = [card("older"), card("plain", { sticky: false }), card("newer")]
    expect(dockedKey({ enabled: true, mode: undefined, entries })).toBe("newer")
  })

  test("the newer sticky card still in view leaves the out-of-view older one as the only candidate", () => {
    const entries = [card("older"), card("newer", { outOfView: false })]
    expect(dockedKey({ enabled: true, mode: undefined, entries })).toBe("older")
  })

  test("hidden and empty-state widgets never dock (the next eligible one may)", () => {
    expect(dockedKey({ enabled: true, mode: undefined, entries: [card("h", { hidden: true })] })).toBeUndefined()
    expect(dockedKey({ enabled: true, mode: undefined, entries: [card("e", { empty: true })] })).toBeUndefined()
    const entries = [card("ok"), card("h", { hidden: true }), card("e", { empty: true })]
    expect(dockedKey({ enabled: true, mode: undefined, entries })).toBe("ok")
  })

  test("move and add modes never dock", () => {
    expect(dockedKey({ enabled: true, mode: "move", entries: [card("live")] })).toBeUndefined()
    expect(dockedKey({ enabled: true, mode: "add", entries: [card("live")] })).toBeUndefined()
  })

  test("non-sticky widgets, empty dashboards, and non-home surfaces never dock", () => {
    expect(dockedKey({ enabled: true, mode: undefined, entries: [card("a", { sticky: false })] })).toBeUndefined()
    expect(dockedKey({ enabled: true, mode: undefined, entries: [] })).toBeUndefined()
    expect(dockedKey({ enabled: false, mode: undefined, entries: [card("live")] })).toBeUndefined()
  })
})

describe("dockDensity (#1856)", () => {
  test("docked → tight; undocked → the host density it had before", () => {
    expect(dockDensity("normal", true)).toBe("tight")
    expect(dockDensity("compact", true)).toBe("tight")
    expect(dockDensity("normal", false)).toBe("normal")
    expect(dockDensity("compact", false)).toBe("compact")
  })

  test("the docked strip is ~64px", () => {
    expect(DOCK_STRIP_HEIGHT).toBe(64)
  })
})

describe("slotAboveRoot (#1856)", () => {
  const root = { top: 40 }
  test("scrolled past (slot bottom above the root top) → out of view", () => {
    expect(slotAboveRoot({ isIntersecting: false, boundingClientRect: { bottom: 12 }, rootBounds: root })).toBe(true)
  })
  test("still intersecting → in view", () => {
    expect(slotAboveRoot({ isIntersecting: true, boundingClientRect: { bottom: 80 }, rootBounds: root })).toBe(false)
  })
  test("below the fold (not yet reached) is not out of view — the strip only follows a scroll past", () => {
    expect(slotAboveRoot({ isIntersecting: false, boundingClientRect: { bottom: 2000 }, rootBounds: root })).toBe(false)
  })
  test("no rootBounds → the viewport top (0)", () => {
    expect(slotAboveRoot({ isIntersecting: false, boundingClientRect: { bottom: -5 }, rootBounds: null })).toBe(true)
  })
})

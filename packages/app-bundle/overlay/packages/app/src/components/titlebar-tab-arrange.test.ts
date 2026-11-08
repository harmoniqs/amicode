import { describe, expect, test } from "bun:test"
import {
  arrangeTabs,
  closeFinishedKeys,
  closeGroupKeys,
  closeOtherKeys,
  closeRightKeys,
  filterTabList,
  readSpawnedBy,
  type ArrangedTab,
} from "./titlebar-tab-arrange"

const keys = (arranged: ArrangedTab[]) => arranged.map((tab) => tab.key)

describe("arrangeTabs", () => {
  test("keeps the stored order when nothing is pinned or spawned", () => {
    const arranged = arrangeTabs([{ key: "a" }, { key: "b" }, { key: "c" }])
    expect(keys(arranged)).toEqual(["a", "b", "c"])
    expect(arranged.every((tab) => tab.depth === 0 && tab.group === undefined)).toBe(true)
  })

  test("pinned tabs come first, in their stored order", () => {
    const arranged = arrangeTabs([{ key: "a" }, { key: "p1", pinned: true }, { key: "b" }, { key: "p2", pinned: true }])
    expect(keys(arranged)).toEqual(["p1", "p2", "a", "b"])
    expect(arranged.slice(0, 2).every((tab) => tab.pinned)).toBe(true)
  })

  test("a spawned tab sits right after its parent, siblings in stored order", () => {
    const arranged = arrangeTabs([
      { key: "c1", parentKey: "p" },
      { key: "x" },
      { key: "p" },
      { key: "y" },
      { key: "c2", parentKey: "p" },
    ])
    expect(keys(arranged)).toEqual(["x", "p", "c1", "c2", "y"])
    const group = arranged.filter((tab) => tab.group === "p")
    expect(group.map((tab) => [tab.key, tab.depth, tab.groupEdge])).toEqual([
      ["p", 0, "start"],
      ["c1", 1, "middle"],
      ["c2", 1, "end"],
    ])
  })

  test("grandchildren group under the top-most open ancestor", () => {
    const arranged = arrangeTabs([{ key: "g", parentKey: "c" }, { key: "p" }, { key: "c", parentKey: "p" }])
    expect(keys(arranged)).toEqual(["p", "g", "c"])
    expect(arranged.every((tab) => tab.group === "p")).toBe(true)
  })

  test("a child whose parent tab is not open stands alone", () => {
    const arranged = arrangeTabs([{ key: "a" }, { key: "c", parentKey: "gone" }])
    expect(keys(arranged)).toEqual(["a", "c"])
    expect([arranged[1].depth, arranged[1].group]).toEqual([0, undefined])
  })

  test("pinning beats grouping: a pinned child or a pinned parent breaks the group", () => {
    const pinnedChild = arrangeTabs([{ key: "p" }, { key: "c", parentKey: "p", pinned: true }])
    expect(keys(pinnedChild)).toEqual(["c", "p"])
    expect(pinnedChild.every((tab) => tab.group === undefined)).toBe(true)

    const pinnedParent = arrangeTabs([{ key: "c", parentKey: "p" }, { key: "p", pinned: true }])
    expect(keys(pinnedParent)).toEqual(["p", "c"])
    expect([pinnedParent[1].depth, pinnedParent[1].group]).toEqual([0, undefined])
  })

  test("a parent cycle does not loop", () => {
    const arranged = arrangeTabs([
      { key: "a", parentKey: "b" },
      { key: "b", parentKey: "a" },
    ])
    expect(keys(arranged).sort()).toEqual(["a", "b"])
  })
})

describe("bulk-close selectors", () => {
  const arranged = arrangeTabs([
    { key: "pin", pinned: true },
    { key: "a" },
    { key: "p" },
    { key: "c", parentKey: "p" },
    { key: "draft" },
    { key: "z" },
  ])

  test("close others keeps the anchor and every pinned tab", () => {
    expect(closeOtherKeys(arranged, "p")).toEqual(["a", "c", "draft", "z"])
  })

  test("close to the right follows the displayed order and skips pinned tabs", () => {
    expect(closeRightKeys(arranged, "p")).toEqual(["c", "draft", "z"])
    expect(closeRightKeys(arranged, "pin")).toEqual(["a", "p", "c", "draft", "z"])
    expect(closeRightKeys(arranged, "z")).toEqual([])
  })

  test("close finished only takes seen, idle session tabs that are not active or pinned", () => {
    const status = { pin: "idle", a: "idle", p: "running", c: "attention", z: "idle" } as const
    expect(closeFinishedKeys(arranged, (key) => status[key as keyof typeof status], "z")).toEqual(["a"])
  })

  test("close finished leaves unread, errored and unknown-status tabs open", () => {
    const status = { a: "done", p: "error", c: undefined, z: "idle" } as const
    expect(closeFinishedKeys(arranged, (key) => status[key as keyof typeof status])).toEqual(["z"])
  })

  test("close group returns the parent and its spawned children", () => {
    expect(closeGroupKeys(arranged, "p")).toEqual(["p", "c"])
    expect(closeGroupKeys(arranged, "c")).toEqual(["p", "c"])
    expect(closeGroupKeys(arranged, "a")).toEqual([])
  })
})

describe("filterTabList", () => {
  const entries = [
    { key: "1", title: "Passaggissimo.jl #43 handoffs", project: "Passaggissimo.jl" },
    { key: "2", title: "Reading Aaron's Slack papers", project: "atom-transport-demo" },
    { key: "3", title: "Atoms Slack follow-up", project: "atom-transport-demo" },
  ]

  test("an empty query returns everything", () => {
    expect(filterTabList(entries, "  ").map((e) => e.key)).toEqual(["1", "2", "3"])
  })

  test("every word must match the title or the project, case-insensitively", () => {
    expect(filterTabList(entries, "slack").map((e) => e.key)).toEqual(["2", "3"])
    expect(filterTabList(entries, "SLACK atoms").map((e) => e.key)).toEqual(["3"])
    expect(filterTabList(entries, "passaggissimo handoffs").map((e) => e.key)).toEqual(["1"])
    expect(filterTabList(entries, "transport aaron").map((e) => e.key)).toEqual(["2"])
    expect(filterTabList(entries, "nothing")).toEqual([])
  })
})

describe("readSpawnedBy", () => {
  test("reads the session-spawn stamp", () => {
    expect(readSpawnedBy({ spawned_by: "ses_parent", spawned_depth: 1 })).toBe("ses_parent")
  })

  test("anything else is not spawned", () => {
    expect(readSpawnedBy(undefined)).toBeUndefined()
    expect(readSpawnedBy(null)).toBeUndefined()
    expect(readSpawnedBy({})).toBeUndefined()
    expect(readSpawnedBy({ spawned_by: 42 })).toBeUndefined()
    expect(readSpawnedBy({ spawned_by: "" })).toBeUndefined()
  })
})

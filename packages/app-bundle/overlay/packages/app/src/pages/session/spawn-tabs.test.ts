import { describe, expect, test } from "bun:test"
import { collectSpawnedChildren, isSpawnedBy, type SpawnedLike } from "./spawn-tabs"

const child = (id: string, parentId: string): SpawnedLike => ({
  id,
  metadata: { spawned_by: parentId, spawned_depth: 1 },
})

describe("isSpawnedBy", () => {
  test("matches the exact spawned_by stamp", () => {
    expect(isSpawnedBy(child("ses_a", "ses_parent"), "ses_parent")).toBe(true)
  })

  test("does not match other parents or absent stamps", () => {
    expect(isSpawnedBy(child("ses_a", "ses_other"), "ses_parent")).toBe(false)
    expect(isSpawnedBy({ id: "ses_a" }, "ses_parent")).toBe(false)
    expect(isSpawnedBy({ id: "ses_a", metadata: null }, "ses_parent")).toBe(false)
    expect(isSpawnedBy(undefined, "ses_parent")).toBe(false)
    expect(isSpawnedBy(null, "ses_parent")).toBe(false)
  })

  test("never matches a junk stamp", () => {
    expect(isSpawnedBy({ id: "ses_a", metadata: { spawned_by: 42 } }, "ses_parent")).toBe(false)
    expect(isSpawnedBy({ id: "ses_a", metadata: { spawned_by: ["ses_parent"] } }, "ses_parent")).toBe(false)
  })
})

describe("collectSpawnedChildren", () => {
  const parent = "ses_parent"

  test("selects only children spawned by the parent, sorted", () => {
    const info = {
      ses_z: child("ses_z", parent),
      ses_a: child("ses_a", parent),
      ses_other: child("ses_other", "ses_other_parent"),
      ses_plain: { id: "ses_plain" },
    }
    expect(collectSpawnedChildren(info, parent, [])).toEqual(["ses_a", "ses_z"])
  })

  test("excludes already-opened ids", () => {
    const info = {
      ses_a: child("ses_a", parent),
      ses_b: child("ses_b", parent),
    }
    expect(collectSpawnedChildren(info, parent, ["ses_a"])).toEqual(["ses_b"])
    expect(collectSpawnedChildren(info, parent, ["ses_a", "ses_b"])).toEqual([])
  })

  test("empty parent id yields nothing (draft routes have no session)", () => {
    expect(collectSpawnedChildren({ ses_a: child("ses_a", "") }, "", [])).toEqual([])
  })

  test("tolerates a missing info map", () => {
    expect(collectSpawnedChildren(undefined as unknown as Record<string, SpawnedLike>, parent, [])).toEqual([])
  })

  test("re-running with the opened-set is idempotent", () => {
    const info = { ses_a: child("ses_a", parent), ses_b: child("ses_b", parent) }
    const opened = new Set<string>()
    const first = collectSpawnedChildren(info, parent, opened)
    for (const id of first) opened.add(id)
    expect(collectSpawnedChildren(info, parent, opened)).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { lastSyncDisplay, parseVaultsResponse } from "./vaults"

describe("lastSyncDisplay", () => {
  test("passes git %cr prose through verbatim", () => {
    expect(lastSyncDisplay("2 hours ago")).toBe("2 hours ago")
  })
  test("maps the literal 'unknown', absent, and non-string values to an em dash", () => {
    expect(lastSyncDisplay("unknown")).toBe("—")
    expect(lastSyncDisplay(undefined)).toBe("—")
    expect(lastSyncDisplay(null)).toBe("—")
    expect(lastSyncDisplay(42)).toBe("—")
    expect(lastSyncDisplay("")).toBe("—")
  })
})

describe("parseVaultsResponse", () => {
  test("happy path: mounts pass through with renamed fields", () => {
    const view = parseVaultsResponse({
      ok: true,
      mounts: [
        {
          id: "armonissima",
          path: "/home/x/.amico/vaults/armonissima",
          kind: "team",
          writable: false,
          last_sync: "2 hours ago",
          warnings: [],
        },
      ],
      error: null,
    })
    expect(view.ok).toBe(true)
    expect(view.mounts).toEqual([
      { id: "armonissima", kind: "team", writable: false, lastSync: "2 hours ago", warnings: [] },
    ])
  })

  test("ok:false carries the CLI error string", () => {
    const view = parseVaultsResponse({ ok: false, mounts: [], error: "mounts.toml drift on armonissima" })
    expect(view.ok).toBe(false)
    expect(view.error).toBe("mounts.toml drift on armonissima")
  })

  test("ok:false with no usable error still produces a message", () => {
    const view = parseVaultsResponse({ ok: false, mounts: [], error: null })
    expect(view.ok).toBe(false)
    expect(view.error).toBeTruthy()
  })

  test("non-object responses are bad_shape, never a throw", () => {
    for (const raw of [null, undefined, 42, "nope", []]) {
      const view = parseVaultsResponse(raw)
      expect(view.ok).toBe(false)
      expect(view.error).toContain("bad_shape")
    }
  })

  test("mounts absent or non-array (incl. the singular {ok, vault} shape) is bad_shape", () => {
    const singular = parseVaultsResponse({ ok: true, vault: { id: "x" }, error: null })
    expect(singular.ok).toBe(false)
    expect(singular.error).toContain("bad_shape")
    const nonArray = parseVaultsResponse({ ok: true, mounts: "three", error: null })
    expect(nonArray.ok).toBe(false)
  })

  test("tolerant mount entries: missing/mistyped fields never throw", () => {
    const view = parseVaultsResponse({
      ok: true,
      mounts: [
        {},
        { id: "a", warnings: "not-a-list" },
        { id: "b", kind: 7, writable: "yes", last_sync: "unknown" },
        null,
      ],
      error: null,
    })
    expect(view.ok).toBe(true)
    expect(view.mounts).toHaveLength(4)
    expect(view.mounts[0]).toEqual({
      id: "(unknown)",
      kind: undefined,
      writable: undefined,
      lastSync: "—",
      warnings: [],
    })
    expect(view.mounts[1].warnings).toEqual([])
    expect(view.mounts[2]).toEqual({ id: "b", kind: undefined, writable: undefined, lastSync: "—", warnings: [] })
  })

  test("non-string entries inside warnings are dropped", () => {
    const view = parseVaultsResponse({ ok: true, mounts: [{ id: "a", warnings: ["real", 7, null] }], error: null })
    expect(view.mounts[0].warnings).toEqual(["real"])
  })
})

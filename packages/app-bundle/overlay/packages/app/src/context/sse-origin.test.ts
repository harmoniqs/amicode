import { describe, expect, test } from "bun:test"
import { parseCursorNamespaces, resolveEventOrigin } from "./sse-origin"

// #1539: SSE fan-in origin detection — the pure logic that determines whether
// an SSE event originated from the local engine or a remote peer, by diffing
// the composite cursor `id:` field the fan-in stamps on each frame.

describe("parseCursorNamespaces", () => {
  test("parses a composite cursor into a namespace→value map", () => {
    expect(parseCursorNamespaces("local=5;studio=42")).toEqual({ local: "5", studio: "42" })
  })

  test("a bare scalar (fleet-of-one, no `=`) returns an empty map", () => {
    expect(parseCursorNamespaces("42")).toEqual({})
  })

  test("undefined / empty string returns an empty map", () => {
    expect(parseCursorNamespaces(undefined)).toEqual({})
    expect(parseCursorNamespaces("")).toEqual({})
  })

  test("handles a single-namespace composite cursor", () => {
    expect(parseCursorNamespaces("local=5")).toEqual({ local: "5" })
  })

  test("skips malformed entries (empty key, no `=`)", () => {
    expect(parseCursorNamespaces("local=5;;=bad;studio=42")).toEqual({ local: "5", studio: "42" })
  })
})

describe("resolveEventOrigin", () => {
  test("fleet-of-one (bare scalar id) is always local — zero overhead", () => {
    const prev = {}
    const { origin, cursor } = resolveEventOrigin("42", prev)
    expect(origin).toBeUndefined()
    // Cursor is returned unchanged (no allocation for fleet-of-one).
    expect(cursor).toBe(prev)
  })

  test("undefined id is local", () => {
    expect(resolveEventOrigin(undefined, {}).origin).toBeUndefined()
  })

  test("composite cursor with local-only change → local origin", () => {
    const prev = { local: "4", studio: "42" }
    const { origin, cursor } = resolveEventOrigin("local=5;studio=42", prev)
    expect(origin).toBeUndefined()
    expect(cursor).toEqual({ local: "5", studio: "42" })
  })

  test("composite cursor with remote change → remote machine id", () => {
    const prev = { local: "5", studio: "41" }
    const { origin, cursor } = resolveEventOrigin("local=5;studio=42", prev)
    expect(origin).toBe("studio")
    expect(cursor).toEqual({ local: "5", studio: "42" })
  })

  test("first event in composite mode (empty previous) detects local origin when local changes", () => {
    // When the stream starts fresh, previous is {}. The first event's cursor
    // will differ on ALL namespaces. The first differing namespace is the origin.
    // "local" comes first in insertion order → detected as local.
    const { origin } = resolveEventOrigin("local=1;studio=0", {})
    expect(origin).toBeUndefined() // local detected first
  })

  test("composite cursor with no change from previous → local (fallback)", () => {
    const prev = { local: "5", studio: "42" }
    const { origin } = resolveEventOrigin("local=5;studio=42", prev)
    expect(origin).toBeUndefined()
  })

  test("multi-peer: correctly identifies which peer changed", () => {
    const prev = { local: "5", studio: "42", mbp: "10" }
    const { origin } = resolveEventOrigin("local=5;studio=42;mbp=11", prev)
    expect(origin).toBe("mbp")
  })
})

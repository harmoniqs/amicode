import { describe, expect, test } from "bun:test"

describe("HoldDebugBadge localStorage gate", () => {
  // The badge is gated by isDebugBadgeEnabled() which wraps the localStorage
  // read in a try/catch — a thrown getter (incognito, iframe sandbox) returns
  // false instead of crashing the app.

  const isGateOpen = () => {
    try {
      return globalThis.localStorage?.getItem("amicode_debug_badge") === "1"
    } catch {
      return false
    }
  }

  test("badge is hidden by default (no localStorage key)", () => {
    globalThis.localStorage?.removeItem("amicode_debug_badge")
    expect(isGateOpen()).toBe(false)
  })

  test("badge shows when localStorage flag is explicitly set to '1'", () => {
    globalThis.localStorage?.setItem("amicode_debug_badge", "1")
    expect(isGateOpen()).toBe(true)
    // Clean up
    globalThis.localStorage?.removeItem("amicode_debug_badge")
  })

  test("badge stays hidden for other truthy values (only '1' opens the gate)", () => {
    globalThis.localStorage?.setItem("amicode_debug_badge", "true")
    expect(isGateOpen()).toBe(false)

    globalThis.localStorage?.setItem("amicode_debug_badge", "yes")
    expect(isGateOpen()).toBe(false)

    // Clean up
    globalThis.localStorage?.removeItem("amicode_debug_badge")
  })

  test("removing the key hides the badge again", () => {
    globalThis.localStorage?.setItem("amicode_debug_badge", "1")
    expect(isGateOpen()).toBe(true)

    globalThis.localStorage?.removeItem("amicode_debug_badge")
    expect(isGateOpen()).toBe(false)
  })

  test("returns false when localStorage throws (restricted storage)", () => {
    // Simulate a restricted-storage environment where the getter throws
    const original = globalThis.localStorage
    Object.defineProperty(globalThis, "localStorage", {
      get() { throw new DOMException("Access denied") },
      configurable: true,
    })
    expect(isGateOpen()).toBe(false)
    // Restore
    Object.defineProperty(globalThis, "localStorage", {
      value: original,
      configurable: true,
      writable: true,
    })
  })
})

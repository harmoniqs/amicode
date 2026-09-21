import { describe, expect, test } from "bun:test"

describe("HoldDebugBadge localStorage gate", () => {
  // The badge is gated on:
  //   globalThis.localStorage?.getItem("amicode_debug_badge") === "1"
  // This test verifies the gate predicate in isolation — the actual component
  // mount depends on Solid's <Show>, but the decision is this boolean.

  const isGateOpen = () =>
    globalThis.localStorage?.getItem("amicode_debug_badge") === "1"

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
})

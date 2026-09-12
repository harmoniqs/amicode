import { describe, expect, test } from "bun:test"
import { sessionTabStatus } from "./session-tab-status"

describe("sessionTabStatus precedence", () => {
  test("error is loudest — red even when running", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: true, unread: true, hasError: true })).toBe("error")
  })
  test("running when no error — yellow", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: false, unread: false, hasError: false })).toBe("running")
  })
  test("done when unread — green", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: true, hasError: false })).toBe("done")
  })
  test("done when needs attention — green", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: true, unread: false, hasError: false })).toBe("done")
  })
  test("idle when done and seen — grey", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: false, hasError: false })).toBe("idle")
  })
})

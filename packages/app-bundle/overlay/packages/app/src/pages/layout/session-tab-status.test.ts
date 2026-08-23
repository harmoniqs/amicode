import { describe, expect, test } from "bun:test"
import { sessionTabStatus } from "./session-tab-status"

describe("sessionTabStatus precedence", () => {
  test("blocked beats busy — a spinner must not hide a question", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: true, unread: true, hasError: true })).toBe("attention")
  })
  test("running beats error and unread", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: false, unread: true, hasError: true })).toBe("running")
  })
  test("error beats plain unread, which would otherwise swallow it", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: true, hasError: true })).toBe("error")
  })
  test("unread when nothing louder", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: true, hasError: false })).toBe("done")
  })
  test("idle", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: false, hasError: false })).toBe("idle")
  })
})

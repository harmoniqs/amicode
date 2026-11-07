import { describe, expect, test } from "bun:test"
import { SESSION_TAB_TONE, sessionTabStatus } from "./session-tab-status"

describe("sessionTabStatus precedence", () => {
  test("error is loudest — red even when running and waiting on the user", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: true, unread: true, hasError: true })).toBe("error")
  })
  test("attention outranks running — amber when the agent waits on the user", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: true, unread: false, hasError: false })).toBe("attention")
  })
  test("attention outranks unread", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: true, unread: true, hasError: false })).toBe("attention")
  })
  test("attention when waiting on the user, not done", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: true, unread: false, hasError: false })).toBe("attention")
  })
  test("running when no error or attention — blue", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: false, unread: false, hasError: false })).toBe("running")
  })
  test("running outranks unread", () => {
    expect(sessionTabStatus({ loading: true, needsAttention: false, unread: true, hasError: false })).toBe("running")
  })
  test("done when unread — green", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: true, hasError: false })).toBe("done")
  })
  test("idle when done and seen — grey", () => {
    expect(sessionTabStatus({ loading: false, needsAttention: false, unread: false, hasError: false })).toBe("idle")
  })
})

describe("sessionTabStatus tones", () => {
  test("every status maps to an activity token and a distinct label", () => {
    expect(SESSION_TAB_TONE.running.color).toBe("var(--activity-running)")
    expect(SESSION_TAB_TONE.attention.color).toBe("var(--activity-attention)")
    expect(SESSION_TAB_TONE.done.color).toBe("var(--activity-success)")
    expect(SESSION_TAB_TONE.error.color).toBe("var(--activity-error)")
    expect(SESSION_TAB_TONE.idle.color).toBe("var(--activity-idle)")
    const labels = Object.values(SESSION_TAB_TONE).map((tone) => tone.label)
    expect(new Set(labels).size).toBe(labels.length)
  })
})

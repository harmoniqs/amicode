import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"
import { deriveSessionListChip, sessionListChipLabel } from "./session-list-chip"

const questionRow = (id: string): QuestionRequest => ({ id, sessionID: "s2", questions: [] })

// amicode#1787 (S1) — status chips on the session list: the tri-state
// derivation over the shared rows (#1768's busy/idle/omitted semantics on the
// ServerSession store's leaves — the same question rows the S2 inbox reads, so
// "waiting on question" means the same thing on both surfaces).
describe("amicode#1787 (S1) — session list chip derivation", () => {
  test("a busy shared row reads as a running chip", () => {
    const chip = deriveSessionListChip({
      source: {
        session_status: { s1: { type: "busy" } },
        question: {},
      },
      sessionID: "s1",
      now: 1_000_000,
    })
    expect(chip).toEqual({ kind: "running", retry: false })
  })

  test("a pending question row reads as waiting on question — the same rows the S2 inbox lists", () => {
    const chip = deriveSessionListChip({
      source: { session_status: { s2: { type: "busy" } }, question: { s2: [questionRow("q1")] } },
      sessionID: "s2",
      now: 1_000_000,
    })
    // A busy turn blocked on a question is WAITING ON THE QUESTION — the
    // actionable state wins over running.
    expect(chip).toEqual({ kind: "waiting-on-question" })
  })

  test("an explicit idle row reads as idle with age (label formats the age)", () => {
    const now = 1_000_000_000
    const idleChip = (ageMs: number | undefined) =>
      deriveSessionListChip({
        source: { session_status: { s3: { type: "idle" } }, question: {} },
        sessionID: "s3",
        lastActivityAt: ageMs === undefined ? undefined : now - ageMs,
        now,
      })
    expect(idleChip(40 * 60_000)).toEqual({ kind: "idle", ageMs: 40 * 60_000 })
    expect(sessionListChipLabel(idleChip(40 * 60_000)!)).toBe("idle 40m")
    expect(sessionListChipLabel(idleChip(2 * 3_600_000)!)).toBe("idle 2h")
    expect(sessionListChipLabel(idleChip(3 * 24 * 3_600_000)!)).toBe("idle 3d")
    expect(sessionListChipLabel(idleChip(30_000)!)).toBe("idle")
    expect(sessionListChipLabel(idleChip(undefined)!)).toBe("idle")
  })

  test("a retry status reads as a running chip with the retrying hint", () => {
    const chip = deriveSessionListChip({
      source: {
        session_status: { s4: { type: "retry", attempt: 1, message: "provider 429", next: 1_100_000 } },
        question: {},
      },
      sessionID: "s4",
      now: 1_000_000,
    })
    expect(chip).toEqual({ kind: "running", retry: true })
    expect(sessionListChipLabel(chip!)).toBe("retrying")
  })

  test("a session with NO status evidence is OMITTED: no chip, never a lying idle", () => {
    const chip = deriveSessionListChip({
      source: { session_status: {}, question: {} },
      sessionID: "s5",
      lastActivityAt: 1_000_000 - 3_600_000,
      now: 1_000_000,
    })
    // #1768 rhyme: absence keeps the current value — at the chip level, no
    // evidence renders nothing (an idle chip would assert idle as fact).
    expect(chip).toBeUndefined()
  })

  test("the working floor alone reads as running (the #1617/#1637 floors feed the same chip)", () => {
    const chip = deriveSessionListChip({
      source: { session_status: {}, question: {}, session_working: (id) => id === "s6" },
      sessionID: "s6",
      now: 1_000_000,
    })
    expect(chip).toEqual({ kind: "running", retry: false })
  })
})

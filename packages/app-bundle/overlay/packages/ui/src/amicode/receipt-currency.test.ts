import { describe, expect, test } from "bun:test"
import { latestSeqForEntity, receiptIsCurrent } from "./receipt-currency"
import type { EventView } from "./problem"

const ev = (seq: number, entity: string): EventView => ({ seq, entity, action: "updated" })

// Three formulation updates and one system record, as a real session accumulates them.
const EVENTS: EventView[] = [ev(2, "system"), ev(3, "formulation"), ev(5, "formulation"), ev(7, "formulation")]
const VIEW = { slug: "ghz-state-rydberg", events: EVENTS }

describe("latestSeqForEntity", () => {
  test("returns the highest seq for that kind only", () => {
    expect(latestSeqForEntity(EVENTS, "formulation")).toBe(7)
    expect(latestSeqForEntity(EVENTS, "system")).toBe(2)
  })
  test("undefined when the kind has no events (the view-lag case)", () => {
    expect(latestSeqForEntity(EVENTS, "run")).toBeUndefined()
    expect(latestSeqForEntity([], "formulation")).toBeUndefined()
  })
  test("does not assume the events are sorted", () => {
    expect(latestSeqForEntity([ev(9, "run"), ev(4, "run")], "run")).toBe(9)
  })
})

describe("receiptIsCurrent", () => {
  test("the newest receipt for a kind is current", () => {
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 7 }, VIEW)).toBe(true)
  })

  // THE BUG: superseded receipts render the live view today, so three formulation
  // updates paint three identical copies of the present.
  test("superseded receipts for the same kind are NOT current", () => {
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 3 }, VIEW)).toBe(false)
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 5 }, VIEW)).toBe(false)
  })

  // THE WORSE BUG: the transcript fetches the globally-active problem with no slug,
  // so switching problems mid-chat retroactively rewrote earlier receipts.
  test("a receipt from another problem is NOT current, even at a matching seq", () => {
    expect(receiptIsCurrent({ problem: "transmon-state-prep", entity: "formulation", seq: 7 }, VIEW)).toBe(false)
  })

  test("no view → not current (cannot establish currency; render captured)", () => {
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 7 }, undefined)).toBe(false)
  })

  test("missing seq → not current", () => {
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation" }, VIEW)).toBe(false)
  })

  // Preserves the existing card.tsx warning: "a record+update lands as two events but
  // one receipt, and the view can lag a beat, so tighter gates hid the view entirely."
  test("a kind with no events yet is current — the view may lag the receipt", () => {
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "run", seq: 11 }, VIEW)).toBe(true)
  })

  test("a view without a slug falls back to the seq check rather than collapsing everything", () => {
    const noSlug = { events: EVENTS }
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 7 }, noSlug)).toBe(true)
    expect(receiptIsCurrent({ problem: "ghz-state-rydberg", entity: "formulation", seq: 3 }, noSlug)).toBe(false)
  })

  test("a sentinel without a problem falls back to the seq check", () => {
    expect(receiptIsCurrent({ entity: "formulation", seq: 7 }, VIEW)).toBe(true)
    expect(receiptIsCurrent({ entity: "formulation", seq: 3 }, VIEW)).toBe(false)
  })
})

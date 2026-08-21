import { describe, expect, test } from "bun:test"
import { collapseReceiptRuns, receiptRunKey, type ReceiptCandidate } from "./receipt-runs"
import { parseDiffSentinel } from "./receipt"

const sentinel = (over: Partial<Record<string, unknown>> = {}) =>
  parseDiffSentinel(
    `AMICODE_DIFF ${JSON.stringify({
      problem: "x-gate",
      entity: "recommend",
      action: "proposed",
      seq: 1,
      diff: {},
      ...over,
    })}`,
  )

describe("receiptRunKey", () => {
  test("a parsed sentinel for a non-inline entity yields its (problem, entity, action)", () => {
    expect(receiptRunKey(sentinel())).toEqual({ problem: "x-gate", entity: "recommend", action: "proposed" })
  })

  test("undefined sentinel (unparseable output) → undefined", () => {
    expect(receiptRunKey(undefined)).toBeUndefined()
  })

  // INLINE_KINDS entities may resolve to the live InlineEntityView depending on
  // receipt-currency's reactive currency check — this pure module can't see that,
  // so it refuses to key them at all rather than risk collapsing across it.
  test("an INLINE_KINDS entity (system/formulation/run/device_session/calibration) → undefined", () => {
    expect(receiptRunKey(sentinel({ entity: "system" }))).toBeUndefined()
    expect(receiptRunKey(sentinel({ entity: "formulation" }))).toBeUndefined()
    expect(receiptRunKey(sentinel({ entity: "run" }))).toBeUndefined()
    expect(receiptRunKey(sentinel({ entity: "device_session" }))).toBeUndefined()
    expect(receiptRunKey(sentinel({ entity: "calibration" }))).toBeUndefined()
  })
})

// Candidates below use plain string refs ("a", "b", …) standing in for the
// PartGroup entries message-part.tsx actually passes.
const key = (entity: string, action = "proposed", problem = "x-gate") => ({ problem, entity, action })

describe("collapseReceiptRuns", () => {
  test("empty input → empty output", () => {
    expect(collapseReceiptRuns([])).toEqual([])
  })

  test("a run of 4 identical (problem, entity, action) → one entry, count 4, latest = max seq", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend"), seq: 1 },
      { ref: "b", key: key("recommend"), seq: 2 },
      { ref: "c", key: key("recommend"), seq: 3 },
      { ref: "d", key: key("recommend"), seq: 4 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual({ refs: ["a", "b", "c", "d"], latestRef: "d", count: 4 })
  })

  test("does not assume seqs are sorted — the highest numeric seq wins regardless of position", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend"), seq: 3 },
      { ref: "b", key: key("recommend"), seq: 1 },
      { ref: "c", key: key("recommend"), seq: 9 },
      { ref: "d", key: key("recommend"), seq: 2 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(1)
    expect(runs[0].latestRef).toBe("c")
    expect(runs[0].count).toBe(4)
  })

  test("all members missing seq → latest falls back to the LAST member (transcript order)", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend") },
      { ref: "b", key: key("recommend") },
      { ref: "c", key: key("recommend") },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(1)
    expect(runs[0].latestRef).toBe("c")
  })

  test("differing action → two entries, counts 1 and 1 (a state change must not hide)", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend", "proposed"), seq: 1 },
      { ref: "b", key: key("recommend", "gated"), seq: 2 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toEqual({ refs: ["a"], latestRef: "a", count: 1 })
    expect(runs[1]).toEqual({ refs: ["b"], latestRef: "b", count: 1 })
  })

  test("differing entity → not merged", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend"), seq: 1 },
      { ref: "b", key: key("problem"), seq: 2 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.count)).toEqual([1, 1])
  })

  test("differing problem → not merged", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend", "proposed", "x-gate"), seq: 1 },
      { ref: "b", key: key("recommend", "proposed", "y-gate"), seq: 2 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.count)).toEqual([1, 1])
  })

  test("a non-mergeable part interrupting a run → two separate runs either side of it", () => {
    const items: ReceiptCandidate<string>[] = [
      { ref: "a", key: key("recommend"), seq: 1 },
      { ref: "b", key: key("recommend"), seq: 2 },
      { ref: "other" }, // e.g. a text part, a different tool, an INLINE_KINDS receipt
      { ref: "c", key: key("recommend"), seq: 3 },
      { ref: "d", key: key("recommend"), seq: 4 },
    ]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(3)
    expect(runs[0]).toEqual({ refs: ["a", "b"], latestRef: "b", count: 2 })
    expect(runs[1]).toEqual({ refs: ["other"], latestRef: "other", count: 1 })
    expect(runs[2]).toEqual({ refs: ["c", "d"], latestRef: "d", count: 2 })
  })

  test("a single card → count 1, shape unchanged from the uncollapsed case", () => {
    const runs = collapseReceiptRuns<string>([{ ref: "solo", key: key("recommend"), seq: 1 }])
    expect(runs).toEqual([{ refs: ["solo"], latestRef: "solo", count: 1 }])
  })

  test("unparseable sentinel (no key) → never merged, not even with an adjacent identical unparseable one", () => {
    const items: ReceiptCandidate<string>[] = [{ ref: "a" }, { ref: "b" }]
    const runs = collapseReceiptRuns(items)
    expect(runs).toHaveLength(2)
    expect(runs).toEqual([
      { refs: ["a"], latestRef: "a", count: 1 },
      { refs: ["b"], latestRef: "b", count: 1 },
    ])
  })
})

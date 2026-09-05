// Issue #817 — D6 (spec spec-20260905-045114-session-device-lifecycle), the
// revised placement: the fork-era drift gate becomes a per-harness CONTRACT
// CONFORMANCE suite. The client's expectations of session-list query
// semantics are DECLARED here and probed against any harness's session.list —
// canonical opencode today, Telaio tomorrow. A harness that changes what a
// query MEANS (scoping keys, filters, defaults, ordering, pagination) without
// a companion update goes red; an additive optional field with a base default
// goes green.
import { describe, expect, test } from "vitest"
import {
  CANONICAL_SESSION_LIST_SEMANTICS,
  runSessionListConformance,
  type ConformanceSession,
} from "../../app-bundle/overlay/packages/app/src/utils/session-list-conformance"

const session = (id: string, updated: number, extra: Partial<ConformanceSession> = {}): ConformanceSession => ({
  id,
  directory: "/conformance-home",
  parentID: undefined,
  time: { created: updated, updated },
  ...extra,
})

/** A harness whose store behaves like canonical opencode's v2 session.list:
 *  directory-scoped, roots-only on parentID null, archived excluded from the
 *  default projection, desc order, continuation cursors — and it may cap page
 *  size below the requested limit. */
function canonicalHarness(store: ConformanceSession[], opts: { pageSize?: number; additiveField?: boolean } = {}) {
  const pageSize = opts.pageSize ?? store.length
  return async (input: { directory: string; parentID?: null; limit: number; order?: "asc" | "desc"; cursor?: string }) => {
    let rows = store.filter((s) => s.directory === input.directory)
    if (input.parentID === null) rows = rows.filter((s) => !s.parentID)
    rows = rows.filter((s) => s.time.archived === undefined)
    rows.sort((a, b) => (input.order === "asc" ? a.time.updated - b.time.updated : b.time.updated - a.time.updated))
    const start = input.cursor ? Number(input.cursor) : 0
    const page = rows.slice(start, start + pageSize)
    const next = start + page.length < rows.length && page.length > 0 ? String(start + page.length) : undefined
    const body: Record<string, unknown> = { data: page, cursor: { next } }
    if (opts.additiveField) body.currency = "v1.2.200.300.v1.18.29"
    return body as never
  }
}

describe("the session-list conformance suite (D6: declared semantics, probed per harness)", () => {
  test("the canonical semantics are declared (the client's expectations, not the server's)", () => {
    expect(CANONICAL_SESSION_LIST_SEMANTICS.harness).toBe("opencode-canonical")
    expect(CANONICAL_SESSION_LIST_SEMANTICS.endpoint).toBe("v2.session.list")
    expect(CANONICAL_SESSION_LIST_SEMANTICS.scoping).toContain("directory")
    expect(CANONICAL_SESSION_LIST_SEMANTICS.ordering.default).toBe("desc")
    expect(CANONICAL_SESSION_LIST_SEMANTICS.pagination.exhaustionSignal).toBe("cursor")
    expect(CANONICAL_SESSION_LIST_SEMANTICS.filtering.archivedExcludedFromDefault).toBe(true)
    expect(CANONICAL_SESSION_LIST_SEMANTICS.filtering.rootsOnlyWhenParentIDNull).toBe(true)
  })

  test("a canonical-shaped harness passes every probe", async () => {
    const list = canonicalHarness([
      session("s1", 100),
      session("s2", 200, { parentID: "s1" }),
      session("s3", 300, { directory: "/other", parentID: "x" }),
      session("s4", 400, { time: { created: 400, updated: 400, archived: 500 } }),
    ])
    const report = await runSessionListConformance({
      harness: "opencode-canonical",
      list,
      // The default projection the client renders: roots, archived excluded —
      // s3 (another directory) and s4 (archived) are not among them.
      expectedSessionCount: 1,
    })
    expect(report.passed).toBe(true)
    expect(report.probes.map((p) => p.name)).toEqual([
      "ordering.newest-first",
      "scoping.directory",
      "filtering.archived-excluded",
      "filtering.roots-only",
      "pagination.cursor-exhaustion",
    ])
    expect(report.probes.every((p) => p.state === "pass")).toBe(true)
  })

  test("a semantic change to scoping fails the drift gate (directory filter ignored)", async () => {
    const drifted = async (input: { directory: string; limit: number; order?: string; cursor?: string }) => {
      // The founding incident: the route stopped honoring the directory filter.
      const rows = [{ ...session("s3", 300), directory: "/other" }]
      return { data: rows, cursor: {} } as never
    }
    const report = await runSessionListConformance({ harness: "drifted", list: drifted })
    expect(report.passed).toBe(false)
    expect(report.probes.find((p) => p.name === "scoping.directory")?.state).toBe("fail")
  })

  test("a semantic change to filtering fails the gate (archived leaks into the default projection)", async () => {
    const leaky = async (input: { directory: string; limit: number; order?: string; cursor?: string }) => {
      const rows = [session("s1", 100), session("s4", 400, { time: { created: 400, updated: 400, archived: 500 } })]
      return { data: rows, cursor: {} } as never
    }
    const report = await runSessionListConformance({ harness: "leaky", list: leaky })
    expect(report.probes.find((p) => p.name === "filtering.archived-excluded")?.state).toBe("fail")
    expect(report.passed).toBe(false)
  })

  test("a semantic change to pagination fails the gate (page-fullness exhaustion silently drops rows)", async () => {
    // A hub that ends the fetch when a page comes back shorter than the
    // REQUESTED limit, while its store holds more rows: the fixture's store
    // has 6 sessions, the hub caps pages at 2 — the first short page ends the
    // walk and rows 3–6 are silently dropped.
    const store = Array.from({ length: 6 }, (_, index) => session(`s${index + 1}`, 100 + index))
    const fullnessExhausted = async (input: { directory: string; limit: number; cursor?: string }) => {
      const start = input.cursor ? Number(input.cursor) : 0
      const page = store.slice(start, start + 2)
      // The broken rule: a page shorter than the REQUESTED limit ends the
      // store — with the client requesting 10000, the very first (capped)
      // page ends the walk.
      const next = page.length === input.limit ? String(start + 2) : undefined
      return { data: page, cursor: { next } } as never
    }
    const report = await runSessionListConformance({
      harness: "fullness",
      list: fullnessExhausted,
      expectedSessionCount: 6,
    })
    expect(report.probes.find((p) => p.name === "pagination.cursor-exhaustion")?.state).toBe("fail")
    expect(report.passed).toBe(false)
  })

  test("D6's change policy: an additive optional field with a base default goes green", async () => {
    const store = [session("s1", 100)]
    const plain = await runSessionListConformance({
      harness: "opencode-canonical",
      list: canonicalHarness(store),
      expectedSessionCount: 1,
    })
    const additive = await runSessionListConformance({
      harness: "opencode-canonical",
      list: canonicalHarness(store, { additiveField: true }),
      expectedSessionCount: 1,
    })
    expect(plain.passed).toBe(true)
    expect(additive.passed).toBe(true)
  })

  test("a probe error is a failure, not a crash — the suite reports what broke", async () => {
    const exploding = async () => {
      throw new Error("hub 500")
    }
    const report = await runSessionListConformance({ harness: "exploding", list: exploding as never })
    expect(report.passed).toBe(false)
    expect(report.probes.every((p) => p.state === "fail")).toBe(true)
    expect(report.probes[0]!.detail).toContain("hub 500")
  })
})

// D6 (spec spec-20260905-045114-session-device-lifecycle), issue #817 — the
// revised placement: the fork-era session-list drift gate becomes a
// per-harness CONTRACT CONFORMANCE suite. The client's expectations of
// session-list query semantics (scoping keys, filter fields, defaults,
// ordering, pagination) are DECLARED below and probed against any harness's
// session.list — canonical opencode today, Telaio tomorrow. A harness that
// changes what a query MEANS without a companion update goes red; an additive
// optional field with a base default goes green (the D6 change policy — the
// rule premium needs ride like anyone else's).
//
// Pure and dependency-free so it runs headless in any suite and against any
// backend adapter.
import type { Session } from "@opencode-ai/sdk/v2/client"

/** The shape the probes need from a harness's session rows (a subset of the
 *  client's Session). */
export type ConformanceSession = Pick<Session, "id" | "directory" | "parentID" | "time">

/** The client's declared session-list expectations for the canonical opencode
 *  harness (v2). The founding incident (2026-09-05): the v1 route's semantics
 *  changed directory-filtered → project-scoped between builds and correct
 *  queries silently started returning empty answers. */
export const CANONICAL_SESSION_LIST_SEMANTICS = {
  harness: "opencode-canonical",
  endpoint: "v2.session.list",
  /** Scoping keys the harness must honor on every list request. */
  scoping: ["directory", "parentID"] as const,
  ordering: {
    /** The default order the client requests and relies on. */
    default: "desc",
  },
  filtering: {
    /** Archived sessions are absent from the default projection (D4). */
    archivedExcludedFromDefault: true,
    /** `parentID: null` returns roots only. */
    rootsOnlyWhenParentIDNull: true,
  },
  pagination: {
    /** The ONLY exhaustion signal: a missing continuation cursor. A page
     *  shorter than the requested limit does not end the store. */
    exhaustionSignal: "cursor",
  },
  /** F5's additive-field registry: optional response fields the client reads
   *  structurally and tolerates in absence (base defaults). Semantic fields
   *  may only land here. */
  additiveOptionalFields: [
    {
      name: "currency",
      kind: "derived-token",
      baseDefault: "absent",
      note: "The client derives its own list-currency token (session-currency.ts); a server field would be an optional richer surface (Harness Contract vNext), never a requirement.",
    },
  ] as const,
}

export type SessionListProbe = {
  name: string
  state: "pass" | "fail"
  detail?: string
}

export type ConformanceReport = {
  harness: string
  passed: boolean
  probes: SessionListProbe[]
}

type ListInput = { directory: string; parentID?: null; limit: number; order?: "asc" | "desc"; cursor?: string }

type SessionListHarness = (input: ListInput) => Promise<unknown>

type Page = { data?: ConformanceSession[]; cursor?: { next?: string } }

const asPage = (response: unknown): Page => response as Page

async function probe(name: string, run: () => Promise<void>): Promise<SessionListProbe> {
  try {
    await run()
    return { name, state: "pass" }
  } catch (error) {
    return { name, state: "fail", detail: error instanceof Error ? error.message : String(error) }
  }
}

function expect(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

/** Run every semantic probe against one harness's session.list. Each probe is
 *  a minimal experiment: the harness sees a crafted request and the probe
 *  inspects the response for the SEMANTIC (not the data). `expectedSessionCount`
 *  is the fixture's ground truth (the caller built the harness) — the
 *  pagination probe needs it, because no black-box probe can distinguish a
 *  store that truly ended from a hub that stopped early on a short page. */
export async function runSessionListConformance(input: {
  harness: string
  list: SessionListHarness
  /** The directory the probes scope requests to. */
  directory?: string
  /** How many sessions the store holds for the probe directory (default
   *  projection — archived excluded). The pagination probe asserts the walk
   *  collects exactly this many rows. */
  expectedSessionCount?: number
}): Promise<ConformanceReport> {
  const directory = input.directory ?? "/conformance-home"

  const ordering = await probe("ordering.newest-first", async () => {
    const page = asPage(
      await input.list({ directory, parentID: null, limit: 50, order: "desc" }),
    )
    const rows = page.data ?? []
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1]!.time.updated ?? rows[i - 1]!.time.created
      const curr = rows[i]!.time.updated ?? rows[i]!.time.created
      expect(prev >= curr, `row ${i} is newer than its predecessor — desc order not honored`)
    }
  })

  const scoping = await probe("scoping.directory", async () => {
    const page = asPage(
      await input.list({ directory, parentID: null, limit: 50, order: "desc" }),
    )
    for (const row of page.data ?? []) {
      expect(
        row.directory === directory,
        `session ${row.id} belongs to ${row.directory} — the directory filter is not honored`,
      )
    }
  })

  const archived = await probe("filtering.archived-excluded", async () => {
    const page = asPage(
      await input.list({ directory, parentID: null, limit: 50, order: "desc" }),
    )
    for (const row of page.data ?? []) {
      expect(
        row.time.archived === undefined || row.time.archived === null,
        `session ${row.id} is archived but leaked into the default projection`,
      )
    }
  })

  const roots = await probe("filtering.roots-only", async () => {
    const page = asPage(
      await input.list({ directory, parentID: null, limit: 50, order: "desc" }),
    )
    for (const row of page.data ?? []) {
      expect(!row.parentID, `session ${row.id} has parentID ${row.parentID} — parentID:null did not scope to roots`)
    }
  })

  const pagination = await probe("pagination.cursor-exhaustion", async () => {
    // The harness must keep serving continuation cursors until the store is
    // exhausted — including from pages shorter than the requested limit. The
    // client walks cursors and would silently drop rows past the first short
    // page otherwise (a hub that caps page size below the request, or a
    // page-fullness exhaustion rule). A big requested limit is deliberate:
    // every page is short relative to it, so ONLY cursor discipline walks the
    // whole store.
    const limit = 10_000
    const seen = new Set<string>()
    let cursor: string | undefined
    let requests = 0
    for (;;) {
      const page = asPage(
        await input.list({ directory, parentID: null, limit, order: "desc", ...(cursor ? { cursor } : {}) }),
      )
      requests++
      expect(requests < 100, "the harness never exhausted the store (runaway continuation)")
      for (const row of page.data ?? []) {
        expect(!seen.has(row.id), `session ${row.id} was served twice across pages`)
        seen.add(row.id)
      }
      const next = page.cursor?.next
      if (!next) break
      cursor = next
    }
    expect(requests > 0, "the harness served no page")
    if (input.expectedSessionCount !== undefined) {
      expect(
        seen.size === input.expectedSessionCount,
        `the walk collected ${seen.size} of ${input.expectedSessionCount} sessions — the harness ended the fetch early (page fullness instead of cursor exhaustion)`,
      )
    }
  })

  const probes = [ordering, scoping, archived, roots, pagination]
  return { harness: input.harness, passed: probes.every((p) => p.state === "pass"), probes }
}

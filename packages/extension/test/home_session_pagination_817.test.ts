// Issue #817 — D2/D4 (spec spec-20260905-045114-session-device-lifecycle):
// the boot fetch paginates by cursor, not page fullness. Ported from the fork
// reference (harmoniqs/opencode#296, 10b7e96e) against the overlay's carried
// home-session-index: a hub that caps page size below the requested limit
// must not silently drop everything past its first short page.
import { describe, expect, test } from "vitest"
import { HOME_V2_SESSION_PAGE_LIMIT, loadHomeSessionIndex } from "../../app-bundle/overlay/packages/app/src/context/global-sync/home-session-index"

const session = (input: { id: string; updated?: number }) => ({
  id: input.id,
  parentID: undefined,
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: input.updated ?? 1 },
  title: input.id,
  location: { directory: "/project" },
})

function seed(count: number) {
  // time_created ascending with index; the store's newest session is last.
  return Array.from({ length: count }, (_, index) =>
    session({ id: `ses_${String(index).padStart(6, "0")}`, updated: 1_000 + index }),
  )
}

describe("Home boot fetch pagination (D2/D4: recent tail first, continues paging)", () => {
  test("pages a 1250-session store desc-first via continuation cursors until exhausted", async () => {
    const store = seed(1250)
    const pages: { order?: string; cursor?: string }[] = []
    const PAGE_SIZE = 500 // a hub that caps page size below the requested limit
    const list = async (input: { limit: number; order?: "asc" | "desc"; cursor?: string }) => {
      pages.push({ order: input.order, cursor: input.cursor })
      const start = input.cursor ? Number(input.cursor) : 0
      // The store answers desc: the newest (recent tail) first.
      const page = store.toReversed().slice(start, start + PAGE_SIZE)
      const next = start + PAGE_SIZE < store.length ? String(start + PAGE_SIZE) : undefined
      return { data: { data: page, cursor: { next } } }
    }

    const result = await loadHomeSessionIndex(list as never)

    // The recent tail arrives first: page one holds the newest sessions.
    expect(pages[0]!.order).toBe("desc")
    expect(pages[0]!.cursor).toBeUndefined()
    // 1250 sessions at 500/page take exactly three pages.
    expect(pages).toHaveLength(3)
    expect(pages[1]!.cursor).toBeDefined()
    expect(pages[2]!.cursor).toBeDefined()
    // The full store is assembled, newest session included.
    expect(result.sessions).toHaveLength(1250)
    const newest = store[store.length - 1]!.id
    expect(result.sessions.some((item) => item.id === newest)).toBe(true)
  })

  test("a store smaller than one page needs exactly one request", async () => {
    const store = seed(12)
    let calls = 0
    const list = async (input: { limit: number }) => {
      calls++
      return { data: { data: store.toReversed().slice(0, input.limit), cursor: {} } }
    }

    const result = await loadHomeSessionIndex(list as never)

    expect(calls).toBe(1)
    expect(result.sessions).toHaveLength(12)
  })

  test("a short page does NOT end the fetch when the cursor continues", async () => {
    // The founding bug: a hub capping page size below the requested limit
    // would end the fetch on the first short page and silently drop the rest.
    const store = seed(1250)
    const PAGE_SIZE = 500
    let calls = 0
    const list = async (input: { limit: number; cursor?: string }) => {
      calls++
      const start = input.cursor ? Number(input.cursor) : 0
      const page = store.toReversed().slice(start, start + PAGE_SIZE)
      const next = start + PAGE_SIZE < store.length ? String(start + PAGE_SIZE) : undefined
      return { data: { data: page, cursor: { next } } }
    }

    const result = await loadHomeSessionIndex(list as never)

    expect(calls).toBe(3)
    expect(result.sessions).toHaveLength(1250)
  })

  test("respects an abort signal between pages", async () => {
    const store = seed(HOME_V2_SESSION_PAGE_LIMIT * 2)
    const controller = new AbortController()
    let calls = 0
    const list = async (
      input: { limit: number; order?: "asc" | "desc"; cursor?: string },
      options?: { signal?: AbortSignal },
    ) => {
      calls++
      if (calls === 2) controller.abort()
      if (options?.signal?.aborted) throw new Error("aborted")
      const start = input.cursor ? Number(input.cursor) : 0
      const page = store.toReversed().slice(start, start + HOME_V2_SESSION_PAGE_LIMIT)
      const next = start + HOME_V2_SESSION_PAGE_LIMIT < store.length ? String(start + HOME_V2_SESSION_PAGE_LIMIT) : undefined
      return { data: { data: page, cursor: { next } } }
    }

    await expect(loadHomeSessionIndex(list as never, 0, controller.signal)).rejects.toThrow("aborted")
    expect(calls).toBe(2)
  })
})

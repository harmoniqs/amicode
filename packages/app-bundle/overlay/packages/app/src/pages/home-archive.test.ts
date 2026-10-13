/**
 * home-archive.test.ts
 *
 * The Home flyout's session-list archive action (home.archiveSession) is a
 * LOCAL archive. Two things it must do:
 *
 *  1. PERF (#archive-lag cleanup): remove the archived row by SPLICING it out
 *     of its directory store, NOT by re-fetching + reconciling every project
 *     directory's session list (the old reload re-`remember`ed 100+ sessions on
 *     each archive — wasted work). roots() (pages/layout/helpers.ts) filters
 *     archived sessions out of the list, so the splice is the whole removal.
 *  2. #1646: flip the viewed composer to its read-only banner in place via the
 *     INFO-ONLY `resolve(force)` (not `sync(force)`): the archived flag is
 *     metadata, and a forced `sync` also re-pulled the whole message page +
 *     parents (seconds of wasted wire on a warmed session).
 *
 * Source-assertion pattern (mirrors message-timeline-archive.test.ts): the
 * wiring is asserted against the .tsx source; the per-session store BEHAVIOR is
 * covered by server-session.test.ts (the runInflight force-bypass + the resolve
 * force re-fetch).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(__dirname, "home.tsx"), "utf8")

// Isolate the archiveSession handler body (the next function is
// deleteArchivedSession) so the assertion is scoped to it.
function archiveSessionBody(src: string): string {
  const start = src.indexOf("async function archiveSession(session: Session)")
  expect(start).toBeGreaterThan(-1)
  const next = src.indexOf("async function deleteArchivedSession", start)
  expect(next).toBeGreaterThan(start)
  return src.slice(start, next)
}

describe("Home flyout archive — splice the row, flip the composer info-only (#archive-lag / #1646)", () => {
  test("archiveSession splices the row from the store (no full list reload) + flips the composer info-only", () => {
    const body = archiveSessionBody(source)
    // the archived row is removed by a targeted splice, not a whole-list reload
    expect(body).toContain("draft.session.splice(")
    // …and the composer's archived banner flips via the INFO-ONLY resolve
    expect(body).toContain("session.resolve(session.id, { force: true })")
    // must NOT use the heavy sync(force), which re-pulls the full message history
    expect(body).not.toContain("session.sync(session.id, { force: true })")
  })
})

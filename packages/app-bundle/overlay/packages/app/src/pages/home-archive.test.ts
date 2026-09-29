/**
 * home-archive.test.ts
 *
 * The Home flyout's session-list archive action (home.archiveSession) is a
 * LOCAL archive. #1646: archiving the session you are VIEWING must flip its
 * composer to the read-only banner in place. loadSessions refreshes the LIST
 * store, but the composer's `archived` memo reads the PER-SESSION store, which
 * only a force-sync lands — so the handler must force-sync after the reload.
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

describe("Home flyout archive — force-sync so the viewed composer flips (#1646)", () => {
  test("archiveSession force-syncs the per-session store after the list reload", () => {
    const body = archiveSessionBody(source)
    expect(body).toContain("session.sync(session.id, { force: true })")
  })
})

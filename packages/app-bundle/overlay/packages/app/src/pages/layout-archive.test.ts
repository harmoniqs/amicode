/**
 * layout-archive.test.ts
 *
 * The Rail session-list archive action (sidebar-items → layout.archiveSession)
 * is a LOCAL archive. #1646: archiving the session you are VIEWING must flip it
 * to the read-only banner IN PLACE (like the chat menu), NOT navigate away — the
 * old bounce meant the read-only mode was never seen. In-place requires a
 * force-sync of the per-session store (the composer's `archived` memo source)
 * and no navigation out of the archived session.
 *
 * Source-assertion pattern (mirrors message-timeline-archive.test.ts): the
 * wiring is asserted against the .tsx source; the per-session store BEHAVIOR is
 * covered by server-session.test.ts (the runInflight force-bypass + the resolve
 * force re-fetch).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(__dirname, "layout.tsx"), "utf8")

// Isolate the archiveSession handler body so assertions are scoped to it and
// not satisfied (or falsified) by an unrelated occurrence elsewhere in the file
// — layout.tsx has many navigate() calls outside this handler.
function archiveSessionBody(src: string): string {
  const start = src.indexOf("async function archiveSession(session: Session)")
  expect(start).toBeGreaterThan(-1)
  const next = src.indexOf('command.register("layout"', start)
  expect(next).toBeGreaterThan(start)
  return src.slice(start, next)
}

describe("Rail list archive — flip in place, never navigate (#1646)", () => {
  test("archiveSession force-syncs the per-session store (the composer source)", () => {
    const body = archiveSessionBody(source)
    expect(body).toContain("session.sync(session.id, { force: true })")
  })

  test("archiveSession does NOT navigate away from the archived session", () => {
    const body = archiveSessionBody(source)
    // The old behavior bounced you to the next session, so the read-only mode
    // was never seen. The trailing paren distinguishes the call from the prose
    // comment ("navigating away").
    expect(body).not.toContain("navigate(")
  })
})

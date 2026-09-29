/**
 * message-timeline-archive.test.ts
 *
 * The session-header 3-dot menu (next to the compaction button) owns archive /
 * unarchive for the session you are VIEWING. Two regressions live here:
 *
 *  1. Archiving the viewed session navigated AWAY from it (splice + evict +
 *     navigateAfterSessionRemoval), so the user never saw the read-only banner
 *     and never got an in-place Unarchive affordance. The fix keeps you ON the
 *     session and force-syncs the per-session store so the composer flips to
 *     read-only and the menu swaps Archive → Unarchive in place. Mirrors the
 *     header's own archive path (session-header.tsx #1646).
 *
 *  2. The Archive/Unarchive menu toggle read `time.archived` DIRECTLY off the
 *     per-session store with no subscription anchor — the exact #1646 Solid
 *     reactivity trap the composer memo fixed. Touching `time.updated` (which
 *     every remember() bumps) is what guarantees the toggle recomputes when the
 *     archive event lands.
 *
 * Following the repo's component-source-assertion pattern
 * (session-header.test.tsx #1646): the wiring is asserted against the .tsx
 * source; the per-session store BEHAVIOR is covered by server-session.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(__dirname, "message-timeline.tsx"), "utf8")

// Isolate the archiveSession handler body so assertions are scoped to it and
// not accidentally satisfied by an unrelated occurrence elsewhere in the file.
function archiveSessionBody(src: string): string {
  const start = src.indexOf("const archiveSession = async")
  expect(start).toBeGreaterThan(-1)
  const next = src.indexOf("const unarchiveSession = async", start)
  expect(next).toBeGreaterThan(start)
  return src.slice(start, next)
}

describe("session-header archive menu — stay-in-place + force-sync", () => {
  test("archiveSession force-syncs the per-session store (the composer + menu source)", () => {
    const body = archiveSessionBody(source)
    // The per-session store (sync().session.get(id).time.archived) is what the
    // composer banner and the menu toggle read; only a force-sync updates it.
    expect(body).toContain("session.sync(sessionID, { force: true })")
  })

  test("archiveSession does NOT navigate away from the archived session", () => {
    const body = archiveSessionBody(source)
    // Bouncing to another session meant the read-only mode was never seen.
    expect(body).not.toContain("navigateAfterSessionRemoval")
  })

  test("archiveSession does NOT evict the per-session info the banner/menu depend on", () => {
    const body = archiveSessionBody(source)
    // evict() drops the per-session info; the read-only banner and the
    // Unarchive toggle both read it, so evicting here re-breaks the flip.
    expect(body).not.toContain("session.evict(sessionID)")
  })
})

describe("session-header archive menu — #1646 reactivity anchor on the toggle", () => {
  test("the archived toggle subscribes to time.updated, not just the time.archived leaf", () => {
    // A <Show> that touches only the (initially-undefined) time.archived leaf
    // never subscribes in the Solid store, so the toggle does not flip when the
    // archive event lands. The fix routes the gate through a helper that also
    // touches time.updated (the anchor every remember() bumps).
    expect(source).toContain("sessionArchived(")
    // and the raw un-anchored read is gone from the menu gates
    expect(source).not.toContain("when={sync().session.get(id)?.time?.archived}")
  })

  test("sessionArchived touches time.updated as the subscription anchor", () => {
    const start = source.indexOf("sessionArchived")
    expect(start).toBeGreaterThan(-1)
    // The helper (wherever defined) reads time.updated before returning
    // time.archived — the #1646 anchor pattern.
    const helperDef = source.indexOf("sessionArchived =")
    expect(helperDef).toBeGreaterThan(-1)
    const window = source.slice(helperDef, helperDef + 400)
    expect(window).toContain("time?.updated")
    expect(window).toContain("time?.archived")
  })
})

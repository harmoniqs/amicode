/**
 * harmoniqs/amicode#1251: chat scroll position must survive a session tab switch.
 *
 * The timeline remounts per session and is too context-heavy to render here, so
 * (following the repo's component-source-assertion pattern, see
 * message-timeline-archive.test.ts) these assert the wiring. The behavior of the
 * pieces is covered by scroll-posture.test.ts and auto-scroll-hold.test.ts.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const timeline = readFileSync(resolve(__dirname, "message-timeline.tsx"), "utf8")
const page = readFileSync(resolve(__dirname, "..", "..", "session.tsx"), "utf8")

const body = (src: string, start: string, end: string) => {
  const from = src.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  const to = src.indexOf(end, from + start.length)
  expect(to).toBeGreaterThan(from)
  return src.slice(from, to)
}

describe("timeline scroll posture wiring (#1251)", () => {
  test("every bottom-pull goes through one restore-aware, owner-scoped anchorBottom()", () => {
    // Exactly one read of the session-level signal: inside anchorBottom itself.
    expect(timeline.match(/props\.shouldAnchorBottom\(\)/g)?.length).toBe(1)
    const anchor = body(timeline, "const anchorBottom = () =>", "\n")
    // vetoed while a saved posture is being restored…
    expect(anchor).toContain("!restoringPosture()")
    // …and once the route has moved to another session, so the outgoing
    // timeline is never yanked to the bottom (which would also erase its posture).
    expect(anchor).toContain("sessionKey() === ownerSessionKey")
  })

  test("a saved posture is restored only when the measurement snapshot survived", () => {
    expect(timeline).toContain("initialMeasurements?.length ? scrollPostures.get(ownerSessionKey) : undefined")
    expect(timeline).toContain("initialOffset: () => savedPostureTop ??")
    const mount = body(timeline, "let overscanFrame: number | undefined", "const maybeAnchorBottom")
    expect(mount).toContain("restoreScrollPosture(")
    expect(mount).toContain("props.onHoldScrollPosture")
  })

  test("scrolls record the posture for this timeline's own session only", () => {
    const scroll = body(timeline, "const handleListScroll", "onCleanup(")
    expect(scroll).toContain("recordPosture(")
    const record = body(timeline, "const recordPosture", "\n  }")
    expect(record).toContain("sessionKey() !== ownerSessionKey")
    expect(record).toContain("scrollPostures.record(ownerSessionKey")
  })

  test("evicting a session's measurement snapshot also forgets its posture", () => {
    const cleanup = body(timeline, "timelineCache.set(ownerSessionKey", "if (resizePinFrame")
    expect(cleanup).toContain("scrollPostures.clear(")
  })
})

describe("session page scroll posture wiring (#1251)", () => {
  test("switching to a session the reader left scrolled up holds bottom-follow off instead of clearing it", () => {
    const effect = body(page, "const autoScroll = createAutoScroll(", "let scrollStateFrame")
    expect(effect).toContain("scrollPostures.get(sessionKey())")
    expect(effect).toContain("autoScroll.holdUserScrolled()")
    expect(effect).toContain("autoScroll.clearUserScrolled()")
  })

  test("the timeline can re-assert the hold once it has mounted", () => {
    expect(page).toContain("onHoldScrollPosture={autoScroll.holdUserScrolled}")
  })
})

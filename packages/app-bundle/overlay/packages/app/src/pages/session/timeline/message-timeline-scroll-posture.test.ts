/**
 * harmoniqs/amicode#1251 — chat scroll position must survive a session tab switch.
 *
 * The timeline remounts per session; the pure posture logic is covered by
 * scroll-posture.test.ts. These are the wiring assertions (the repo's
 * component-source-assertion pattern): every bottom-pull in the timeline must
 * go through the restore-aware `anchorBottom()` veto, and the session page must
 * hand the timeline a way to hold the reader off the bottom.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const timeline = readFileSync(resolve(__dirname, "message-timeline.tsx"), "utf8")
const page = readFileSync(resolve(__dirname, "..", "..", "session.tsx"), "utf8")

describe("timeline scroll posture wiring (#1251)", () => {
  test("props.shouldAnchorBottom is read only through the restore-aware anchorBottom()", () => {
    const uses = timeline.match(/props\.shouldAnchorBottom\(\)/g) ?? []
    // exactly one: the body of anchorBottom itself
    expect(uses.length).toBe(1)
    expect(timeline).toContain("const anchorBottom = () => !restoringPosture() && props.shouldAnchorBottom()")
  })

  test("a saved posture seeds the virtualizer's initial offset", () => {
    expect(timeline).toContain("initialOffset: () => savedPostureTop ??")
  })

  test("posture is only restored when the measurement snapshot survived", () => {
    expect(timeline).toContain("initialMeasurements?.length ? scrollPostures.get(ownerSessionKey)")
  })

  test("scroll events record the posture after the auto-scroll hook has seen them", () => {
    const body = timeline.slice(timeline.indexOf("const handleListScroll"))
    expect(body.indexOf("props.onAutoScrollHandleScroll()")).toBeGreaterThan(-1)
    expect(body.indexOf("recordPosture(root)")).toBeGreaterThan(body.indexOf("props.onAutoScrollHandleScroll()"))
  })

  test("the session page lets the timeline pause bottom-follow", () => {
    expect(page).toContain("onHoldScrollPosture={autoScroll.pause}")
  })
})

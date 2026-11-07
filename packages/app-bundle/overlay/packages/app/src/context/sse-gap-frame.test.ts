// sse-gap-frame.test.ts — #1617: the client's gap-frame interception.
import { describe, test, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isSyncGapType, parseSyncGapFrame, SYNC_GAP_TYPE } from "./sse-gap-frame"

describe("#1617 — sync gap frame recognition", () => {
  test("isSyncGapType matches the aggregator's wire type and nothing else", () => {
    expect(isSyncGapType(SYNC_GAP_TYPE)).toBe(true)
    expect(isSyncGapType("amicode.sync.gap")).toBe(true)
    expect(isSyncGapType("amicode.fleet.focus")).toBe(false)
    expect(isSyncGapType("session.updated")).toBe(false)
    expect(isSyncGapType(undefined)).toBe(false)
    expect(isSyncGapType(null)).toBe(false)
  })

  test("parseSyncGapFrame extracts the affected namespaces", () => {
    expect(parseSyncGapFrame({ type: SYNC_GAP_TYPE, namespaces: ["studio", "mini"] })).toEqual({
      namespaces: ["studio", "mini"],
    })
  })

  test("parseSyncGapFrame tolerates a missing/malformed namespaces field (empty list, still a gap)", () => {
    expect(parseSyncGapFrame({ type: SYNC_GAP_TYPE })).toEqual({ namespaces: [] })
    expect(parseSyncGapFrame({ type: SYNC_GAP_TYPE, namespaces: "studio" })).toEqual({ namespaces: [] })
    expect(parseSyncGapFrame({ type: SYNC_GAP_TYPE, namespaces: [1, "studio", null] })).toEqual({
      namespaces: ["studio"],
    })
  })

  test("parseSyncGapFrame returns undefined only for a non-object", () => {
    expect(parseSyncGapFrame(undefined)).toBeUndefined()
    expect(parseSyncGapFrame("nope")).toBeUndefined()
    expect(parseSyncGapFrame(42)).toBeUndefined()
  })
})

// ── wiring integrity (the event-loop glue lives in a closure; assert the seam) ──
// The focus-frame interception this fix is modeled on is likewise verified at the
// source level — the loop body is not independently constructable. These pins are
// falsifiable: deleting the interception or the forced-bootstrap branch reds them.
describe("#1617 — gap interception is wired at both client seams", () => {
  const sdkSource = readFileSync(join(import.meta.dir, "server-sdk.tsx"), "utf8")
  const syncSource = readFileSync(join(import.meta.dir, "server-sync.tsx"), "utf8")

  test("server-sdk intercepts the gap frame and re-emits it as a synthetic global event", () => {
    expect(sdkSource).toContain("isSyncGapType(focusType)")
    // re-emitted onto the normal queue as a global event (not a session event)
    expect(sdkSource).toMatch(/directory:\s*"global"[\s\S]*SYNC_GAP_TYPE/)
    // and the loop skips the rest (never advances the cursor on a gap)
    const idx = sdkSource.indexOf("isSyncGapType(focusType)")
    expect(sdkSource.slice(idx, idx + 1000)).toContain("continue")
  })

  test("server-sync forces a bootstrap refetch on the gap type, in the debounce-free branch", () => {
    // the gap type sits in the UNCONDITIONAL bootstrap.refetch() branch (with
    // config.updated etc.), NOT the debounced server.connected branch
    expect(syncSource).toMatch(/"amicode\.sync\.gap"[\s\S]*?\)\s*\n\s*bootstrap\.refetch\(\)/)
    // the #1289 debounce still guards only server.connected, not the gap
    expect(syncSource).toMatch(/server\.connected"\s*&&\s*Date\.now\(\)\s*-\s*lastConnectedQueueAt/)
  })
})

// #1773 — an unexpected NORMAL end of the global stream is a gap too (defense in
// depth: kept even once replay exists). The relay chain now error-closes every
// loss, but a clean end the client did not ask for still means events may have
// been dropped. The decision (`createStreamEndResync`, stream-liveness.ts) is
// unit-tested there; these pins assert the loop actually wires it — falsifiable:
// deleting either call, or reporting the end without the abort/stop state, reds.
describe("#1773 — an unexpected end of the global stream advances the forced-resync signal", () => {
  const sdkSource = readFileSync(join(import.meta.dir, "server-sdk.tsx"), "utf8")
  const loop = sdkSource.indexOf("for await (const event of events)")
  const loopCatch = sdkSource.indexOf("} catch (error) {", loop)

  test("the loop's NORMAL completion (the iterator ended without throwing) reports the end", () => {
    expect(loop).toBeGreaterThan(0)
    const body = sdkSource.slice(loop, loopCatch)
    // after the for-await body's last statement and before the catch: the normal-end path
    const afterLoop = body.slice(body.lastIndexOf("await wait(0)"))
    expect(afterLoop).toContain("streamEndResync.ended(")
  })

  test("a user stop / page hide / the client's own abort are NOT a loss: the end carries both states", () => {
    const body = sdkSource.slice(loop, loopCatch)
    expect(body).toMatch(/attemptAborted:\s*currentAttempt\.signal\.aborted/)
    // stopped = the root abort (teardown), the started latch (stop()/pagehide), the generation fence (reset)
    expect(body).toMatch(/stopped:\s*abort\.signal\.aborted\s*\|\|\s*!started\s*\|\|\s*!streamGeneration\.accepts\(active\)/)
  })

  test("the reconnected stream's first frame advances the forced-resync signal (the transcript + entity rail refetch)", () => {
    const body = sdkSource.slice(loop, loopCatch)
    expect(body).toMatch(/if \(streamEndResync\.frame\(\)\) setResyncCount\(\(n\) => n \+ 1\)/)
    // the signal the transcript (pages/session.tsx) and the entity rail read
    expect(sdkSource).toMatch(/resyncCount,\s*\n/)
  })
})

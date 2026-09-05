// Issue #817 — D2 wiring: the persisted session snapshot ("session:snapshot",
// a render accelerator never an authority) is verified against the
// client-derived currency token on every list response and overwritten by it,
// so the #293 stale-storage shape self-heals on boot with zero manual action.
// Source-pinned per the repo's overlay-wiring idiom; the decision core is
// behavior-tested in session_snapshot_817.test.ts.
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const overlay = (...p: string[]) => join(__dirname, "../../app-bundle/overlay/packages/app/src", ...p)
const src = (p: string) => readFileSync(overlay(p), "utf8")

describe("persisted snapshot lifecycle (D2: boot self-heal, no filesystem surgery)", () => {
  test("child stores persist a per-workspace session:snapshot target", () => {
    const childStore = src("context/global-sync/child-store.ts")
    expect(childStore).toContain('"session:snapshot"')
    expect(childStore).toMatch(/snapshotCache/)
  })

  test("hydration is gated on sessions_fetched — a real fetch always outranks the snapshot", () => {
    const childStore = src("context/global-sync/child-store.ts")
    expect(childStore).toMatch(/sessions_fetched[\s\S]{0,200}cached\.sessions/)
  })

  test("every list response verifies the snapshot against the derived token and overwrites it", () => {
    const s = src("context/server-sync.tsx")
    expect(s).toContain("bootCurrencyDecision")
    expect(s).toMatch(/bootCurrencyDecision\(\{[\s\S]{0,400}writeSessionSnapshot/)
    // The decision reads the persisted snapshot through the child-store seam.
    expect(s).toMatch(/sessionSnapshot\(directory\)/)
  })

  test("the reset invalidates all snapshots (session:snapshot is a session cache)", () => {
    const s = src("context/server-sync.tsx")
    expect(s).toMatch(/resetSessionCaches\(\)[\s\S]{0,1600}resetSessionSnapshots\(\)/)
  })

  test("the server-reported version rides the SDK context for the token stamp", () => {
    const s = src("context/server-sdk.tsx")
    expect(s).toMatch(/const version = \(\) =>/)
    expect(s).toContain("checkServerHealth")
  })

  test("server-sync stamps tokens with the server-reported version", () => {
    const s = src("context/server-sync.tsx")
    expect(s).toMatch(/serverVersion: (await |)serverSDK\.version\(\)/)
  })
})

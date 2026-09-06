// Issue #817 — D2 wiring (spec spec-20260905-045114-session-device-lifecycle):
// the honest states and the in-product reset ride the overlay's sync stores.
// The overlay's Solid components can't run headless under vitest, so the
// wiring is pinned at source level (the repo's established idiom — see
// titlebar_dblclick_close.test.ts) and every behavioral core is imported and
// executed in its own test file.
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const overlay = (...p: string[]) => join(__dirname, "../../app-bundle/overlay/packages/app/src", ...p)
const src = (p: string) => readFileSync(overlay(p), "utf8")

describe("sessions_fetched flag (D2: a completed list fetch is the only authority for 'empty')", () => {
  const types = () => src("context/global-sync/types.ts")
  const childStore = () => src("context/global-sync/child-store.ts")
  const serverSync = () => src("context/server-sync.tsx")

  test("the child-store state carries the flag", () => {
    expect(types()).toContain("sessions_fetched")
  })

  test("new stores start unfetched", () => {
    expect(childStore()).toMatch(/sessions_fetched: false/)
  })

  test("the early-return path (cached store) flips the flag too", () => {
    const s = serverSync()
    // The cached-store branch reconciles + sets the flag inside one batch.
    expect(s).toMatch(/if \(!store\.sessions_fetched\) setStore\("sessions_fetched", true\)/)
  })

  test("the fetch path flips the flag when the fetch resolves (even to empty)", () => {
    const s = serverSync()
    expect(s).toMatch(/setStore\("sessions_fetched", true\)/)
  })
})

describe("in-product reset (D2: recovery never destroys configuration)", () => {
  test("the sync exposes resetSessionCaches on the project API", () => {
    const s = src("context/server-sync.tsx")
    expect(s).toContain("resetSessionCaches()")
    // It clears the in-memory session fields…
    expect(s).toMatch(/resetSessionCaches\(\)[\s\S]{0,600}setStore\("session", reconcile\(\[\]/)
    // …the per-directory fetch bookkeeping…
    expect(s).toMatch(/resetSessionCaches\(\)[\s\S]{0,600}sessionMeta\.clear\(\)/)
    // …and the session-list query keys.
    expect(s).toMatch(/resetSessionCaches\(\)[\s\S]{0,1200}"loadSessions"/)
  })

  test("the command is registered in the layout", () => {
    const s = src("pages/layout.tsx")
    expect(s).toContain('id: "panel.reset"')
    expect(s).toMatch(/id: "panel\.reset"[\s\S]{0,300}resetSessionCaches\(\)/)
  })

  test("every overlay locale carries the command label", () => {
    const locales = ["en", "ar", "br", "bs", "da", "de", "es", "fr", "ja", "ko", "no", "pl", "ru", "th", "tr", "uk", "zh", "zht"]
    for (const locale of locales) {
      const dict = src(`i18n/${locale}.ts`)
      expect(dict, `i18n/${locale}.ts`).toContain('"command.panel.reset"')
    }
  })

  test("the reset never touches persisted workspace preference stores", () => {
    const s = src("context/server-sync.tsx")
    const reset = s.slice(s.indexOf("resetSessionCaches()"), s.indexOf("resetSessionCaches()") + 1600)
    // No persisted-store writes in the reset's body: no `persist(`, no vcs,
    // no project-meta, no icon targets.
    expect(reset).not.toMatch(/persist\(/)
    expect(reset).not.toMatch(/vcsCache/)
    expect(reset).not.toMatch(/metaCache\.get|iconCache\.get/)
  })
})

describe("sessions dropdown honest states (D2: never render empty while unfetched)", () => {
  test("the dropdown routes through sessionListState and shows loading while unfetched", () => {
    const s = src("components/session/session-header.tsx")
    expect(s).toContain('from "@/utils/session-list-state"')
    expect(s).toMatch(/sessionListState\(\{/)
    expect(s).toMatch(/activeListState\(\) === "unfetched"\s*\n?\s*\?\s*language\.t\("common\.loading"\)/)
  })
})

import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

// amicode#964 — the pre-sync guard.
//
// The fork→overlay sync (overlay-sync.mjs, the ff7b69c8 family) treats the
// fork as authoritative for every file it copies — including files where
// amicode fixed what the fork never had. ff7b69c8 regressed #929's 3-arg
// translate callback that way (every non-shell composer render threw "n is
// not a function"); Aaron hit it live post-cutover 2026-09-10. The
// amicode-fixes-are-canonical rule now lives in the shared module
// packages/app-bundle/scripts/known_fixes.mjs, which overlay-sync.mjs enforces
// at sync time (#842) and deploy_guard.mjs enforces at deploy time. This test
// is the SOURCE OF RECORD for the fixture list and still asserts the overlay's
// KNOWN-FIXED hunks are present: if a future edit or sync reverts one, the
// suite fails naming the fix and the regressing sync.
//
// Extensible as fixes accumulate: add a fixture (file, hunk signature,
// fix reference). The mirrored fork branch (harmoniqs/opencode 964-mirrors →
// local/amicode) carries the same hunks so the next sync brings the FIX, not
// the regression.

const OVERLAY_APP = join(__dirname, "..", "..", "app-bundle", "overlay", "packages", "app", "src")

type KnownFix = {
  fix: string
  file: string
  signature: RegExp
}

const LOCALE_SKIP = new Set(["desktop-native.ts", "parity.test.ts"])

const KNOWN_FIXED_HUNKS: KnownFix[] = [
  {
    fix: "#929 (59b447e7) — the v2 composer's design placeholder takes the translate callback",
    file: "components/prompt-input-v2.tsx",
    signature: /promptDesignPlaceholder\(\s*mode\(\),\s*placeholder\(\),/,
  },
  {
    fix: "#832 (faac5bdf) — the session-cache diff_version reconciliation shape",
    file: "context/global-sync/session-cache.ts",
    signature: /diff_version: Record<string, number \| undefined>/,
  },
  {
    fix: "#832 (faac5bdf) — the session-cache diff_version guarded delete",
    file: "context/global-sync/session-cache.ts",
    signature: /delete store\.diff_version\[sessionID\]/,
  },
  {
    fix: "#832 (872a5218) — session.exportTrace restored in the non-English app locales",
    file: "i18n/<every locale dict>",
    signature: /"session\.exportTrace"/,
  },
]

function localeFiles(): string[] {
  return readdirSync(join(OVERLAY_APP, "i18n"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !LOCALE_SKIP.has(f))
    .sort()
}

function checkFix(fix: KnownFix): { path: string; ok: boolean }[] {
  if (fix.file === "i18n/<every locale dict>") {
    return localeFiles().map((f) => {
      const source = readFileSync(join(OVERLAY_APP, "i18n", f), "utf8")
      return { path: `i18n/${f}`, ok: fix.signature.test(source) }
    })
  }
  const source = readFileSync(join(OVERLAY_APP, fix.file), "utf8")
  return [{ path: fix.file, ok: fix.signature.test(source) }]
}

describe("the overlay's known-fixed hunks (the pre-sync guard, #964)", () => {
  test("no fork→overlay sync has reverted an amicode-side fix", () => {
    const regressed: string[] = []
    for (const fix of KNOWN_FIXED_HUNKS) {
      for (const { path, ok } of checkFix(fix)) {
        if (!ok) {
          regressed.push(
            `KNOWN-FIX REGRESSED in ${path}: ${fix.fix}. A fork→overlay sync (the ff7b69c8 family) ` +
              `overwrote an amicode-side fix — restore it from the overlay before rebuilding the ` +
              `dist-app, and make sure the fork (local/amicode) carries the fix so the next sync ` +
              `brings it back instead of the regression. See harmoniqs/amicode#964.`,
          )
        }
      }
    }
    expect(regressed, `\n\n${regressed.join("\n\n")}\n`).toEqual([])
  })

  test("the guard's locale sweep actually covers the non-English dicts", () => {
    // the exportTrace fixture is only meaningful if it runs over the locales
    // #832 restored — if the overlay grows or shrinks its locale set, this
    // catches a sweep gone silently empty.
    const locales = localeFiles()
    expect(locales.length).toBeGreaterThanOrEqual(17)
    expect(locales).toContain("ar.ts")
    expect(locales).toContain("de.ts")
    expect(locales).toContain("zht.ts")
  })
})

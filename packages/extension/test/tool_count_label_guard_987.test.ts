import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { transpileModule } from "typescript"

// amicode#987 — the tool-count-label i18n guard.
//
// The hub panel (production, #955 cutover smoke) threw
// `TypeError: Cannot read properties of undefined (reading 'startsWith')`
// on cold page load, restart-masked. Mechanism: the base
// session-ui/src/components/tool-count-label.tsx renders via
// split(i18n.t(...)) — when the i18n dict hasn't loaded yet (async resource)
// or a key is missing, i18n.t(...) returns undefined; split(undefined)
// coerced through /{{\s*count\s*}}/.exec(undefined) → no match →
// {before: "", after: undefined} → the memos' one().after.startsWith(...)
// threw inside a Solid effect.
//
// The fix is an overlay twin of the base file with splitCountLabel() guarded against
// falsy text ({before: "", after: ""} — honest empty render until the
// translation exists, the language.tsx fallback discipline).
//
// Two layers, the #964 contract/source pattern (no render harness in the app):
//   1. source contract — the twin exists, is registered in the app-bundle
//      manifest (drift-gate invariant), and carries the guarded split;
//   2. behavior — the twin's ACTUAL split/common code (extracted from the
//      file, not a copy) never throws for undefined translations, and the
//      memo derivations that threw in production hold for missing keys.
// Layer 2 doubles as the fork→overlay-sync guard: the sync treats the fork
// as authoritative for session-ui files, so a sync that reverts the twin's
// guard fails here naming the fix (mirror the fix to the fork's
// local/amicode branch per #964 so the next sync brings the fix, not the
// regression).

const APP_BUNDLE = join(__dirname, "..", "..", "app-bundle")
const TWIN = join(
  APP_BUNDLE,
  "overlay",
  "packages",
  "session-ui",
  "src",
  "components",
  "tool-count-label.tsx",
)

// ── extract the real helper functions from the twin's source ────────────────

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `function ${name} not found in the twin`).toBeGreaterThanOrEqual(0)
  let depth = 0
  let i = source.indexOf("{", start)
  const bodyStart = i
  while (i < source.length) {
    if (source[i] === "{") depth++
    if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
    i++
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

function evalHelpers(source: string) {
  // splitCountLabel and common are pure (no imports) — transpile the twin's verbatim
  // function text so the test exercises THE file, not a re-typed copy.
  const code = `${extractFunction(source, "splitCountLabel")}\n${extractFunction(source, "common")}\nreturn { split: splitCountLabel, common }`
  const js = transpileModule(code, { compilerOptions: { target: 99 /* Latest */ } }).outputText
  return new Function(js)() as {
    split: (text: string | undefined) => { before: string; after: string }
    common: (one: string, other: string) => { stem: string; one: string; other: string }
  }
}

// ── the memo derivations that threw in production, reconstructed ────────────
// Mirrors the component's createMemo chain exactly (one/other/active from
// split(t(...)), suffix/splitSuffix from the .after strings) so a missing-key
// render path runs for real.

type SplitResult = { before: string; after: string }

function memoDerivations(t: (key: string) => string | undefined, category: () => string) {
  const helpers = evalHelpers(readFileSync(TWIN, "utf8"))
  const one = (): SplitResult => helpers.split(t("ui.sessionTurn.diffs.changed.one"))
  const other = (): SplitResult => helpers.split(t("ui.sessionTurn.diffs.changed.other"))
  const active = (): SplitResult => helpers.split(t(`ui.sessionTurn.diffs.changed.${category()}`))
  const suffix = () => helpers.common(one().after, other().after)
  const splitSuffix = () =>
    (category() === "one" || category() === "other") &&
    one().before === other().before &&
    (one().after.startsWith(other().after) || other().after.startsWith(one().after))
  const before = () => (splitSuffix() ? one().before : active().before)
  const stem = () => (splitSuffix() ? suffix().stem : active().after)
  const tail = () => {
    if (!splitSuffix()) return ""
    if (category() === "one") return suffix().one
    return suffix().other
  }
  return { one, other, active, suffix, splitSuffix, before, stem, tail }
}

describe("tool-count-label i18n guard (#987)", () => {
  test("the overlay twin exists and is the registered fix (manifest + guard shape)", () => {
    const source = readFileSync(TWIN, "utf8")
    expect(source).toContain("function splitCountLabel(text?: string)")
    expect(source).toContain('const value = text ?? ""')
    expect(source).toContain("startsWith")
  })

  test("the twin is registered in the app-bundle manifest at its exact hash", () => {
    const manifest = JSON.parse(readFileSync(join(APP_BUNDLE, "manifest.json"), "utf8"))
    const key = "packages/session-ui/src/components/tool-count-label.tsx"
    const hash = manifest.files?.[key]
    expect(hash, "twin missing from manifest.files — re-run refresh_manifest.mjs").toBeTruthy()
    const actual = createHash("sha256").update(readFileSync(TWIN)).digest("hex")
    expect(actual).toBe(hash)
  })

  test("split() returns the empty render for undefined and empty translations", () => {
    const { split } = evalHelpers(readFileSync(TWIN, "utf8"))
    expect(split(undefined)).toEqual({ before: "", after: "" })
    expect(split("")).toEqual({ before: "", after: "" })
  })

  test("split() still interpolates real translations unchanged", () => {
    const { split } = evalHelpers(readFileSync(TWIN, "utf8"))
    expect(split("Changed {{count}} files")).toEqual({ before: "Changed ", after: " files" })
    expect(split("Changed files")).toEqual({ before: "", after: "Changed files" })
    expect(split("{{count}}")).toEqual({ before: "", after: "" })
  })

  test("the memo chain never throws for a missing key (undefined t) — the production crash path", () => {
    const t = () => undefined
    for (const category of ["one", "other", "few", "many", "zero", "two"]) {
      const m = memoDerivations(t, () => category)
      expect(() => [m.one(), m.other(), m.active(), m.suffix(), m.splitSuffix(), m.before(), m.stem(), m.tail()]).not.toThrow()
      expect(m.one()).toEqual({ before: "", after: "" })
      expect(m.other()).toEqual({ before: "", after: "" })
      expect(m.active()).toEqual({ before: "", after: "" })
      // empty after-strings make "".startsWith("") true, so splitSuffix is
      // still true for one/other — but every derived string stays "" (the
      // honest empty render; the OLD unguarded split threw here instead).
      expect(m.before()).toBe("")
      expect(m.stem()).toBe("")
      expect(m.tail()).toBe("")
      expect(m.splitSuffix()).toBe(category === "one" || category === "other")
    }
  })

  test("the memo chain still splits real translations (the loaded-dict path)", () => {
    const dict: Record<string, string> = {
      "ui.sessionTurn.diffs.changed.one": "Changed {{count}} file",
      "ui.sessionTurn.diffs.changed.other": "Changed {{count}} files",
    }
    const m = memoDerivations((k) => dict[k], () => "other")
    expect(m.one()).toEqual({ before: "Changed ", after: " file" })
    expect(m.other()).toEqual({ before: "Changed ", after: " files" })
    expect(m.splitSuffix()).toBe(true)
    expect(m.before()).toBe("Changed ")
    expect(m.stem()).toBe(" file")
    expect(m.tail()).toBe("s")
  })
})

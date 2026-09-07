// S3 (spec-20260907-011500 D3, #860) — the subagent model-routing settings
// section's view-model, headless under vitest (the #848/#859 pattern).
// Covers: the defensive body parse, the provenance chip mapping (unknown
// tier never renders a wrong provenance), the drift display tuple, and the
// settings i18n parity for the section's keys across all 18 locales (the
// app-overlay gate, run extension-side so CI executes it).
import { describe, expect, test } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { provenanceKey, routingBodyView, rowDisplay, type RoutingBodyView } from "../../app-bundle/overlay/packages/app/src/components/subagent-routing"

const body = (over: Record<string, unknown> = {}) => ({
  ok: true,
  roles: [
    {
      role: "implementer",
      classes: ["workhorse"],
      hand_set_model: null,
      effective: { outcome: "inherit", model: null, tier: "default", reason: "no routing configured", announcement: null },
      suggestion: { model: "anthropic/claude-sonnet-4-5", cls: "workhorse" },
      chain: [],
      drift: { drifted: false, tuned_model: null },
    },
  ],
  opt_in: false,
  providers: ["anthropic"],
  snapshot_refreshed_at: "2026-09-07T12:00:00.000Z",
  seats: { tuned: false, fleet: false },
  ...over,
})

describe("routingBodyView — the defensive parse", () => {
  test("404 / non-object / not-ok / roles-not-array → the view does not exist", () => {
    for (const raw of [undefined, null, "nope", [], { ok: false }, body({ roles: "x" })]) {
      expect(routingBodyView(raw).exists).toBe(false)
    }
  })

  test("a good body parses verbatim; snake_case wire fields read camel-side", () => {
    const v = routingBodyView(body())
    expect(v.exists).toBe(true)
    expect(v.roles).toHaveLength(1)
    expect(v.roles[0]!.role).toBe("implementer")
    expect(v.roles[0]!.classes).toEqual(["workhorse"])
    expect(v.roles[0]!.handSetModel).toBeNull()
    expect(v.optIn).toBe(false)
    expect(v.providers).toEqual(["anthropic"])
    expect(v.snapshotRefreshedAt).toBe("2026-09-07T12:00:00.000Z")
    expect(v.seats).toEqual({ tuned: false, fleet: false })
  })

  test("off-shape rows are dropped, never guessed into a row; off-shape fields read safe", () => {
    const v = routingBodyView(
      body({
        roles: [
          "junk",
          null,
          { role: "", suggestion: "junk" },
          {
            role: "analyzer",
            classes: ["strongest-reasoner", 42],
            effective: { outcome: "model", model: "zai/glm-5.3", tier: "fleet-locked" },
            suggestion: { model: "zai/glm-5.3" },
            drift: "junk",
            chain: [{ tier: 5 }, { tier: "tuned", model: "zai/glm-5.3", state: "accepted", reason: "r" }],
          },
        ],
      }),
    )
    expect(v.roles).toHaveLength(1)
    const row = v.roles[0]!
    expect(row.role).toBe("analyzer")
    expect(row.classes).toEqual(["strongest-reasoner"])
    expect(row.effective.outcome).toBe("model")
    expect(row.effective.tier).toBe("fleet-locked")
    expect(row.drift).toEqual({ drifted: false, tuned_model: null })
    expect(row.chain).toEqual([{ tier: "default", model: "", state: "skipped", reason: "" }, { tier: "tuned", model: "zai/glm-5.3", state: "accepted", reason: "r" }])
    expect(row.suggestion).toEqual({ model: "zai/glm-5.3", cls: null })
  })

  test("providers not-array reads null (unknown), never an empty lie", () => {
    expect(routingBodyView(body({ providers: "x" })).providers).toBeNull()
    expect(routingBodyView(body({ providers: null })).providers).toBeNull()
  })
})

describe("provenance chips + the drift display tuple", () => {
  test("the five provenance classes map to their chips; unknown reads default (never a wrong provenance)", () => {
    for (const tier of ["user-set", "fleet-locked", "tuned", "suggested", "default"]) {
      expect(provenanceKey(tier)).toBe(`settings.subagents.provenance.${tier}`)
    }
    expect(provenanceKey("mystery")).toBe("settings.subagents.provenance.default")
  })

  test("rowDisplay: inherit rows show the inherit label; drifted rows show drift + reset", () => {
    const parsed = routingBodyView(body()) as RoutingBodyView
    const d = rowDisplay(parsed.roles[0]!)
    expect(d).toEqual({ label: "", provenance: "settings.subagents.provenance.default", showDrift: false, showReset: false })
    const driftRow = routingBodyView(
      body({
        roles: [
          {
            role: "implementer",
            classes: [],
            hand_set_model: null,
            effective: { outcome: "model", model: "openai/gpt-5", tier: "user-set", reason: "r", announcement: null },
            suggestion: null,
            chain: [],
            drift: { drifted: true, tuned_model: "zai/glm-5.3" },
          },
        ],
      }),
    ).roles[0]!
    expect(rowDisplay(driftRow)).toEqual({
      label: "openai/gpt-5",
      provenance: "settings.subagents.provenance.user-set",
      showDrift: true,
      showReset: true,
    })
  })
})

// The i18n parity gate, extension-side so CI runs it (the app-bundle parity
// test is bun:tesst + skipIf(CI)): every settings.subagents.* key in en.ts
// exists in all 17 other app locales, and no locale carries extras.
const EN_PATH = join(__dirname, "../../app-bundle/overlay/packages/app/src/i18n/en.ts")
const I18N_DIR = join(__dirname, "../../app-bundle/overlay/packages/app/src/i18n")
const APP_LOCALES = ["ar", "br", "bs", "da", "de", "es", "fr", "ja", "ko", "no", "pl", "ru", "uk", "th", "tr", "zh", "zht"]

const keysOf = (file: string): Set<string> => {
  const text = readFileSync(file, "utf8")
  const keys = [...text.matchAll(/^\s*"([^"]+)":/gm)].map((m) => m[1]!)
  return new Set(keys)
}

describe("settings.subagents i18n parity (×18, the app-overlay gate)", () => {
  const en = keysOf(EN_PATH)
  const section = [...en].filter((k) => k.startsWith("settings.subagents."))
  test("the section's keys are non-empty (the gate can never go vacuous)", () => {
    expect(section.length).toBeGreaterThanOrEqual(12)
  })
  test.each(APP_LOCALES)("%s carries every settings.subagents.* key — no missing, no extras", (locale) => {
    const target = keysOf(join(I18N_DIR, `${locale}.ts`))
    const missing = section.filter((k) => !target.has(k))
    const extra = [...target].filter((k) => k.startsWith("settings.subagents.") && !en.has(k))
    expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] })
  })
})

// strategy_brief tests — living-sota slice 6 (spec-20260905 D6; amicode #1310).
//
// The pins that matter: DETERMINISM (same inputs → same bytes), DEGRADATION
// (a broken ledger is a named anomaly, never a silent drop; a missing receipt
// renders unknowns), the TIER JOIN (mapped campaigns render under their
// direction, tier-ordered; unmapped render after), and the HEALTH STAMPS
// (receipt SHA + merged date + age — staleness is in the render).
import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { renderStrategyBrief, parseLedger as parseLedgerFixture } from "../src/strategy_brief.js"

const fixtures = join(import.meta.dirname, "fixtures", "strategy-brief")
const intent = readFileSync(join(fixtures, "intent.md"), "utf8")
const receipt = readFileSync(join(fixtures, "receipt.toml"), "utf8")

const ledgers = readdirSync(join(fixtures, "sessions"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => parseLedgerFixture(f, readFileSync(join(fixtures, "sessions", f), "utf8")))
  .sort((a, b) => (a.file < b.file ? -1 : 1))

const opts = { intentPath: "i", receiptPath: "r", sessionsDir: "s", asOf: "2026-09-20" }

describe("the strategy-brief renderer", () => {
  it("renders deterministically — same inputs, same bytes", () => {
    const a = renderStrategyBrief(opts, intent, receipt, ledgers)
    const b = renderStrategyBrief(opts, intent, receipt, [...ledgers])
    expect(a).toBe(b)
  })

  it("joins campaigns to direction tiers, ordered, unmapped after", () => {
    const brief = renderStrategyBrief(opts, intent, receipt, ledgers)
    const d1 = brief.indexOf("### D1 — Fixture tier-one bet")
    const d5 = brief.indexOf("### D5 — Fixture substrate")
    const unmapped = brief.indexOf("### Unmapped")
    expect(d1).toBeGreaterThanOrEqual(0)
    expect(d5).toBeGreaterThan(d1) // Tier 1 before Tier 3
    expect(unmapped).toBeGreaterThan(d5) // unmapped render after
    expect(brief).toContain("qldpc-sweep-erlich") // mapped to D1
    expect(brief.slice(d1, d5)).toContain("qldpc-sweep-erlich")
    expect(brief.slice(d5, unmapped)).toContain("altissimo-warmstarts")
  })

  it("names anomalies, never drops them", () => {
    const brief = renderStrategyBrief(opts, intent, receipt, ledgers)
    expect(brief).toContain("anomalies (named, never dropped): broken.md")
    expect(brief).toContain("4 found · 3 parsed · 2 unmapped · 1 anomalies")
  })

  it("stamps health from the receipt — SHA, merged date, age in days", () => {
    const brief = renderStrategyBrief(opts, intent, receipt, ledgers)
    expect(brief).toContain("intent: abc123def456 merged 2026-09-06 (age 14d)")
    expect(brief).toContain("Staleness is IN the render.")
  })

  it("degrades a missing receipt to named unknowns", () => {
    const brief = renderStrategyBrief(opts, intent, "", ledgers)
    expect(brief).toContain("merged unknown")
    expect(brief).toContain("intent: unknown merged unknown")
  })

  it("renders an honest empty portfolio", () => {
    const brief = renderStrategyBrief(opts, "no headers, no map", receipt, [])
    expect(brief).toContain("no campaign session-ledgers found")
  })

  it("renders per-campaign fields with named unknowns", () => {
    const brief = renderStrategyBrief(opts, intent, receipt, ledgers)
    expect(brief).toContain("state: paused (warrant renewal)")
    expect(brief).toContain("last loop: unknown") // no last_loop field in fixtures — honest
    expect(brief).toContain("blockers: 1") // one BLOCKED marker in the D1 fixture ledger
  })
})

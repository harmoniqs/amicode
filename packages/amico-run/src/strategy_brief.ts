// The strategy-brief renderer — living-sota slice 6, finally landing
// (spec-20260905-103000 D6; amicode #1310; plan-20260920 step 6).
//
// WHY THIS SHAPE
// --------------
// The D6 transition moved direction into a PI-owned INTENT file and made the
// portfolio a *derivation from campaign session-ledgers ONLY* — "never the
// session DB, never the board". Nothing rendered that composition; this is
// the renderer. One renderer, two paths (D6): the weekly synthesis calls it
// as its header; on-demand renders go through the amico-strategy loader.
//
// DETERMINISM: same inputs → same bytes. The render date is an explicit
// input (`--as-of`), never a hidden clock — the weekly synthesis passes its
// run date; tests pass fixed dates. All parsers are lenient and RETURN,
// never throw: degradation renders NAMED UNKNOWNS (D6's own words), because
// a portfolio that silently drops a broken ledger is a lie with a table in
// it.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ConfigError } from "./types.js";

export interface BriefOptions {
  intentPath: string
  receiptPath: string
  sessionsDir: string
  asOf: string // ISO date (YYYY-MM-DD) — explicit input, never a hidden clock
}

interface Direction {
  id: string // e.g. "D1" — or "none" for non-tiered map entries
  title: string
  tier: number | undefined
  order: number
}

interface Ledger {
  file: string
  label: string | undefined
  title: string | undefined
  status: string | undefined
  lastLoop: string | undefined
  objective: string | undefined
  blockers: number
  parsed: boolean
}

// ── lenient parsers ───────────────────────────────────────────────────────────

/** Parse the campaign→direction map and the D-headers with their tiers.
 *  Lenient: a missing map renders as "no mapped campaigns"; never throws. */
function parseIntent(md: string): { map: Array<{ campaign: string; direction: string }>; directions: Map<string, Direction> } {
  const map: Array<{ campaign: string; direction: string }> = []
  const directions = new Map<string, Direction>()
  let order = 0
  for (const line of md.split("\n")) {
    // ### D1 — QEC pulse-kernel compilation + noise structuring *(Tier 1)*
    const header = line.match(/^###\s+(D\d)\s*[—-]\s*(.+?)\s*(?:\*\(Tier\s*(\d+)\)\*\*)?\s*$/)
    if (header) {
      directions.set(header[1], {
        id: header[1],
        title: header[2],
        tier: header[3] ? Number(header[3]) : undefined,
        order: order++,
      })
      continue
    }
    // | qLDPC code sweep (qec-autoresearch, erlich) | D1 |
    const row = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/)
    if (row && !/^\s*[-: ]+\s*$/.test(row[1]) && !/^Campaign/.test(row[1])) {
      map.push({ campaign: row[1].trim(), direction: row[2].trim() })
    }
  }
  return { map, directions }
}

/** Parse the merge receipt — lenient `key = "value"` lines, known keys only. */
function parseReceipt(toml: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of toml.split("\n")) {
    const m = line.match(/^(\w+)\s*=\s*"?([^"\n]+?)"?\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

/** One ledger, parsed leniently. `parsed === false` marks an ANOMALY (rendered
 *  by name, never dropped). The objective prefers §1's first bullet; the
 *  last-loop boundary reads a `last_loop:` frontmatter field — the honest
 *  unknown until ledgers carry one natively. */
export function parseLedger(file: string, md: string): Ledger {
  const clipped = (s: string | undefined, n: number) =>
    s === undefined ? undefined : s.length > n ? s.slice(0, n - 1) + "…" : s
  const fmBlock = md.split("---")[1] ?? ""
  const fmField = (key: string) => {
    const m = fmBlock.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined
  }
  const titleMatch = md.match(/^#\s+(.+)$/m)
  const objectiveSection = md.match(/^##\s*1\.\s*Objectiv.*$\n([\s\S]*?)(?=^##\s|\z)/m)
  const firstBullet = objectiveSection?.[1].match(/^\s*[-*]\s+(.+)$/m)
  const parsed = titleMatch !== null || fmField("label") !== undefined
  return {
    file,
    label: fmField("label"),
    title: titleMatch?.[1].trim(),
    status: fmField("status"),
    lastLoop: fmField("last_loop"),
    objective: clipped(firstBullet?.[1].trim() ?? titleMatch?.[1].trim(), 110),
    blockers: (md.match(/BLOCKED/g) ?? []).length,
    parsed,
  }
}

// ── the join (D6: render order = tier join over the campaign→direction map) ──

const directionIdOf = (cell: string) => cell.match(/\bD\d\b/)?.[0] ?? "none"

function joinLedgersToDirections(
  ledgers: Ledger[],
  map: Array<{ campaign: string; direction: string }>,
) {
  const groups = new Map<string, Ledger[]>()
  for (const ledger of ledgers) {
    const haystack = `${ledger.label ?? ""} ${ledger.title ?? ""}`.trim().toLowerCase()
    const row = haystack.length === 0 ? undefined : map.find((r) => {
      const needle = r.campaign.toLowerCase()
      // the map's campaign cell names the campaign loosely (e.g. "qLDPC code
      // sweep (qec-autoresearch, erlich)") — match if either side contains
      // the other's leading phrase, on the first ~5 words (enough for the
      // map's style, lenient by design)
      const head = needle.split(/\s*[(—-]/)[0].split(/\s+/).slice(0, 5).join(" ")
      return haystack.includes(head) || needle.includes(haystack)
    })
    const id = row ? directionIdOf(row.direction) : "unmapped"
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id)!.push(ledger)
  }
  return groups
}

// ── the render (pure: same inputs → same bytes) ──────────────────────────────

export function renderStrategyBrief(opts: BriefOptions, intent: string, receipt: string, ledgers: Ledger[]): string {
  const { map, directions } = parseIntent(intent)
  const stamps = parseReceipt(receipt)
  const groups = joinLedgersToDirections(ledgers, map)

  const anomalies = ledgers.filter((l) => !l.parsed)
  const mapped = [...groups.keys()].filter((k) => k !== "unmapped" && k !== "none").length
  const ageDays = stamps["merged_date"]
    ? Math.max(0, Math.round((Date.parse(opts.asOf) - Date.parse(stamps["merged_date"])) / 86_400_000))
    : undefined

  const lines: string[] = []
  lines.push(`# Strategy brief — rendered ${opts.asOf}`)
  lines.push("")
  lines.push("> The composition (spec D6): intent × portfolio. The portfolio folds from campaign")
  lines.push("> session-ledgers ONLY — never the session DB, never the board. Staleness is IN the render.")
  lines.push("")
  lines.push("## Direction surface (health)")
  lines.push("")
  lines.push(
    `- intent: ${(stamps["intent_sha256"] ?? "unknown").slice(0, 12)} merged ${
      stamps["merged_date"] ?? "unknown"
    }${ageDays === undefined ? "" : ` (age ${ageDays}d)`} — source: the merge receipt (git history is not mount-visible)`,
  )
  lines.push(
    `- ledgers: ${ledgers.length} found · ${ledgers.length - anomalies.length} parsed · ${groups.get("unmapped")?.length ?? 0} unmapped · ${anomalies.length} anomalies`,
  )
  if (anomalies.length > 0) {
    lines.push(`- anomalies (named, never dropped): ${anomalies.map((l) => l.file).join(", ")}`)
  }
  lines.push("")

  const groupOrder = (id: string) => {
    const d = directions.get(id)
    return d === undefined ? 99 : d.tier ?? 90
  }
  const sortedIds = [...groups.keys()].sort((a, b) => groupOrder(a) - groupOrder(b))

  lines.push("## Portfolio (campaign session-ledgers only)")
  lines.push("")
  for (const id of sortedIds) {
    const members = groups.get(id)!
    if (id === "unmapped" || id === "none") {
      lines.push(`### ${id === "unmapped" ? "Unmapped (render after — no direction order)" : "Deliberately unmapped"}`)
    } else {
      const d = directions.get(id)!
      lines.push(`### ${d.id} — ${d.title}${d.tier === undefined ? "" : ` *(Tier ${d.tier})*`}`)
    }
    lines.push("")
    for (const ledger of members.sort((a, b) => (a.file < b.file ? -1 : 1))) {
      lines.push(
        `- **${ledger.label ?? ledger.title ?? ledger.file}** — ${ledger.objective ?? "objective: unknown"} · state: ${
          ledger.status ?? "unknown"
        } · last loop: ${ledger.lastLoop ?? "unknown"} · blockers: ${ledger.blockers}`,
      )
    }
    lines.push("")
  }
  if (sortedIds.length === 0) {
    lines.push("_(no campaign session-ledgers found — the portfolio is empty, honestly)_")
    lines.push("")
  }
  lines.push(`_directions with mapped campaigns: ${mapped}; map rows: ${map.length}_`)
  lines.push("")
  return lines.join("\n")
}

// ── the CLI verb ───────────────────────────────────────────────────────────────

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
}

export function strategyBriefCommand(argv: string[]): number {
  const opsCheckout = process.env["AMICO_OPS_CHECKOUT"] ?? join(process.env["HOME"] ?? "", "harmoniqs", "amicissimo")
  const intentPath = flagValue(argv, "--intent") ?? join(opsCheckout, "vault", "INTENT.md")
  const receiptPath = flagValue(argv, "--receipt") ?? join(opsCheckout, "vault", "INTENT-MERGE-RECEIPT.toml")
  const sessionsDir = flagValue(argv, "--sessions") ?? join(process.env["HOME"] ?? "", ".amico", "vaults", "vault-aaron", "sessions")
  const asOf = flagValue(argv, "--as-of") ?? new Date().toISOString().slice(0, 10)
  const out = flagValue(argv, "--out")

  for (const [label, path] of [["--intent", intentPath], ["--sessions", sessionsDir]] as const) {
    if (!existsSync(path)) {
      console.error(`amico-run strategy-brief: ${label} not found: ${path} — pass it explicitly or fix the default`)
      return 64
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`amico-run strategy-brief: --as-of must be YYYY-MM-DD (got: ${asOf}) — the render date is an explicit input`)
    return 64
  }

  const intent = readFileSync(intentPath, "utf8")
  const receipt = existsSync(receiptPath) ? readFileSync(receiptPath, "utf8") : "" // missing receipt → named unknowns
  const ledgers: Ledger[] = []
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith(".md") || entry === "SESSION-INDEX.md" || entry === "CHECKOUTS.md") continue
    const p = join(sessionsDir, entry)
    if (!isAbsolute(p)) continue
    ledgers.push(parseLedger(entry, readFileSync(p, "utf8")))
  }
  ledgers.sort((a, b) => (a.file < b.file ? -1 : 1))

  const brief = renderStrategyBrief({ intentPath, receiptPath, sessionsDir, asOf }, intent, receipt, ledgers)
  if (out === undefined) {
    console.log(brief)
  } else {
    writeFileSync(out, brief)
    console.error(`amico-run strategy-brief: wrote ${out}`)
  }
  return 0
}

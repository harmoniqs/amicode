// AMICODE (issue #658): the campaign-ledger section parser + the campaign
// route bodies (GET /amicode/campaigns, GET /amicode/campaign).
//
// Ground truth is the personal vault's sessions/ dir: session ledgers written
// by live agents in a stable nine-section grammar (§1 objective/directives,
// §2 verdict table, §3 active work, §4 blocked, §5 next queue, §6 checkout
// topology, §7 gotchas, §8 loop log, §9 compaction). The parser is a
// MECHANICAL projection of that grammar — split on the `## N.` numbered
// headers, parse §2/§8's markdown tables — no agent authoring, no LLM.
//
// node: builtins only (fs/path/os) — the amicode_service sibling rule
// (vaults.ts / problems.ts neighborhood; no YAML/markdown dependency: the
// frontmatter is key: value scalars parsed regex-lite, like stack_state.ts's
// parseMarker). Same never-reject discipline as the rest of the service:
// body-builders return JSON strings and collapse every failure into the
// route's one success shape.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { listMounts } from "./vaults"
import { browseAllowed, mountBrowseRefusal } from "./vault_browser"

// ── Grammar ───────────────────────────────────────────────────────────────────

/** A parsed section table row: trimmed cell values, leading/trailing pipes
 *  dropped, `| --- |` separator rows excluded. */
export type TableRow = string[]

export interface ParsedLedger {
  /** Raw `key: value` scalars from the `---` frontmatter block (quotes
   *  stripped; list values kept as their raw `[a, b]` text). Empty when the
   *  file has no (or an unterminated) frontmatter block. */
  frontmatter: Record<string, string>
  /** §1 body, trimmed ("" when §1 absent). The list route renders its first
   *  non-empty line; the drill-down gets the whole section. */
  objective: string
  /** §2's markdown-table rows (verdict table / hypothesis ledger — the title
   *  varies across ledgers, the table is the constant). Header row first when
   *  the table has one; separator rows never included. */
  verdicts: TableRow[]
  /** §3 body, trimmed. */
  activeWork: string
  /** §4 body, trimmed ("" when the section is missing). */
  blocked: string
  /** §5 body, trimmed ("" when the section is missing). */
  nextQueue: string
  /** §8's loop log, bounded to the last WINDOW_LOOP_LOG_ROWS table rows (or,
   *  for a non-table §8, the last WINDOW_LOOP_LOG_LINES non-empty lines) —
   *  append-only logs grow without limit and the digest needs a window, not
   *  the archive. Includes any §9-straddled rows (see below). */
  loopLogTail: string
  /** §9's compaction-log body, trimmed — the non-table part when loop rows
   *  straddled the header. */
  compaction: string
  /** Every `## N.` section number found, ascending. Ledgers in the wild
   *  carry 0–10 sections (a `## §N` variant exists; one real ledger has a
   *  `## 10.` parallel thread before §9; others renumber the grammar). */
  sectionsFound: number[]
}

// The tail-window bound (documented contract): last 10 table rows, or the
// last 40 non-empty lines when §8 isn't a table. 10 loop rows ≈ the last few
// work days of a campaign at the observed cadence; 40 plain lines ≈ the same
// volume for the early ledgers that logged loops as bullets.
export const WINDOW_LOOP_LOG_ROWS = 10
export const WINDOW_LOOP_LOG_LINES = 40

// ── Frontmatter (regex-lite — no YAML dependency in this neighborhood) ───────

/** Split a leading `---` frontmatter block off the text. An unterminated
 *  block (no closing `---`) is NOT frontmatter — the whole text is body.
 *  Malformed lines (no colon) are skipped; values are trimmed with one level
 *  of wrapping double quotes stripped (the grammar's scalar convention). */
export function splitFrontmatter(text: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  if (!text.startsWith("---")) return { frontmatter, body: text }
  const lines = text.split("\n")
  let close = -1
  for (let i = 1; i < lines.length && i <= 64; i++) {
    if (lines[i]?.trim() === "---") {
      close = i
      break
    }
  }
  if (close === -1) return { frontmatter, body: text }
  for (const line of lines.slice(1, close)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const value = m[2]!.trim().replace(/^"(.*)"$/, "$1")
    frontmatter[m[1]!] = value
  }
  return { frontmatter, body: lines.slice(close + 1).join("\n") }
}

// ── Section splitting ─────────────────────────────────────────────────────────

/** The numbered-header grammar: `## N. Title` canonically, with a `## §N
 *  Title` variant in the wild. The number is the identity — section TITLES
 *  drift across ledgers ("Verdict table" vs "Hypothesis ledger", a §6 that is
 *  the loop log) — so matching keys on the title would mis-file content. */
const SECTION_HEADER = /^##\s+§?\s*(\d+)\s*[.):\s]/

/** Split the body into `section number → body` per the `## N.` headers.
 *  Duplicate numbers (never observed, append-only grammar) merge by append.
 *  Unnumbered `##` lines stay inside the section they follow. */
export function splitSections(body: string): { sections: Map<number, string>; sectionsFound: number[] } {
  const sections = new Map<number, string>()
  let current: number | null = null
  for (const line of body.split("\n")) {
    const m = line.match(SECTION_HEADER)
    if (m) {
      current = Number(m[1])
      continue
    }
    if (current !== null) {
      const prev = sections.get(current)
      sections.set(current, prev === undefined ? line : `${prev}\n${line}`)
    }
  }
  const sectionsFound = [...sections.keys()].sort((a, b) => a - b)
  return { sections, sectionsFound }
}

const trimOrEmpty = (text: string | undefined): string => (text ?? "").trim()

// ── Markdown tables ───────────────────────────────────────────────────────────

const isTableLine = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isSeparatorRow = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

/** Trimmed cell values of one table line: split on `|`, drop the empty
 *  leading/trailing cells the boundary pipes leave behind. */
function cells(line: string): string[] {
  const parts = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
  return parts.map((c) => c.trim())
}

/** All table rows in a text block, in order, separator rows excluded. */
export function parseTableRows(text: string): TableRow[] {
  return text
    .split("\n")
    .filter((l) => isTableLine(l) && !isSeparatorRow(l))
    .map(cells)
}

// ── The §9 straddle (append-at-EOF corruption, verified in the wild) ─────────
//
// Some ledgers have §8 loop-log rows appended AFTER the §9 header — the
// appender walked to EOF and the §9 section was already there, so every row
// it appended landed under §9. Grammar-law: §8's table extends to EOF when
// table rows follow §9's header. Mechanic: §9's table lines migrate to §8;
// §9 keeps its non-table content (the "(append-only: …)" template line).

function recoverStraddledLoopLog(sections: Map<number, string>): void {
  const s9 = sections.get(9)
  if (s9 === undefined || !sections.has(8)) return
  const lines = s9.split("\n")
  const tableLines = lines.filter(isTableLine)
  if (tableLines.length === 0) return
  const kept = lines.filter((l) => !isTableLine(l))
  sections.set(9, kept.join("\n"))
  sections.set(8, `${sections.get(8)}\n${tableLines.join("\n")}`)
}

// ── parseLedger ───────────────────────────────────────────────────────────────

export function parseLedger(text: string): ParsedLedger {
  const { frontmatter, body } = splitFrontmatter(text)
  const { sections, sectionsFound } = splitSections(body)
  recoverStraddledLoopLog(sections)

  // Loop-log tail: the bounded window. Table §8 (the canonical grammar) →
  // last WINDOW_LOOP_LOG_ROWS rows; non-table §8 (early ledgers logged loops
  // as bullets) → last WINDOW_LOOP_LOG_LINES non-empty lines.
  const loopBody = sections.get(8) ?? ""
  const loopRows = parseTableRows(loopBody)
  const loopLogTail =
    loopRows.length > 0
      ? loopRows
          .slice(-WINDOW_LOOP_LOG_ROWS)
          .map((row) => `| ${row.join(" | ")} |`)
          .join("\n")
      : loopBody
          .split("\n")
          .filter((l) => l.trim() !== "")
          .slice(-WINDOW_LOOP_LOG_LINES)
          .join("\n")

  return {
    frontmatter,
    objective: trimOrEmpty(sections.get(1)),
    verdicts: parseTableRows(sections.get(2) ?? ""),
    activeWork: trimOrEmpty(sections.get(3)),
    blocked: trimOrEmpty(sections.get(4)),
    nextQueue: trimOrEmpty(sections.get(5)),
    loopLogTail,
    compaction: trimOrEmpty(sections.get(9)),
    sectionsFound,
  }
}

// ── Personal-vault sessions dir (the mount-resolution seam) ──────────────────

/** The personal vault's sessions/ directory, or undefined when no personal
 *  mount is attached. Reuses the vault family's mount resolution (kind-rank
 *  ordering; first kind === "personal") — never a hardcoded path. */
export function personalSessionsDir(root?: string): string | undefined {
  const mount = listMounts(root).find((m) => m.kind === "personal")
  return mount ? path.join(mount.dir, "sessions") : undefined
}

// ── Route bodies ──────────────────────────────────────────────────────────────
// Wire shapes (snake_case, mirroring problems.ts): the parser module's
// camelCase stays in-process; one convention lives at each layer.
//
//   campaigns: { ok, campaigns: [{slug, date, campaign, status, type,
//               objective}], error }
//   campaign:  { ok, campaign: {…list fields…, verdicts, active_work,
//               blocked, next_queue, loop_log_tail, compaction,
//               sections_found, file_date}, error }
//
// Degradation law (issue #658 AC): an empty/missing sessions dir is an empty
// list; a malformed or missing frontmatter degrades to null fields + the
// filename date; a file that cannot be read is skipped. Never a 500.

const err = (code: string, detail: string): string => JSON.stringify({ ok: false, error: `${code}: ${detail}` })

/** §1's first non-empty line — the one-line objective the list renders.
 *  Leading list-bullet markers stripped; capped so one pathological line
 *  can't bloat the digest. */
function objectiveLine(objective: string): string {
  const first = objective.split("\n").find((l) => l.trim() !== "") ?? ""
  return first.trim().replace(/^[-*]\s+/, "").slice(0, 240)
}

/** The YYYYMMDD date embedded in a `session-YYYYMMDD-…` filename, or null. */
function fileDate(slug: string): string | null {
  const m = slug.match(/^session-(\d{4})(\d{2})(\d{2})/)
  if (!m) return null
  return `${m[1]}-${m[2]}-${m[3]}`
}

/** One list entry per `session-*.md` in the dir, newest first (date desc —
 *  frontmatter date, falling back to the filename's embedded date — ties
 *  broken by slug desc). Unreadable files are skipped; frontmatter-less or
 *  malformed ones appear with null fields and the filename date. */
export function campaignsBody(sessionsDir: string | undefined): string {
  if (!sessionsDir || !existsSync(sessionsDir)) return JSON.stringify({ ok: true, campaigns: [], error: null })
  const campaigns: Record<string, unknown>[] = []
  for (const name of readdirSync(sessionsDir).sort()) {
    if (!name.startsWith("session-") || !name.endsWith(".md")) continue
    const slug = name.slice(0, -3)
    let text: string
    try {
      text = readFileSync(path.join(sessionsDir, name), "utf8")
    } catch {
      continue // one unreadable file must not kill the list
    }
    const parsed = parseLedger(text)
    campaigns.push({
      slug,
      date: parsed.frontmatter.date ?? fileDate(slug),
      campaign: parsed.frontmatter.campaign ?? parsed.frontmatter.label ?? null,
      status: parsed.frontmatter.status ?? null,
      type: parsed.frontmatter.type ?? null,
      objective: objectiveLine(parsed.objective),
    })
  }
  campaigns.sort((a, b) => {
    const da = String(a.date ?? ""), db = String(b.date ?? "")
    if (da !== db) return da < db ? 1 : -1 // desc; "" (no date at all) sorts last
    return String(a.slug) < String(b.slug) ? 1 : -1
  })
  return JSON.stringify({ ok: true, campaigns, error: null })
}

/** Slugs are `session-<date>-<name>` file stems: letters, digits, dash,
 *  underscore — nothing that can traverse (`/`, `\`, `..`) and nothing that
 *  reaches a non-ledger file (the guard doubles as the `session-*.md` glob). */
const SLUG_OK = /^session-[A-Za-z0-9_-]+$/

/** One ledger, parsed per the grammar. Unknown slug → `not_found:<slug>`
 *  (the problems.ts 404-shape convention: an ok:false BODY, not an HTTP 404 —
 *  consumers parse one schema per route). */
export function campaignBody(sessionsDir: string | undefined, slug: string | undefined): string {
  if (!slug || slug.trim() === "") return err("bad_request", "missing slug")
  if (!SLUG_OK.test(slug)) return err(`not_found:${slug}`, "no such session ledger")
  const file = path.join(sessionsDir ?? "", `${slug}.md`)
  let text: string
  try {
    text = readFileSync(file, "utf8")
  } catch {
    return err(`not_found:${slug}`, "no such session ledger")
  }
  const parsed = parseLedger(text)
  return JSON.stringify({
    ok: true,
    campaign: {
      slug,
      date: parsed.frontmatter.date ?? fileDate(slug),
      campaign: parsed.frontmatter.campaign ?? parsed.frontmatter.label ?? null,
      status: parsed.frontmatter.status ?? null,
      type: parsed.frontmatter.type ?? null,
      objective: parsed.objective,
      verdicts: parsed.verdicts,
      active_work: parsed.activeWork,
      blocked: parsed.blocked,
      next_queue: parsed.nextQueue,
      loop_log_tail: parsed.loopLogTail,
      compaction: parsed.compaction,
      sections_found: parsed.sectionsFound,
      file_date: fileDate(slug),
    },
    error: null,
  })
}

// ── Cached entrypoints for the routes (never reject; body is a JSON string) ──
// Same shape as problems.ts's cached(): the route binds these; body-builders
// stay injectable for tests. 10 s TTL — ledgers move at loop boundaries, not
// milliseconds, and the digest polls.

const caches = new Map<string, { at: number; body: string }>()
function cached(key: string, build: () => string): string {
  const hit = caches.get(key)
  if (hit && Date.now() - hit.at < 10_000) return hit.body
  let body: string
  try {
    body = build()
  } catch (e) {
    body = err("bad_output", String(e))
  }
  caches.set(key, { at: Date.now(), body })
  return body
}

/** The vault-browser's fail-closed law rides along: session ledgers are
 *  personal-vault content, so a non-loopback server refuses these routes
 *  exactly as /amicode/vault-file does (AMICO_VAULT_BROWSER overrides apply),
 *  and a personal mount whose marker opts out (browse = false) serves nothing.
 *  On the loopback service (the only kind that exists today) both pass and
 *  the routes behave identically to the ungated case. */
function gateRefusal(): string | undefined {
  if (!browseAllowed())
    return err("forbidden", "vault browsing serves loopback servers only (set AMICO_VAULT_BROWSER=1 to override)")
  const mount = listMounts().find((m) => m.kind === "personal")
  if (!mount) return undefined // no personal vault → the builders' empty shapes, not a refusal
  return mountBrowseRefusal(mount.id, mount.dir)
}

export function campaignsResponse(): string {
  return cached("campaigns", () => gateRefusal() ?? campaignsBody(personalSessionsDir()))
}
export function campaignResponse(slug: string | undefined): string {
  return cached(`campaign:${slug ?? "@none"}`, () => gateRefusal() ?? campaignBody(personalSessionsDir(), slug))
}

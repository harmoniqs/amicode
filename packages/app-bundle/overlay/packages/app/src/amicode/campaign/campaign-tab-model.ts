// amicode#694: the Campaign tab's data path — a MECHANICAL projection of the
// campaign routes (#662: GET /amicode/campaigns, GET /amicode/campaign?slug=)
// into the tab's render model, plus the deep-link recognizer for the digest
// tile's click path (#690's widget composes `amico.prompt('Open the campaign '
// + slug)`; the session recognizes that text and opens this tab beside it).
//
// Discipline (the #690 precedent): the model renders what the routes return —
// display compression only (marker stripping, table-cell splitting), no
// ledger-markdown re-parsing, no invented content. All strings are plain data;
// the component renders them through Solid's JSX (auto-escaped — no innerHTML).
// ── Wire shapes (snake_case, mirroring campaign_ledger.ts's route bodies) ────

/** One parsed markdown-table row: trimmed cell values (campaign_ledger.ts). */
export type TableRow = string[]

export interface CampaignSummary {
  slug: string
  date: string | null
  campaign: string | null
  status: string | null
  type: string | null
  objective: string
}

/** GET /amicode/campaign?slug= — the full parsed ledger (campaign_ledger.ts). */
export interface CampaignDetailPayload extends CampaignSummary {
  /** §2's markdown-table rows; row 0 is the header when the table has one. */
  verdicts: TableRow[]
  active_work: string
  blocked: string
  next_queue: string
  loop_log_tail: string
  compaction: string
  sections_found: number[]
  file_date: string | null
}

// ── The deep-link recognizer (the digest tile's click path) ──────────────────

/** The digest tile composes exactly `Open the campaign <slug>`. The slug is a
 *  session file stem (`session-…`): letters, digits, dash, underscore — the
 *  recognizer rejects anything that could traverse or smuggle markup. */
const CAMPAIGN_PROMPT = /^open the campaign\s+([A-Za-z0-9_-]+)\s*$/i

export function campaignPromptSlug(text: string): string | null {
  const match = text.trim().match(CAMPAIGN_PROMPT)
  return match ? (match[1] ?? null) : null
}

// ── Display compression (the digest's mechanical projections, in TS) ─────────

/** Strip list-bullet and bold markers from one ledger line. */
function stripMarkers(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .split("**")
    .join("")
    .trim()
}

/** Non-empty marker-stripped lines of a section body. */
function sectionLines(body: string | undefined): string[] {
  return String(body ?? "")
    .split("\n")
    .map(stripMarkers)
    .filter((line) => line !== "")
}

/** The status cell's leading token — ledgers write `**DONE** — PR #17 merged …`
 *  and the chip shows `DONE`. Same projection as the digest tile's chip label. */
function statusToken(cell: string): string {
  return String(cell ?? "")
    .split("**")
    .join("")
    .split("—")[0]
    ?.split("–")[0]
    ?.trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(" ") ?? ""
}

export type StatusTone = "success" | "danger" | "neutral"

/** The verdict chip tone — token matching, theme-token classes in the component. */
export function statusTone(cell: string): StatusTone {
  const s = String(cell ?? "").toUpperCase()
  if (s.includes("DONE") || s.includes("MERGED") || s.includes("PASS")) return "success"
  if (s.includes("BLOCK") || s.includes("FAIL") || s.includes("STUCK")) return "danger"
  return "neutral"
}

// ── Campaign picking (the digest's rule, shared shape) ───────────────────────

/** Newest ACTIVE campaign; falls back to the newest overall (the list is
 *  newest-first per the route contract, so the first entry wins). */
export function pickCampaign(campaigns: CampaignSummary[]): CampaignSummary | undefined {
  if (campaigns.length === 0) return undefined
  for (const entry of campaigns) {
    if (String(entry.status ?? "").toLowerCase() === "active") return entry
  }
  return campaigns[0]
}

// ── The ledger model ─────────────────────────────────────────────────────────

export interface CampaignVerdict {
  unit: string
  status: string
  /** The status cell verbatim — the ledger's evidence text, shown in full. */
  evidence: string
}

export type LoopLog =
  | { kind: "table"; rows: TableRow[] }
  | { kind: "text"; lines: string[] }

export interface CampaignLedgerModel {
  slug: string
  /** Frontmatter campaign (label fallback), then the slug. */
  label: string
  status: string | null
  date: string | null
  objectiveLines: string[]
  /** §2's header row, verbatim cells (empty when the table has none). */
  verdictColumns: string[]
  verdicts: CampaignVerdict[]
  blockedLines: string[]
  loopLog: LoopLog
  /** False for a null detail or a content-less ledger — the tab's
   *  how-one-starts empty state renders instead. */
  hasLedger: boolean
}

const isTableLine = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line)
const isSeparatorRow = (line: string): boolean =>
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

/** The §8 tail arrives either as re-joined table rows (`| a | b |`, the
 *  bounded window) or as plain lines. Keep the distinction — the tab renders
 *  a real table for the former, a log for the latter. */
function loopLogModel(tail: string | undefined): LoopLog {
  const lines = String(tail ?? "")
    .split("\n")
    .filter((line) => line.trim() !== "")
  if (lines.length > 0 && lines.every(isTableLine)) {
    return { kind: "table", rows: lines.filter((line) => !isSeparatorRow(line)).map(cells) }
  }
  return { kind: "text", lines: lines.map((line) => stripMarkers(line)) }
}

export function campaignLedgerModel(payload: Partial<CampaignDetailPayload> | null | undefined): CampaignLedgerModel {
  const detail = payload ?? {}
  const verdictRows = Array.isArray(detail.verdicts) ? detail.verdicts : []
  // Row 0 is the header when the table has one. The wire can't say whether it
  // does, so the detection is mechanical: a header's cells are bare column
  // names — no bold markers, no em/en-dashes (data rows carry the grammar's
  // `**DONE** — …` status cells). Mirrors the route contract's "header row
  // first when the table has one".
  const header = verdictRows[0]
  const headerLike =
    header !== undefined && header.length >= 2 && header.every((cell) => !/[*—–]/.test(cell))
  const verdictColumns = headerLike ? header : []
  const dataRows = verdictColumns.length > 0 ? verdictRows.slice(1) : verdictRows
  const verdicts: CampaignVerdict[] = dataRows
    .filter((row) => row.length > 0)
    .map((row) => {
      const unit = row[0] ?? ""
      const evidence = row[row.length - 1] ?? ""
      return { unit, status: statusToken(evidence), evidence }
    })

  const objectiveLines = sectionLines(detail.objective)
  const blockedLines = sectionLines(detail.blocked)
  const loopLog = loopLogModel(detail.loop_log_tail)

  const hasLedger =
    objectiveLines.length > 0 || verdicts.length > 0 || blockedLines.length > 0 || loopLogContent(loopLog) > 0

  const slug = String(detail.slug ?? "")
  return {
    slug,
    label: detail.campaign || slug,
    status: detail.status ?? null,
    date: detail.date ?? detail.file_date ?? null,
    objectiveLines,
    verdictColumns,
    verdicts,
    blockedLines,
    loopLog,
    hasLedger: slug !== "" && hasLedger,
  }
}

function loopLogContent(log: LoopLog): number {
  return log.kind === "table" ? log.rows.length : log.lines.length
}

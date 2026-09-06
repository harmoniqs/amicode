// sota_router.ts — the relevance router (#living-sota slice 2, spec
// spec-20260905-103000 D3 / S3): new papers (and, via sota_watcher.ts, watched
// -repo events) match against ACTIVE campaigns — matched items append `stage`
// lines to the matching campaign's SIDECAR staging stream; below-threshold
// matches and no-campaign matches go to the HOPPER stream. A match NEVER
// touches the campaign ledger itself (the nine-section grammar holds
// unamended — the stage lands in the sidecar BESIDE it, per the pinned
// append-target convention).
//
// ── The campaign enumeration: the session-ledger parse target ─────────────
//
// ACTIVE campaigns are the `session-*.md` ledgers under the personal vault's
// sessions/ dir whose §2 VERDICT TABLE carries an OPEN row — a status cell
// with no terminal marker (MERGED / APPROVED / CLOSED / SAVED / SHIPPED /
// DONE / DROPPED / WONTFIX / REJECTED / SUPERSEDED). The matching corpus is
// the ledger's own identity: its H1 title + §1's objective line + the OPEN
// rows' item cells — an active campaign is matchable by what it IS working
// on, not by a hand-curated keyword list. A malformed or verdict-table-less
// ledger degrades per-file with a NAMED reason (the sweep proceeds — one
// broken ledger never blinds the router); an unreadable file is skipped.
//
// ── The score (explainable, word-boundary, reproducible) ──────────────────
//
// A paper matches a campaign iff ≥ RELEVANCE_THRESHOLD distinct campaign
// terms hit the paper's title+abstract (word-boundary, the digest's
// countMatches discipline — "control" never matches "controller" mid-word).
// THRESHOLD = 2: one shared word is noise ("gate", "system"); two distinct
// salient terms from a campaign's own identity is the minimum explainable
// match, and the stage line RECORDS which terms matched. Best match wins;
// ties break by campaign id ascending — the router is deterministic.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendStageLine,
  stagingStreamPath,
  HOPPER_CAMPAIGN,
  type StagingProvenance,
} from "./sota_staging.js";

export { HOPPER_CAMPAIGN };

export const RELEVANCE_THRESHOLD = 2;

/** The hopper's named reasons (the stage line records WHY it went there). */
export const REASON_BELOW_THRESHOLD = "below-threshold";
export const REASON_NO_CAMPAIGN_MATCH = "no-campaign-match";

// ── the campaign enumeration (the session-ledger parse target) ─────────────

export interface CampaignLedgerInfo {
  /** The ledger file stem (`session-20260901-rydberg-cz`) — the sidecar's campaign. */
  id: string;
  /** The H1 title after `# Session ledger — `. */
  title: string;
  /** §1's first non-empty line (the one-line objective, the digest convention). */
  objectiveLine: string;
  /** The OPEN verdict-table item cells (the campaign's live work). */
  open: string[];
  /** The salient-term corpus (title + objective + open items, stopworded). */
  terms: string[];
}

export interface CampaignEnumeration {
  campaigns: CampaignLedgerInfo[];
  /** Per-file named degradation — a malformed ledger never fails the sweep. */
  skipped: { file: string; reason: string }[];
}

/** A verdict row is CLOSED when its status cell carries a terminal marker. */
const TERMINAL_MARKERS = ["MERGED", "APPROVED", "CLOSED", "SAVED", "SHIPPED", "DONE", "DROPPED", "WONTFIX", "REJECTED", "SUPERSEDED"];

/** The section grammar: `## N.` numbered headers (the campaign_ledger.ts
 *  grammar, mirrored lean — amico-run cannot import the extension). */
const SECTION_HEADER = /^##\s+§?\s*(\d+)\s*[.):\s]/;
const TABLE_LINE = /^\s*\|.*\|\s*$/;
const SEPARATOR_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function tableRows(section: string): string[][] {
  return section
    .split("\n")
    .filter((l) => TABLE_LINE.test(l) && !SEPARATOR_ROW.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
}

/** §1's first non-empty line — the one-line objective (bullets stripped,
 *  capped like the digest's render). */
function objectiveLine(section1: string): string {
  const first = section1.split("\n").find((l) => l.trim() !== "") ?? "";
  return first.trim().replace(/^[-*]\s+/, "").slice(0, 240);
}

// Short common words add nothing to relevance and drown the score — a compact
// stoplist (the term floor is 2 chars, so gate names like "cz" survive).
const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "over", "under",
  "are", "was", "were", "has", "had", "have", "will", "shall", "should", "would",
  "been", "being", "its", "his", "her", "our", "your", "their", "them", "they",
  "than", "then", "when", "what", "which", "while", "where", "these", "those",
  "any", "all", "both", "each", "few", "more", "most", "other", "some", "such",
  "only", "own", "same", "very", "just", "also", "next", "past", "per", "pre",
  "not", "but", "out", "off", "via", "one", "two", "six", "ten", "onto", "upon",
  "across", "against", "between", "through", "during", "before", "after",
  "above", "below", "up", "down", "in", "on", "at", "by", "of", "to", "as",
  "is", "it", "an", "or", "we", "no", "so", "if", "do", "did", "done", "run",
  "runs", "ran", "row", "rows", "per", "use", "used", "uses", "make", "made",
  "item", "items", "spec", "specs", "status", "review", "verdict", "table",
  "objective", "campaign", "session", "ledger", "directives", "standing",
]);

function salientTerms(corpus: string): string[] {
  const tokens = corpus
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
  return [...new Set(tokens)];
}

/** Enumerate the ACTIVE campaigns under the personal vault's sessions/ dir —
 *  the session-ledger parse target (titles + verdict tables). Degrades
 *  per-file with named reasons; never throws on the sweep's account. */
export function enumerateCampaigns(sessionsDir: string): CampaignEnumeration {
  const campaigns: CampaignLedgerInfo[] = [];
  const skipped: { file: string; reason: string }[] = [];
  if (!existsSync(sessionsDir)) return { campaigns, skipped };
  const files = readdirSync(sessionsDir).filter((n) => n.startsWith("session-") && n.endsWith(".md")).sort();
  for (const name of files) {
    let text: string;
    try {
      text = readFileSync(join(sessionsDir, name), "utf8");
    } catch {
      skipped.push({ file: name, reason: "unreadable — skipped" });
      continue;
    }
    try {
      // strip frontmatter if present (the splitFrontmatter rule: an
      // unterminated block is body, not frontmatter)
      let body = text;
      if (text.startsWith("---")) {
        const close = text.split("\n").slice(1, 65).findIndex((l) => l.trim() === "---");
        if (close >= 0) body = text.split("\n").slice(close + 2).join("\n");
      }
      const title = body.match(/^#\s+Session ledger\s*[—-]\s*(.+)$/m)?.[1]?.trim() ?? "";
      // split on the numbered headers; §1 and §2 are the identity
      const sections = new Map<number, string>();
      let current: number | null = null;
      for (const line of body.split("\n")) {
        const m = line.match(SECTION_HEADER);
        if (m) {
          current = Number(m[1]);
          continue;
        }
        if (current !== null) sections.set(current, `${sections.get(current) ?? ""}\n${line}`);
      }
      const s2 = sections.get(2) ?? "";
      const rows = tableRows(s2);
      if (rows.length === 0) {
        skipped.push({ file: name, reason: "no verdict table — not a matchable campaign ledger" });
        continue;
      }
      const open: string[] = [];
      for (const cells of rows.slice(1)) {
        // header row first (|item|status|); a row whose STATUS cell carries no
        // terminal marker is OPEN — the campaign's live work
        const status = (cells[1] ?? "").replace(/[*`]/g, "").toUpperCase();
        if (status === "") continue;
        if (TERMINAL_MARKERS.some((m) => status.includes(m))) continue;
        open.push((cells[0] ?? "").replace(/[*`]/g, "").trim());
      }
      if (open.length === 0) continue; // all-terminal: a wrapped campaign, not matchable
      const obj = objectiveLine(sections.get(1) ?? "");
      campaigns.push({
        id: name.slice(0, -3),
        title,
        objectiveLine: obj,
        open,
        terms: salientTerms(`${title}\n${obj}\n${open.join("\n")}`),
      });
    } catch {
      skipped.push({ file: name, reason: "unparseable ledger — skipped with a named reason, the sweep proceeds" });
    }
  }
  return { campaigns, skipped };
}

// ── the score (word-boundary, explainable, deterministic) ──────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function termHits(text: string, terms: string[]): string[] {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  for (const t of terms) {
    if (new RegExp(`(^|[^a-z0-9-])${escapeRe(t)}([^a-z0-9-]|$)`).test(lower)) hits.push(t);
  }
  return hits;
}

export interface RouteItem {
  title: string;
  detail: string;
}

export type RouteResult =
  | { target: "campaign"; campaign: CampaignLedgerInfo; score: number; matched: string[] }
  | { target: "hopper"; reason: "below-threshold" | "no-campaign-match"; score: number; matched: string[] };

/** Route one survey item (a paper, a watcher event) against the active
 *  campaigns: best distinct-term score wins (ties → campaign id asc); below
 *  threshold → the hopper; no campaigns → the hopper. */
export function routeItem(item: RouteItem, campaigns: CampaignLedgerInfo[]): RouteResult {
  if (campaigns.length === 0) {
    return { target: "hopper", reason: REASON_NO_CAMPAIGN_MATCH, score: 0, matched: [] };
  }
  let best: { campaign: CampaignLedgerInfo; score: number; matched: string[] } | null = null;
  for (const c of [...campaigns].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const matched = termHits(`${item.title}\n${item.detail}`, c.terms);
    if (best === null || matched.length > best.score) best = { campaign: c, score: matched.length, matched };
  }
  if (best !== null && best.score >= RELEVANCE_THRESHOLD) {
    return { target: "campaign", campaign: best.campaign, score: best.score, matched: best.matched };
  }
  return {
    target: "hopper",
    reason: REASON_BELOW_THRESHOLD,
    score: best?.score ?? 0,
    matched: best?.matched ?? [],
  };
}

// ── the digest's routing pass (ONE APPENDER: the digest job) ────────────────

export interface PapersRoutingItem {
  arxiv: string;
  title: string;
  abstract: string;
}

export interface RoutePapersOpts {
  sessionsDir: string;
  provenance: StagingProvenance;
  nowMs?: () => number;
}

export interface RoutePapersResult {
  staged: { event_id: string; campaign: string; matched: string[] }[];
  hopper: { event_id: string; campaign: string; reason: string }[];
  deduped: string[];
}

/** Route a batch of papers (the digest's picks) into the staging streams:
 *  matched → the campaign sidecar; below-threshold / no-match → the hopper
 *  stream. Idempotent by event id — the daily job re-running on the same
 *  corpus dedupes centrally (double-delivery impossible). The campaign LEDGER
 *  is never touched. */
export function routePapersToStaging(opts: RoutePapersOpts & { items: PapersRoutingItem[] }): RoutePapersResult {
  const { campaigns } = enumerateCampaigns(opts.sessionsDir);
  const result: RoutePapersResult = { staged: [], hopper: [], deduped: [] };
  for (const p of opts.items) {
    const route = routeItem({ title: p.title, detail: p.abstract }, campaigns);
    const event_id = `arxiv:${p.arxiv}`;
    const entry =
      route.target === "campaign"
        ? {
            event_id,
            campaign: route.campaign.id,
            kind: "paper" as const,
            title: p.title,
            url: `https://arxiv.org/abs/${p.arxiv}`,
            provenance: opts.provenance,
            matched: route.matched,
          }
        : {
            event_id,
            campaign: HOPPER_CAMPAIGN,
            kind: "paper" as const,
            title: p.title,
            url: `https://arxiv.org/abs/${p.arxiv}`,
            provenance: opts.provenance,
            matched: route.matched,
            reason: route.reason,
          };
    const r = appendStageLine(stagingStreamPath(opts.sessionsDir, entry.campaign), entry, { nowMs: opts.nowMs });
    if (r.appended) {
      if (route.target === "campaign") result.staged.push({ event_id, campaign: route.campaign.id, matched: route.matched });
      else result.hopper.push({ event_id, campaign: HOPPER_CAMPAIGN, reason: route.reason });
    } else {
      result.deduped.push(event_id);
    }
  }
  return result;
}

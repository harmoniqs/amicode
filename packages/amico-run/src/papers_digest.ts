// papers_digest.ts — the intelligent daily digest engine (#412):
// parse (arXiv RSS subset, zero-dep) → profile (the corpus IS the lab's
// taste: tag/system frequencies, recency-decayed) → score (explainable:
// matched terms, title-weighted, word-boundary safe) → rank (drop zeros,
// skip corpus + posted identities) → format (Slack mrkdwn).
// Deterministic: same inputs → same digest. No model in the loop — the
// intelligence is the corpus, and every pick says why it matched.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CorpusReport } from "./papers.js";

// ── the RSS subset ───────────────────────────────────────────────────────────

export interface RssItem {
  arxiv: string;
  title: string;
  abstract: string;
}

function unescapeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(s: string): string {
  return unescapeXml(s).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** Parse arXiv's RSS: <item><title/><link>…abs/<id></link><description/></item>.
 *  Malformed input degrades to [] — a bad feed never crashes the digest. */
export function parseArxivRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const entries = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  for (const e of entries) {
    const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const link = e.match(/<link>([\s\S]*?)<\/link>/)?.[1];
    const desc = e.match(/<description>([\s\S]*?)<\/description>/)?.[1];
    if (!title || !link) continue;
    const arxiv = link.trim().match(/abs\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})(v\d+)?/)?.[1];
    if (!arxiv) continue;
    items.push({
      arxiv,
      title: stripTags(title),
      abstract: desc ? stripTags(desc).slice(0, 2000) : "",
    });
  }
  return items;
}

// ── the corpus-derived profile ───────────────────────────────────────────────

const HALF_LIFE_DAYS = 180; // a term from a note read 6 months ago weighs half

export interface LabProfile {
  terms: Map<string, number>;
  weight(term: string): number;
}

/** The lab's demonstrated taste: every tag + system across the corpus,
 *  frequency-weighted and recency-decayed (date_read half-life). Fresh
 *  reading defines the current profile; old interests fade, never vanish. */
export function buildProfile(corpus: CorpusReport, now = new Date()): LabProfile {
  const terms = new Map<string, number>();
  const bump = (term: string, dateRead: string | undefined) => {
    const t = term.toLowerCase().trim();
    if (!t) return;
    let w = 1;
    if (dateRead) {
      const days = Math.max(0, (now.getTime() - Date.parse(dateRead)) / 86_400_000);
      if (!Number.isNaN(days)) w *= Math.pow(0.5, days / HALF_LIFE_DAYS);
    }
    terms.set(t, (terms.get(t) ?? 0) + w);
  };
  for (const p of corpus.papers) {
    const dateRead = p.frontmatter.date_read as string | undefined;
    for (const s of p.systems) bump(s, dateRead);
    for (const t of p.tags) if (t.toLowerCase() !== "paper") bump(t, dateRead);
  }
  return { terms, weight: (t) => terms.get(t.toLowerCase().trim()) ?? 0 };
}

// ── scoring ──────────────────────────────────────────────────────────────────

export interface ScoredPick {
  item: RssItem;
  score: number;
  terms: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Word-boundary matcher for one term against a text (already lowercased). */
function countMatches(textLower: string, term: string): number {
  const m = textLower.match(new RegExp(`(^|[^a-z0-9-])${escapeRe(term)}([^a-z0-9-]|$)`, "g"));
  return m ? m.length : 0;
}

/** Explainable score: Σ term-weight × occurrences (title ×3, abstract ×1).
 *  Zero-score papers are uninteresting to this lab — dropped, not padded. */
export function scorePaper(item: RssItem, profile: LabProfile): ScoredPick {
  const title = item.title.toLowerCase();
  const abstract = item.abstract.toLowerCase();
  let score = 0;
  const terms: string[] = [];
  for (const [term, weight] of profile.terms) {
    const inTitle = countMatches(title, term);
    const inAbs = countMatches(abstract, term);
    if (inTitle + inAbs === 0) continue;
    // multi-word / compound terms (e.g. "trapped-ion", "neutral-atoms") are
    // more specific — scale with their length
    const specificity = 1 + Math.min(1, term.length / 16);
    score += weight * specificity * (inTitle * 3 + inAbs);
    terms.push(term);
  }
  return { item, score: Math.round(score * 100) / 100, terms };
}

// ── ranking ──────────────────────────────────────────────────────────────────

export interface RankOpts {
  posted: string[]; // previously-posted ids (the state file)
  top: number;
}

export interface RankResult {
  picks: ScoredPick[];
  skipped: { corpus: string[]; posted: string[] };
  dropped: string[]; // zero-score: irrelevant to this lab
}

/** Rank: score every item, drop zeros, skip corpus/posted identities, take top N. */
export function rankDigest(items: RssItem[], profile: LabProfile, corpus: CorpusReport, opts: RankOpts): RankResult {
  const known = new Set<string>();
  for (const p of corpus.papers) {
    if (p.arxiv) known.add(p.arxiv);
  }
  const posted = new Set(opts.posted);
  const scored = items.map((i) => scorePaper(i, profile));
  const picks: ScoredPick[] = [];
  const skipped = { corpus: [] as string[], posted: [] as string[] };
  const dropped: string[] = [];
  for (const s of scored) {
    const id = s.item.arxiv;
    if (known.has(id)) skipped.corpus.push(id);
    else if (posted.has(id)) skipped.posted.push(id);
    else if (s.score <= 0) dropped.push(id);
    else picks.push(s);
  }
  picks.sort((a, b) => b.score - a.score || a.item.arxiv.localeCompare(b.item.arxiv));
  return { picks: picks.slice(0, opts.top), skipped, dropped };
}

// ── formatting ───────────────────────────────────────────────────────────────

export interface DigestForFormat {
  feedName: string;
  total: number;
  picks: ScoredPick[];
  skipped: { corpus: string[]; posted: string[] };
}

/** Slack mrkdwn: header, numbered picks with links and why-lines. */
export function formatDigest(d: DigestForFormat): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [`*arXiv ${d.feedName} picks for ${today}* (${d.picks.length} of ${d.total} new, ranked against the lab corpus)`];
  d.picks.forEach((p, i) => {
    lines.push(
      `${i + 1}. <http://arxiv.org/abs/${p.item.arxiv}|${p.item.title}>`,
      `   _why:_ ${p.terms.slice(0, 5).map((t) => `\`${t}\``).join(" · ")} (score ${p.score})`,
    );
  });
  if (d.picks.length === 0) lines.push("_nothing matched the lab profile today_");
  if (d.skipped.corpus.length) lines.push(`_${d.skipped.corpus.length} already in the lab corpus — skipped_`);
  return lines.join("\n");
}

// ── the posted-state (tiny, content-addressed idempotence) ───────────────────

export function stateFile(): string {
  return join(homedir(), ".amico", "amicode", "papers-digest-state.json");
}

export function readPostedIds(file = stateFile()): string[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { posted?: string[] };
    return Array.isArray(j.posted) ? j.posted.slice(-2000) : [];
  } catch {
    return [];
  }
}

/** Append ids; cap the log at 2000 entries (the digest only needs recent). */
export function writePostedIds(ids: string[], file = stateFile()): void {
  const prev = readPostedIds(file);
  const merged = [...new Set([...prev, ...ids])].slice(-2000);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ posted: merged, updated: new Date().toISOString() }) + "\n");
}

/** Stable digest fingerprint (for tests: same inputs → same output). */
export function digestFingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function feedUrl(name: string): string {
  return `https://export.arxiv.org/rss/${name}`;
}

/** Feed retrieval via curl (the S31-compliant network seam — network I/O
 *  rides subprocess curl; same zero-dep doctrine as the slack post). */
export function fetchFeed(url: string): string {
  const out = execFileSync(
    "curl",
    ["-sS", "--max-time", "30", "-H", "user-agent: amicode-papers-digest/0.1 (harmoniqs)", url],
    { encoding: "utf8", maxBuffer: 4 << 20 },
  );
  return out;
}

export function libraryRootLegacy(): string {
  return join(homedir(), ".amico", "library");
}
void existsSync;

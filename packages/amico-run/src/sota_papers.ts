// sota_papers.ts — the PAPERS lens (#820, spec spec-20260905-103000
// living-sota D1): on-demand arXiv queries through the fleet-wide serialized
// queue (sota_fetch.ts — cache → lock → re-check cache → fetch → cache +
// history), rendered as cited, provenance-stamped, PI-register briefs.
//
// The web-search recipe is carried VERBATIM and mechanically:
//   1. vault/repo grep FIRST — the SKILL's instruction step; the lens is the
//      recipe's step 2, never a replacement for step 1.
//   2. the arXiv API over HTTPS — the builder below CANNOT emit http://
//      (ARXIV_API_ENDPOINT is https; fetchThroughQueue additionally refuses
//      any http:// URL with the named reason — the export API's http
//      endpoint silently hangs, the recipe's recorded gotcha).
//   3. never scraping — the only transport is the documented export API;
//      search-engine HTML endpoints appear nowhere in this module (pinned by
//      the extension's sota_review_skill lint).
//
// The brief's anomaly line is the fetch floor's verdict, rendered honestly:
// an empty-200 against a nonzero trailing mean is "scan returned nothing —
// anomalous", NEVER "nothing new" (spec sota_fetch_anomaly_floor).
import { execFileSync } from "node:child_process";
import {
  fetchThroughQueue,
  type FetchThroughQueueOpts,
  type FetchThroughQueueResult,
  type SotaFetch,
} from "./sota_fetch.js";
import type { AnomalyFloorVerdict } from "./sota_history.js";

/** The real export API — https BY CONSTRUCTION (the recipe's gotcha: the
 *  http:// endpoint silently hangs; there is no http constant anywhere). */
export const ARXIV_API_ENDPOINT = "https://export.arxiv.org/api/query";

/** Build the canonical export-API query URL for one on-demand survey query. */
export function arxivApiUrl(terms: string[], maxResults: number): string {
  if (terms.length === 0) throw new Error("arxivApiUrl: at least one search term is required — a wildcard firehose is never the survey");
  const q = terms.map((t) => `all:${t}`).join(" AND ");
  return `${ARXIV_API_ENDPOINT}?search_query=${encodeURIComponent(q)}&max_results=${maxResults}`;
}

// ── the Atom subset (the parseArxivRss idiom: zero-dep, tolerant) ─────────────

export interface ArxivEntry {
  /** The arXiv id (2606.05060) — the citation key. */
  arxiv: string;
  title: string;
  abstract: string;
  published: string; // ISO-8601, sliced
  authors: string[];
}

/** The citation URL — the abs landing page, https. */
export function absUrlOf(e: Pick<ArxivEntry, "arxiv">): string {
  return `https://arxiv.org/abs/${e.arxiv}`;
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

/** Parse the export API's Atom: <entry><id>http://arxiv.org/abs/<id>v<n></id>
 *  <title/><summary/><published/><author><name/></author></entry>. Malformed
 *  input degrades to [] — a bad payload never crashes the lens. */
export function parseArxivAtom(xml: string): ArxivEntry[] {
  const entries: ArxivEntry[] = [];
  const blocks = xml.match(/<entry>([\s\S]*?)<\/entry>/g) ?? [];
  for (const b of blocks) {
    const id = b.match(/<id>([\s\S]*?)<\/id>/)?.[1];
    if (!id) continue;
    const arxiv = id.trim().match(/abs\/([0-9]{4}\.[0-9]{4,5}|[a-z-]+\/[0-9]{7})(v\d+)?/)?.[1];
    if (!arxiv) continue;
    const title = b.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const summary = b.match(/<summary>([\s\S]*?)<\/summary>/)?.[1];
    const published = b.match(/<published>([\s\S]*?)<\/published>/)?.[1];
    const authors = [...b.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) => stripTags(m[1]));
    entries.push({
      arxiv,
      title: title ? stripTags(title) : "",
      abstract: summary ? stripTags(summary).slice(0, 2000) : "",
      published: published ? published.trim().slice(0, 10) : "",
      authors,
    });
  }
  return entries;
}

// ── the production transport (the S31 zero-dep doctrine: curl subprocess) ────

/** The production SotaFetch: one query's worth of network via curl, the same
 *  seam as papers_digest.ts's fetchFeed. https-only is enforced upstream
 *  (the endpoint constant + fetchThroughQueue's http:// refusal). */
export function curlSotaFetch(url: string): Promise<{ ok: true; status: number; body: string; count: number } | { ok: false; status: number; error: string }> {
  return (async () => {
    try {
      const body = execFileSync(
        "curl",
        ["-sS", "--max-time", "30", "-H", "user-agent: amicode-sota-review/0.1", url],
        { encoding: "utf8", maxBuffer: 4 << 20 },
      );
      return { ok: true, status: 200, body, count: parseArxivAtom(body).length };
    } catch (e) {
      return { ok: false, status: 0, error: `curl: ${(e as Error).message}` };
    }
  })();
}

// ── the brief (PI register: concise, cited, provenance-stamped) ──────────────

export interface PapersProvenanceStamp {
  query: string;
  url: string;
  fetched_at: string; // ISO-8601
  via: string; // cache | fetched | queue-timeout
}

export interface PapersBriefOpts {
  entries: ArxivEntry[];
  stamp: PapersProvenanceStamp;
  anomaly: AnomalyFloorVerdict;
}

/** Render the PI-register brief: the outcome leads, every entry is CITED by
 *  its abs URL with authors + date, and a provenance block stamps the query,
 *  the source, the fetch time, and the path (cache vs live). */
export function papersBrief(opts: PapersBriefOpts): string {
  const { entries, stamp, anomaly } = opts;
  const lines: string[] = [`# SOTA papers brief — ${stamp.query} (${entries.length} results)`];
  if (entries.length === 0) {
    if (anomaly.anomaly && anomaly.render) {
      lines.push(anomaly.render); // "scan returned nothing — anomalous (…)" — NEVER "nothing new"
    } else {
      lines.push("no results (the anomaly floor is not yet armed for this source — too few fetch-days of history to call an empty scan anomalous)");
    }
  }
  entries.forEach((e, i) => {
    const author = e.authors.length > 0 ? ` — ${e.authors.slice(0, 3).join(", ")}${e.authors.length > 3 ? " et al." : ""}` : "";
    const date = e.published ? ` (${e.published})` : "";
    lines.push(`${i + 1}. **${e.title || "(untitled)"}**${author}${date}`);
    lines.push(`   [arXiv:${e.arxiv}](${absUrlOf(e)})`);
    if (e.abstract) lines.push(`   > ${e.abstract.slice(0, 220)}${e.abstract.length > 220 ? "…" : ""}`);
  });
  if (anomaly.armed && !anomaly.anomaly && anomaly.mean !== undefined) {
    lines.push(`_fetch health: trailing 7-fetch-day mean ${anomaly.mean.toFixed(1)} — ordinary._`);
  }
  lines.push(
    "",
    "provenance:",
    `- source: arXiv export API over HTTPS (${stamp.url})`,
    `- fetched_at: ${stamp.fetched_at}`,
    `- via: ${stamp.via}${stamp.via === "queue-timeout" ? " — read the fetch cache, or record the waiver; never a silent block" : ""}`,
    `- query: ${stamp.query}`,
  );
  return lines.join("\n");
}

// ── the lens (one on-demand query through the queue) ─────────────────────────

export interface PapersLensOpts extends Omit<FetchThroughQueueOpts, "fetchFn" | "root" | "sourceKey"> {
  root: string;
  terms: string[];
  maxResults?: number;
  /** The transport — injectable for hermetic tests; default curlSotaFetch. */
  fetchFn?: SotaFetch;
}

export type PapersLensResult =
  | {
      via: "cache" | "fetched";
      ok: true;
      entries: ArxivEntry[];
      brief: string;
      anomaly?: AnomalyFloorVerdict;
      stamp: PapersProvenanceStamp;
    }
  | {
      via: "queue-timeout" | "fetch-failed" | "refused";
      ok: false;
      brief: string;
      detail: string;
    };

/** One on-demand papers query: build the export-API URL, ride the queue,
 *  parse, and render the cited brief. The queue-timeout fall-through renders
 *  the NAMED outcome — the survey never blocks the loop. */
export async function runPapersLens(opts: PapersLensOpts): Promise<PapersLensResult> {
  const { root, terms } = opts;
  const maxResults = opts.maxResults ?? 5;
  const url = arxivApiUrl(terms, maxResults);
  const nowMs = opts.nowMs ?? Date.now;
  const res: FetchThroughQueueResult = await fetchThroughQueue(url, {
    ...opts,
    root,
    fetchFn: opts.fetchFn ?? curlSotaFetch,
    nowMs,
    // stable per-URL history key: the default (content key of the URL) IS the
    // per-source key for on-demand queries — each distinct query is its own
    // source for the anomaly floor.
  });
  const fetchedAt = new Date(nowMs()).toISOString();
  if (!res.ok) {
    const detail =
      res.via === "queue-timeout"
        ? `${res.detail} (waited ${res.waitedMs}ms)`
        : res.via === "refused"
          ? res.reason
          : res.error;
    const brief = [
      `# SOTA papers brief — ${terms.join(" ")} (0 results)`,
      `no fetch: ${res.via} — ${detail}`,
      "the survey never blocks: read the fetch cache, or record the explicit waiver.",
      "",
      "provenance:",
      `- source: arXiv export API over HTTPS (${url})`,
      `- fetched_at: ${fetchedAt}`,
      `- via: ${res.via}`,
      `- query: ${terms.join(" ")}`,
    ].join("\n");
    return { via: res.via, ok: false, brief, detail };
  }
  const entries = parseArxivAtom(res.body);
  const stamp: PapersProvenanceStamp = { query: terms.join(" "), url, fetched_at: fetchedAt, via: res.via };
  const anomaly = res.anomaly ?? { armed: false, anomaly: false };
  const brief = papersBrief({ entries, stamp, anomaly });
  return { via: res.via, ok: true, entries, brief, anomaly, stamp };
}

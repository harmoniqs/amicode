// sota_codebase.ts — the CODEBASE lens (#820, spec spec-20260905-103000
// living-sota D1/D3-data): the watched-repo registry is VALIDATOR-CHECKED
// TOML DATA (adding a repo is a data edit of the living registry, never
// code), and the fetch surface is the GitHub API against the CANONICAL repo
// (owner/name) — never a local fork checkout; the builder below can only emit
// https://api.github.com/repos/… URLs and the transport is the same one-
// fetcher seam as the papers lens (cache → fleet-wide queue → fetch → cache
// + history).
//
// Quiet failures are the ones that matter: a successful round stamps
// last_success and resets consecutive_failures; a failed round accrues the
// counter; at the registry's failure_threshold (default 7, data) the brief
// names the entry for HUMAN RETIRE-OR-CONFIRM — the flag is DERIVED from the
// persisted counter at read time, never stored, so it can never disagree with
// the counter it reads. The anomaly floor rides per-source exactly as in the
// papers lens: an empty 200 against a nonzero trailing mean renders
// "scan returned nothing — anomalous", never "nothing new".
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import seedToml from "../resources/watched-repos.seed.toml";
import {
  parseWatchedRepoRegistry,
  validateWatchedRepoRegistry,
  flaggedForRetireOrConfirm,
  type FetchSurface,
  type WatchedRepoRegistry,
} from "@amicode/schema";
import {
  fetchThroughQueue,
  type FetchThroughQueueOpts,
  type FetchThroughQueueResult,
  type SotaFetch,
} from "./sota_fetch.js";
import type { AnomalyFloorVerdict } from "./sota_history.js";

export const REGISTRY_FILENAME = "watched-repos.toml";

/** The stable per-source history key for one repo+surface. The repo slug's
 *  `/` is flattened (`__`) — the key is a FILE NAME under fetch-history/,
 *  and a slash would invent a directory that does not exist. */
export function githubSourceKey(repo: string, surface: FetchSurface): string {
  return `github:${repo.replace(/\//g, "__")}:${surface}`;
}

/** The living registry's path under the sota root. */
export function registryPath(root: string): string {
  return join(root, REGISTRY_FILENAME);
}

/** The packaged seed — the shipped bootstrap data (the spec's D3 seed set). */
export function seedRegistryToml(): string {
  return seedToml;
}

// ── the GitHub API fetch surface (canonical repos, never a checkout) ────────

/** The canonical GitHub API URL for one repo + surface. https BY
 *  CONSTRUCTION — this function cannot emit a local path or another scheme.
 *  The `changelog` surface rides the releases endpoint (release notes ARE
 *  the changelog on GitHub-shaped data); only the brief's section differs. */
export function githubApiUrl(repo: string, surface: FetchSurface): string {
  switch (surface) {
    case "releases":
    case "changelog":
      return `https://api.github.com/repos/${repo}/releases?per_page=10`;
    case "issues":
      return `https://api.github.com/repos/${repo}/issues?state=open&per_page=20`;
  }
}

export interface GithubRelease {
  id: string; // repo@tag
  tag: string;
  title: string;
  url: string;
  when: string;
  detail: string; // the release body
}

export interface GithubIssue {
  id: string; // repo#number
  title: string;
  url: string;
  when: string;
  detail: string; // the issue body
}

function bodyOf(item: unknown): string {
  const b = (item as { body?: unknown }).body;
  return typeof b === "string" ? b : "";
}

/** Parse the GitHub releases payload (tolerant: malformed → [], the caller
 *  renders the named anomaly, never a crash). */
export function parseGithubReleases(json: string, repo = "repo"): GithubRelease[] {
  let items: unknown;
  try {
    items = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out: GithubRelease[] = [];
  for (const it of items) {
    const tag = (it as { tag_name?: unknown }).tag_name;
    if (typeof tag !== "string") continue;
    out.push({
      id: `${repo}@${tag}`,
      tag,
      title: typeof (it as { name?: unknown }).name === "string" ? (it as { name: string }).name : tag,
      url: typeof (it as { html_url?: unknown }).html_url === "string" ? (it as { html_url: string }).html_url : `https://github.com/${repo}/releases/tag/${tag}`,
      when: typeof (it as { published_at?: unknown }).published_at === "string" ? (it as { published_at: string }).published_at : "",
      detail: bodyOf(it),
    });
  }
  return out;
}

/** Parse the GitHub issues payload (tolerant, same discipline). */
export function parseGithubIssues(json: string, repo = "repo"): GithubIssue[] {
  let items: unknown;
  try {
    items = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) return [];
  const out: GithubIssue[] = [];
  for (const it of items) {
    const n = (it as { number?: unknown }).number;
    if (typeof n !== "number") continue;
    out.push({
      id: `${repo}#${n}`,
      title: typeof (it as { title?: unknown }).title === "string" ? (it as { title: string }).title : "",
      url: typeof (it as { html_url?: unknown }).html_url === "string" ? (it as { html_url: string }).html_url : `https://github.com/${repo}/issues/${n}`,
      when: typeof (it as { updated_at?: unknown }).updated_at === "string" ? (it as { updated_at: string }).updated_at : "",
      detail: bodyOf(it),
    });
  }
  return out;
}

// ── the production transport (the S31 curl doctrine) ────────────────────────

/** The production SotaFetch for GitHub surfaces: one query's worth of
 *  network via curl against api.github.com. Count semantics feed the
 *  anomaly floor: the number of items the surface returned. */
export function curlGithubFetch(url: string): Promise<{ ok: true; status: number; body: string; count: number } | { ok: false; status: number; error: string }> {
  return (async () => {
    try {
      const body = execFileSync(
        "curl",
        ["-sS", "--max-time", "30", "-H", "user-agent: amicode-sota-review/0.1", "-H", "accept: application/vnd.github+json", url],
        { encoding: "utf8", maxBuffer: 4 << 20 },
      );
      const count = url.includes("/releases") ? parseGithubReleases(body).length : parseGithubIssues(body).length;
      return { ok: true, status: 200, body, count };
    } catch (e) {
      return { ok: false, status: 0, error: `curl: ${(e as Error).message}` };
    }
  })();
}

// ── registry load + the stamp writer (revalidate before persist) ────────────

/** Load the LIVING registry under the sota root, bootstrapping it from the
 *  packaged seed on first read (the seed must validate — a drifted seed is a
 *  loud authoring failure, never a silent skip). A malformed living registry
 *  THROWS field-precise. */
export function loadRegistry(root: string): WatchedRepoRegistry {
  const p = registryPath(root);
  if (!existsSync(p)) {
    const v = validateWatchedRepoRegistry(seedToml);
    if (!v.ok) throw new Error(`the packaged seed registry is invalid — ${v.errors.join("; ")}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(p, seedToml.endsWith("\n") ? seedToml : seedToml + "\n");
  }
  return parseWatchedRepoRegistry(readFileSync(p, "utf8"));
}

const tomlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const tomlArray = (xs: string[]): string => `[${xs.map(tomlString).join(", ")}]`;

/** Render the registry back to TOML (the stamp writer's serialize step —
 *  the data shape is closed, so the round-trip is mechanical). */
export function renderRegistryToml(reg: WatchedRepoRegistry): string {
  const lines = [`schema_version = "${reg.schema_version}"`, "", `failure_threshold = ${reg.failure_threshold}`, ""];
  for (const r of reg.repos) {
    lines.push("[[repos]]");
    lines.push(`repo = ${tomlString(r.repo)}`);
    lines.push(`why_watched = ${tomlString(r.why_watched)}`);
    lines.push(`domains = ${tomlArray(r.domains)}`);
    lines.push(`fetch_surface = ${tomlArray(r.fetch_surface)}`);
    lines.push(`match_keywords = ${tomlArray(r.match_keywords)}`);
    lines.push(`last_success = ${tomlString(r.last_success)}`);
    lines.push(`consecutive_failures = ${r.consecutive_failures}`);
    lines.push("");
  }
  return lines.join("\n");
}

export interface StampUpdate {
  repo: string;
  ok: boolean; // did this repo's round succeed (any surface ok)?
}

/** Apply one fetch round's stamps to the registry and persist it — writing
 *  the NEW text to a tmp file, REVALIDATING it against the validator, and
 *  only then renaming it into place. A persist that would corrupt the
 *  registry throws instead. */
export function persistStampedRegistry(root: string, reg: WatchedRepoRegistry, updates: StampUpdate[], nowIso: string): void {
  const stamped: WatchedRepoRegistry = {
    ...reg,
    repos: reg.repos.map((r) => {
      const u = updates.find((x) => x.repo === r.repo);
      if (!u) return r;
      return u.ok
        ? { ...r, last_success: nowIso, consecutive_failures: 0 }
        : { ...r, consecutive_failures: r.consecutive_failures + 1 };
    }),
  };
  const text = renderRegistryToml(stamped);
  const check = validateWatchedRepoRegistry(text);
  if (!check.ok) throw new Error(`refusing to persist a registry the validator rejects — ${check.errors.join("; ")}`);
  const p = registryPath(root);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

// ── keyword matching (word-boundary, explainable) ──────────────────────────

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of the entry's match keywords hit (title ×2-weighted word-boundary
 *  scan over title + body). An event surfaces in the brief iff it matched at
 *  least one keyword — and the brief names WHICH ones. */
export function matchKeywords(title: string, body: string, keywords: string[]): string[] {
  const text = `${title}\n${body}`.toLowerCase();
  const hits: string[] = [];
  for (const kw of keywords) {
    const m = text.match(new RegExp(`(^|[^a-z0-9-])${escapeRe(kw.toLowerCase())}([^a-z0-9-]|$)`));
    if (m) hits.push(kw);
  }
  return hits;
}

// ── the lens (the fetch round) ───────────────────────────────────────────────

export interface CodebaseEvent {
  id: string;
  title: string;
  url: string;
  when: string;
  detail: string;
  matched: string[];
}

export interface SurfaceResult {
  surface: FetchSurface;
  url: string;
  via: string; // cache | fetched | fetch-failed | queue-timeout | refused
  ok: boolean;
  count: number;
  events: CodebaseEvent[]; // keyword-filtered, cited
  anomaly?: AnomalyFloorVerdict;
  error?: string;
}

export interface RepoResult {
  repo: string;
  why_watched: string;
  ok: boolean; // any surface ok → the round succeeded for this repo
  flagged: boolean; // retire-or-confirm, derived from the PERSISTED counter
  surfaces: SurfaceResult[];
}

export interface CodebaseLensOpts extends Omit<FetchThroughQueueOpts, "fetchFn" | "root" | "sourceKey"> {
  root: string;
  fetchFn?: SotaFetch; // the transport — injectable for hermetic tests; default curlGithubFetch
  repos?: string[]; // optional filter (canonical owner/name)
}

export interface CodebaseLensResult {
  ok: boolean; // every repo's round succeeded
  brief: string;
  repos: RepoResult[];
  stamp: { iso: string };
}

/** The codebase fetch round: for each watched repo, each declared surface,
 *  one GitHub-API fetch through the one-fetcher seam; events keyword-filter
 *  into the brief; stamps persist at the end. The survey never blocks: a
 *  queue-timeout surface is a NAMED failure, never a throw. */
export async function runCodebaseLens(opts: CodebaseLensOpts): Promise<CodebaseLensResult> {
  const { root } = opts;
  const nowMs = opts.nowMs ?? Date.now;
  const reg = loadRegistry(root);
  const wanted = opts.repos ? reg.repos.filter((r) => opts.repos!.includes(r.repo)) : reg.repos;
  const fetchFn = opts.fetchFn ?? curlGithubFetch;

  const results: RepoResult[] = [];
  for (const repo of wanted) {
    const surfaces: SurfaceResult[] = [];
    for (const surface of repo.fetch_surface) {
      const url = githubApiUrl(repo.repo, surface);
      const res: FetchThroughQueueResult = await fetchThroughQueue(url, {
        ...opts,
        root,
        fetchFn,
        nowMs,
        sourceKey: githubSourceKey(repo.repo, surface), // stable per-source history key
      });
      if (!res.ok) {
        surfaces.push({
          surface,
          url,
          via: res.via,
          ok: false,
          count: 0,
          events: [],
          error: res.via === "queue-timeout" ? `${res.detail} (waited ${res.waitedMs}ms)` : res.via === "refused" ? res.reason : res.error,
        });
        continue;
      }
      const items =
        surface === "issues"
          ? parseGithubIssues(res.body, repo.repo).map((i) => ({ id: i.id, title: i.title, url: i.url, when: i.when, detail: i.detail }))
          : parseGithubReleases(res.body, repo.repo).map((r) => ({ id: r.id, title: r.title, url: r.url, when: r.when, detail: r.detail }));
      const events: CodebaseEvent[] = [];
      for (const it of items) {
        const matched = matchKeywords(it.title, it.detail, repo.match_keywords);
        if (matched.length > 0) events.push({ ...it, matched });
      }
      surfaces.push({ surface, url, via: res.via, ok: true, count: res.count, events, anomaly: res.anomaly });
    }
    results.push({
      repo: repo.repo,
      why_watched: repo.why_watched,
      ok: surfaces.some((s) => s.ok),
      flagged: false, // derived AFTER stamps persist (below)
      surfaces,
    });
  }

  // stamps: one round verdict per repo; the flag derives from the persisted counter
  const nowIso = new Date(nowMs()).toISOString();
  persistStampedRegistry(root, reg, results.map((r) => ({ repo: r.repo, ok: r.ok })), nowIso);
  const persisted = parseWatchedRepoRegistry(readFileSync(registryPath(root), "utf8"));
  for (const r of results) {
    const entry = persisted.repos.find((x) => x.repo === r.repo);
    if (entry) r.flagged = flaggedForRetireOrConfirm(entry, persisted.failure_threshold);
  }

  return {
    ok: results.every((r) => r.ok),
    brief: renderCodebaseBrief({ repos: results, stampIso: nowIso, threshold: persisted.failure_threshold }),
    repos: results,
    stamp: { iso: nowIso },
  };
}

// ── the brief (PI register: cited, provenance-stamped, flags named) ─────────

export interface CodebaseBriefInput {
  repos: RepoResult[];
  stampIso: string;
  threshold: number;
}

/** Render the PI-register codebase brief: the outcome leads, every surfaced
 *  event is CITED by its canonical URL, each repo's why-watched renders (the
 *  retire-or-confirm decision reads this line), and the flagged entries get
 *  the human-decision section — never a silent unwatch. */
export function renderCodebaseBrief(input: CodebaseBriefInput): string {
  const { repos, stampIso, threshold } = input;
  const matchedTotal = repos.reduce((s, r) => s + r.surfaces.reduce((t, su) => t + su.events.length, 0), 0);
  const flagged = repos.filter((r) => r.flagged);
  const lines: string[] = [
    `# SOTA codebase brief — ${repos.length} repos scanned (${matchedTotal} matched events)`,
    `scanned at: ${stampIso} · source: GitHub API against canonical repos · never a local fork checkout`,
  ];
  for (const r of repos) {
    lines.push("", `## ${r.repo} — why-watched: ${r.why_watched}`);
    for (const s of r.surfaces) {
      if (!s.ok) {
        lines.push(`- ${s.surface}: fetch failed — ${s.error ?? "unknown error"} (named failure; the entry accrues toward retire-or-confirm)`);
        continue;
      }
      if (s.events.length === 0) {
        if (s.anomaly?.anomaly && s.anomaly.render) {
          lines.push(`- ${s.surface}: ${s.anomaly.render}`); // "scan returned nothing — anomalous (…)"
        } else if (s.anomaly?.armed) {
          lines.push(`- ${s.surface}: no matched events (trailing 7-fetch-day mean ${s.anomaly.mean?.toFixed(1) ?? "?"} — ordinary scan)`);
        } else {
          lines.push(`- ${s.surface}: no matched events (floor not yet armed — too few fetch-days of history for this source)`);
        }
        continue;
      }
      for (const e of s.events) {
        const when = e.when ? ` (${e.when.slice(0, 10)})` : "";
        lines.push(`- **${e.title}**${when} — ${e.url}`);
        lines.push(`  _matched: ${e.matched.join(", ")} · id ${e.id}_`);
      }
    }
  }
  if (flagged.length > 0) {
    lines.push("", `## Retire-or-confirm (the human decision — never a silent unwatch)`);
    for (const r of flagged) {
      lines.push(`- ${r.repo} — the fetch failed ${threshold} consecutive times. why-watched: ${r.why_watched}`);
      lines.push(`  Confirm the watch (and fix the fetch) or retire the entry — the registry edit is yours, not the machinery's.`);
    }
  }
  lines.push(
    "",
    "provenance:",
    "- source: GitHub API against canonical repos (https://api.github.com/repos/<owner>/<name>)",
    `- scanned_at: ${stampIso}`,
    "- registry: validator-checked TOML data — adding a repo is a data edit, never code",
  );
  return lines.join("\n");
}

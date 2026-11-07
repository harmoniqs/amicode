// packages/amico-run/src/census.ts — census-lite (rd-system v2.1 A0b, #1902).
//
// One GitHub-derived (authoritative) census of the framework tier, rendered daily into the
// morning brief:
//   - open framework slices + age    — sub-issues of the PRD (default harmoniqs/amicode#1820)
//                                      ∪ issues carrying the `amico-spec-slices` provenance marker
//   - framework movement             — the latest merge of a PR closing a framework slice, or a
//                                      slice closure; days since the last framework merge
//   - merges with / without bypass   — merged PRs on the base over the window; best effort:
//                                      reviewDecision != APPROVED counts as bypass
//   - override deploys               — from the local deploy provenance record (deploy.json or a
//                                      JSONL log of them), else a named gap
//   - open-PR depth                  — open PRs in the repo
//   - overlay file count             — packages/app-bundle/manifest.json `counts.overlay_total`
//
// HONESTY RULE: every source lands in `coverage` as `ok` or `gap:<reason>`. A gapped source's
// value is `null` and renders as the gap — never as a zero. A measured zero is `ok` + 0.
//
// STALL TRIPWIRE: a framework tier that has not moved in STALL_HOURS (72h) sets `stalled_since`
// and becomes the brief's top line. A tier that never moved is stalled since its oldest slice was
// filed. If movement cannot be measured, the stall is a gap — never a silent "not stalled".
//
// GITHUB rides `gh api` through an injected layer (`CensusGh`) over an injected runner
// (`GhApiRunner`) — the spec_slices.ts / handoff_verb.ts exec-seam precedent. Read-only.
import { existsSync, readFileSync } from "node:fs";
import { defaultGhApiRunner, type GhApiRunner, type IssueAddr } from "./spec_slices.js";

export const STALL_HOURS = 72;
export const DEFAULT_PRD: IssueAddr = { repo: "harmoniqs/amicode", number: 1820 };
export const DEFAULT_REPO = "harmoniqs/amicode";
export const DEFAULT_WINDOW_DAYS = 7;
const MARKER = "<!-- amico-spec-slices";

export const CENSUS_SOURCES = ["framework_slices", "framework_movement", "merges", "override_deploys", "open_prs", "overlay"] as const;
export type CensusSource = (typeof CENSUS_SOURCES)[number];
/** `ok` or `gap:<reason>`. */
export type Coverage = "ok" | `gap:${string}`;

// ── the gh layer ─────────────────────────────────────────────────────────────

export interface FrameworkIssue extends IssueAddr {
  title: string;
  state: "open" | "closed";
  created_at: string;
  closed_at: string | null;
}
export interface ClosingPr extends IssueAddr {
  merged_at: string | null;
}
export interface MergedPr {
  number: number;
  merged_at: string;
  review_decision: string | null;
}

export interface CensusGh {
  /** Sub-issues of `prd` ∪ marker-carrying issues across the org. */
  frameworkIssues(prd: IssueAddr): FrameworkIssue[];
  /** For each issue, the PRs that close (or closed) it. */
  closingPrs(issues: IssueAddr[]): Array<IssueAddr & { prs: ClosingPr[] }>;
  /** PRs merged into `base` of `repo` since `sinceIso` (the caller re-filters by time). */
  mergedPrs(repo: string, base: string, sinceIso: string): MergedPr[];
  openPrCount(repo: string): number;
}

type RawIssue = {
  number: number;
  title?: string;
  state?: string;
  created_at: string;
  closed_at?: string | null;
  body?: string | null;
  pull_request?: unknown;
  repository_url?: string;
  repository?: { full_name?: string };
};

const repoOf = (r: RawIssue, fallback?: string): string =>
  r.repository?.full_name ?? r.repository_url?.replace(/^https:\/\/api\.github\.com\/repos\//, "") ?? fallback ?? "";

const gqlString = (s: string) => JSON.stringify(s);

export function ghApiCensus(runner: GhApiRunner = defaultGhApiRunner): CensusGh {
  const call = (args: string[]): unknown => {
    const r = runner(args);
    if (r.code !== 0) throw new Error(`gh api ${args[0] === "graphql" ? "graphql" : args.filter((a) => !a.startsWith("--")).join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    const out = r.stdout.trim();
    return out === "" ? undefined : JSON.parse(out);
  };
  const gql = (query: string, vars: Record<string, string> = {}): Record<string, unknown> => {
    const args = ["graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
    const res = call(args) as { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } | undefined;
    if (res?.errors?.length) throw new Error(`graphql: ${res.errors.map((e) => e.message ?? "error").join("; ")}`);
    if (!res?.data) throw new Error("graphql: empty response");
    return res.data;
  };
  const flatten = (pages: unknown): RawIssue[] => {
    const arr = Array.isArray(pages) ? pages : [pages];
    return arr.flatMap((p) => (Array.isArray(p) ? p : p && typeof p === "object" && Array.isArray((p as { items?: unknown }).items) ? (p as { items: RawIssue[] }).items : [])) as RawIssue[];
  };
  const toIssue = (r: RawIssue, fallback?: string): FrameworkIssue => ({
    repo: repoOf(r, fallback),
    number: r.number,
    title: r.title ?? "",
    state: r.state === "closed" ? "closed" : "open",
    created_at: r.created_at,
    closed_at: r.closed_at ?? null,
  });

  return {
    frameworkIssues(prd) {
      const out = new Map<string, FrameworkIssue>();
      const add = (i: FrameworkIssue) => {
        const k = `${i.repo}#${i.number}`;
        if (!out.has(k)) out.set(k, i);
      };
      flatten(call(["--paginate", "--slurp", `repos/${prd.repo}/issues/${prd.number}/sub_issues?per_page=100`])).forEach((r) => add(toIssue(r, prd.repo)));
      const org = prd.repo.split("/")[0];
      const q = `org:${org} is:issue in:body amico-spec-slices`;
      flatten(call(["--paginate", "--slurp", "-X", "GET", "search/issues", "-f", `q=${q}`, "-f", "per_page=100"]))
        .filter((r) => r.pull_request === undefined && (r.body ?? "").includes(MARKER))
        .forEach((r) => add(toIssue(r)));
      return [...out.values()];
    },

    closingPrs(issues) {
      const byRepo = new Map<string, number[]>();
      for (const i of issues) byRepo.set(i.repo, [...(byRepo.get(i.repo) ?? []), i.number]);
      const result = new Map<string, ClosingPr[]>();
      for (const [repo, numbers] of byRepo) {
        const [owner, name] = repo.split("/");
        for (let k = 0; k < numbers.length; k += 50) {
          const chunk = numbers.slice(k, k + 50);
          const fields = chunk
            .map((n) => `i${n}: issue(number: ${n}) { closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { number mergedAt repository { nameWithOwner } } } }`)
            .join("\n    ");
          const data = gql(`query {\n  repository(owner: ${gqlString(owner)}, name: ${gqlString(name)}) {\n    ${fields}\n  }\n}`);
          const repoNode = (data.repository ?? {}) as Record<string, { closedByPullRequestsReferences?: { nodes?: Array<{ number: number; mergedAt: string | null; repository?: { nameWithOwner?: string } }> } } | null>;
          for (const n of chunk)
            result.set(
              `${repo}#${n}`,
              (repoNode[`i${n}`]?.closedByPullRequestsReferences?.nodes ?? []).map((p) => ({ repo: p.repository?.nameWithOwner ?? repo, number: p.number, merged_at: p.mergedAt ?? null })),
            );
        }
      }
      return issues.map((i) => ({ repo: i.repo, number: i.number, prs: result.get(`${i.repo}#${i.number}`) ?? [] }));
    },

    mergedPrs(repo, base, sinceIso) {
      const q = `repo:${repo} is:pr is:merged base:${base} merged:>=${sinceIso.slice(0, 10)}`;
      const query = `query($q: String!, $cursor: String) {\n  search(query: $q, type: ISSUE, first: 100, after: $cursor) {\n    pageInfo { hasNextPage endCursor }\n    nodes { ... on PullRequest { number mergedAt reviewDecision } }\n  }\n}`;
      const out: MergedPr[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = gql(query, { q, ...(cursor ? { cursor } : {}) });
        const s = data.search as { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: Array<{ number?: number; mergedAt?: string | null; reviewDecision?: string | null }> };
        for (const n of s.nodes ?? []) if (typeof n.number === "number" && n.mergedAt) out.push({ number: n.number, merged_at: n.mergedAt, review_decision: n.reviewDecision ?? null });
        if (!s.pageInfo?.hasNextPage || !s.pageInfo.endCursor) return out;
        cursor = s.pageInfo.endCursor;
      }
      throw new Error("merged-PR search exceeded 10 pages (1000 PRs) — narrow the window");
    },

    openPrCount(repo) {
      const data = gql(`query($q: String!) {\n  search(query: $q, type: ISSUE, first: 0) { issueCount }\n}`, { q: `repo:${repo} is:pr is:open` });
      const n = (data.search as { issueCount?: unknown } | undefined)?.issueCount;
      if (typeof n !== "number") throw new Error("graphql: search.issueCount missing");
      return n;
    },
  };
}

// ── the census ───────────────────────────────────────────────────────────────

export interface CensusOptions {
  gh: CensusGh;
  now: Date;
  prd: IssueAddr;
  repo: string;
  base: string;
  windowDays: number;
  manifestPath: string;
  deployRecordPath: string;
}

export interface Census {
  verb: "census";
  rendered_at: string;
  prd: string;
  repo: string;
  base: string;
  window_days: number;
  coverage: Record<CensusSource, Coverage>;
  framework_slices: {
    open: number;
    closed: number;
    oldest_age_days: number | null;
    median_age_days: number | null;
    items: Array<{ issue: string; title: string; age_days: number }>;
  } | null;
  framework_movement: {
    last_moved_at: string | null;
    last_merge_at: string | null;
    last_merge_pr: string | null;
    days_since_last_merge: number | null;
  } | null;
  merges: { window_days: number; total: number; without_bypass: number; with_bypass: number; bypass_prs: number[]; bypass_rule: string } | null;
  override_deploys: { count: number; records: number; scope: "latest-deploy" | "log"; source_path: string } | null;
  open_prs: { depth: number } | null;
  overlay: { overlay_total: number; source_path: string } | null;
  /** `ok` (moved within 72h), `stalled`, or `gap:<reason>` when movement is unmeasurable. */
  stall: "ok" | "stalled" | `gap:${string}`;
  stalled_since: string | null;
  top_line: string;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const round1 = (x: number) => Math.round(x * 10) / 10;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").trim();

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function readOverlay(path: string): { value: Census["overlay"]; cov: Coverage } {
  if (!existsSync(path)) return { value: null, cov: `gap:no manifest at ${path}` };
  try {
    const n = (JSON.parse(readFileSync(path, "utf8")) as { counts?: { overlay_total?: unknown } }).counts?.overlay_total;
    if (typeof n !== "number" || !Number.isFinite(n)) return { value: null, cov: `gap:manifest has no numeric counts.overlay_total (${path})` };
    return { value: { overlay_total: n, source_path: path }, cov: "ok" };
  } catch (e) {
    return { value: null, cov: `gap:unreadable manifest ${path}: ${errMsg(e)}` };
  }
}

type DeployRec = { override_reason?: unknown; built_at?: unknown };

function readOverrides(path: string, now: Date, windowDays: number): { value: Census["override_deploys"]; cov: Coverage } {
  if (!existsSync(path)) return { value: null, cov: `gap:no deploy record at ${path}` };
  let recs: DeployRec[];
  let scope: "latest-deploy" | "log";
  try {
    const text = readFileSync(path, "utf8").trim();
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        recs = parsed as DeployRec[];
        scope = "log";
      } else {
        recs = [parsed as DeployRec];
        scope = "latest-deploy";
      }
    } catch {
      // JSONL: one deploy record per line.
      recs = text.split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as DeployRec);
      scope = "log";
    }
    if (recs.some((r) => r === null || typeof r !== "object")) throw new Error("a record is not an object");
  } catch (e) {
    return { value: null, cov: `gap:unreadable deploy record ${path}: ${errMsg(e)}` };
  }
  const since = now.getTime() - windowDays * DAY;
  // A log is windowed; the single latest deploy.json is reported as-is (it is the only record).
  const inWindow = scope === "log" ? recs.filter((r) => typeof r.built_at !== "string" || Date.parse(r.built_at) >= since) : recs;
  const count = inWindow.filter((r) => typeof r.override_reason === "string" && r.override_reason.trim() !== "").length;
  return { value: { count, records: inWindow.length, scope, source_path: path }, cov: "ok" };
}

function attempt<T>(f: () => T): { ok: true; value: T } | { ok: false; gap: Coverage } {
  try {
    return { ok: true, value: f() };
  } catch (e) {
    return { ok: false, gap: `gap:${errMsg(e)}` };
  }
}

export function buildCensus(o: CensusOptions): Census {
  const nowMs = o.now.getTime();
  const coverage = {} as Record<CensusSource, Coverage>;

  // framework slices
  let slices: Census["framework_slices"] = null;
  let issues: FrameworkIssue[] | undefined;
  const fi = attempt(() => o.gh.frameworkIssues(o.prd));
  if (fi.ok) {
    issues = fi.value;
    const open = issues.filter((i) => i.state === "open");
    const items = open
      .map((i) => ({ issue: `${i.repo}#${i.number}`, title: i.title, age_days: round1((nowMs - Date.parse(i.created_at)) / DAY) }))
      .sort((a, b) => b.age_days - a.age_days);
    const ages = items.map((i) => i.age_days);
    slices = {
      open: open.length,
      closed: issues.length - open.length,
      oldest_age_days: ages.length ? Math.max(...ages) : null,
      median_age_days: median(ages),
      items,
    };
    coverage.framework_slices = "ok";
  } else coverage.framework_slices = fi.gap;

  // framework movement + stall
  let movement: Census["framework_movement"] = null;
  let stall: Census["stall"];
  let stalledSince: string | null = null;
  let stallRef: number | undefined;
  if (!issues) {
    coverage.framework_movement = "gap:framework slices unavailable";
    stall = "gap:framework movement unavailable";
  } else {
    const cp = attempt(() => o.gh.closingPrs(issues!.map((i) => ({ repo: i.repo, number: i.number }))));
    if (!cp.ok) {
      coverage.framework_movement = cp.gap;
      stall = `gap:framework movement unavailable (${cp.gap.slice(4)})`;
    } else {
      let lastMerge: { at: number; pr: string } | undefined;
      for (const i of cp.value)
        for (const p of i.prs) {
          const t = p.merged_at ? Date.parse(p.merged_at) : NaN;
          if (Number.isFinite(t) && t <= nowMs && (!lastMerge || t > lastMerge.at)) lastMerge = { at: t, pr: `${p.repo}#${p.number}` };
        }
      const closures = issues.map((i) => (i.closed_at ? Date.parse(i.closed_at) : NaN)).filter((t) => Number.isFinite(t) && t <= nowMs);
      const moves = [...closures, ...(lastMerge ? [lastMerge.at] : [])];
      const lastMoved = moves.length ? Math.max(...moves) : undefined;
      movement = {
        last_moved_at: lastMoved !== undefined ? new Date(lastMoved).toISOString() : null,
        last_merge_at: lastMerge ? new Date(lastMerge.at).toISOString() : null,
        last_merge_pr: lastMerge?.pr ?? null,
        days_since_last_merge: lastMerge ? round1((nowMs - lastMerge.at) / DAY) : null,
      };
      coverage.framework_movement = "ok";
      // Never moved → the tier has been frozen since its oldest slice was filed.
      const created = issues.map((i) => Date.parse(i.created_at)).filter(Number.isFinite);
      stallRef = lastMoved ?? (created.length ? Math.min(...created) : undefined);
      if (stallRef === undefined) stall = "gap:no framework slices to measure movement on";
      else if (nowMs - stallRef >= STALL_HOURS * HOUR) {
        stall = "stalled";
        stalledSince = new Date(stallRef).toISOString();
      } else stall = "ok";
    }
  }

  // merges with / without bypass
  let merges: Census["merges"] = null;
  const sinceMs = nowMs - o.windowDays * DAY;
  const mp = attempt(() => o.gh.mergedPrs(o.repo, o.base, new Date(sinceMs).toISOString()));
  if (mp.ok) {
    const inWin = mp.value.filter((p) => {
      const t = Date.parse(p.merged_at);
      return t >= sinceMs && t <= nowMs;
    });
    const bypass = inWin.filter((p) => p.review_decision !== "APPROVED");
    merges = {
      window_days: o.windowDays,
      total: inWin.length,
      without_bypass: inWin.length - bypass.length,
      with_bypass: bypass.length,
      bypass_prs: bypass.map((p) => p.number).sort((a, b) => a - b),
      bypass_rule: "best effort: merged with reviewDecision != APPROVED",
    };
    coverage.merges = "ok";
  } else coverage.merges = mp.gap;

  const od = readOverrides(o.deployRecordPath, o.now, o.windowDays);
  coverage.override_deploys = od.cov;

  let openPrs: Census["open_prs"] = null;
  const op = attempt(() => o.gh.openPrCount(o.repo));
  if (op.ok) {
    openPrs = { depth: op.value };
    coverage.open_prs = "ok";
  } else coverage.open_prs = op.gap;

  const ov = readOverlay(o.manifestPath);
  coverage.overlay = ov.cov;

  let topLine: string;
  if (stall === "stalled") {
    const h = Math.floor((nowMs - stallRef!) / HOUR);
    const what = movement?.last_moved_at ? `last moved ${stalledSince}` : `nothing moved since the oldest slice was filed ${stalledSince}`;
    topLine = `STALL: framework tier has not moved in ${STALL_HOURS}h (${h}h; ${what}${slices ? `; ${slices.open} open slices` : ""})`;
  } else if (stall === "ok") {
    const h = round1((nowMs - stallRef!) / HOUR);
    topLine = `framework tier moving: last movement ${h}h ago${slices ? `; ${slices.open} open slices` : ""}`;
  } else topLine = `framework stall check unavailable (${stall})`;

  const ordered = Object.fromEntries(CENSUS_SOURCES.map((s) => [s, coverage[s]])) as Record<CensusSource, Coverage>;
  return {
    verb: "census",
    rendered_at: o.now.toISOString(),
    prd: `${o.prd.repo}#${o.prd.number}`,
    repo: o.repo,
    base: o.base,
    window_days: o.windowDays,
    coverage: ordered,
    framework_slices: slices,
    framework_movement: movement,
    merges,
    override_deploys: od.value,
    open_prs: openPrs,
    overlay: ov.value,
    stall,
    stalled_since: stalledSince,
    top_line: topLine,
  };
}

// ── the brief line ───────────────────────────────────────────────────────────

/** 3–6 markdown lines for the morning brief. The stall (or its gap) is always the first line. */
export function renderBrief(c: Census): string {
  const gap = (s: CensusSource) => c.coverage[s];
  const okCount = CENSUS_SOURCES.filter((s) => c.coverage[s] === "ok").length;
  const gaps = CENSUS_SOURCES.filter((s) => c.coverage[s] !== "ok");
  const lines: string[] = [];
  lines.push(c.stall === "stalled" ? `**${c.top_line}**` : `**census-lite** — ${c.top_line}`);
  lines.push(`- rendered ${c.rendered_at} · coverage ${okCount}/${CENSUS_SOURCES.length} ok${gaps.length ? ` (gaps: ${gaps.join(", ")})` : ""}`);

  const sl = c.framework_slices
    ? `${c.framework_slices.open} open framework slices${c.framework_slices.oldest_age_days !== null ? ` (oldest ${c.framework_slices.oldest_age_days}d, median ${c.framework_slices.median_age_days}d)` : ""}`
    : `framework slices: ${gap("framework_slices")}`;
  const mv = c.framework_movement
    ? c.framework_movement.last_merge_at
      ? `last framework merge ${c.framework_movement.days_since_last_merge}d ago (${c.framework_movement.last_merge_pr})`
      : "no framework merge yet"
    : `last framework merge: ${gap("framework_movement")}`;
  lines.push(`- ${sl} · ${mv}`);

  lines.push(
    c.merges
      ? `- ${c.base} merges (${c.merges.window_days}d): ${c.merges.without_bypass} without bypass · ${c.merges.with_bypass} with bypass${c.merges.bypass_prs.length ? ` (${c.merges.bypass_prs.slice(0, 8).map((n) => `#${n}`).join(", ")}${c.merges.bypass_prs.length > 8 ? ", …" : ""})` : ""}`
      : `- ${c.base} merges (${c.window_days}d): ${gap("merges")}`,
  );

  const od = c.override_deploys ? `${c.override_deploys.count}${c.override_deploys.scope === "latest-deploy" ? " (latest deploy)" : ` of ${c.override_deploys.records} in ${c.window_days}d`}` : gap("override_deploys");
  const op = c.open_prs ? String(c.open_prs.depth) : gap("open_prs");
  const ov = c.overlay ? String(c.overlay.overlay_total) : gap("overlay");
  lines.push(`- override deploys: ${od} · open PRs: ${op} · overlay files: ${ov}`);
  return lines.join("\n") + "\n";
}

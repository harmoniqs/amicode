// `amico census` — census-lite + stall tripwire + brief line (rd-system v2.1 A0b, #1902).
//
// Every GitHub interaction rides the injected `CensusGh` layer (or the injected `gh api` runner
// beneath it); nothing here touches the network. Measurement entry under test:
// `census_lite_rendered_with_heartbeat` — a missing source renders a named gap (never a zero), a
// framework tier frozen 72h becomes the brief's top line.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CENSUS_SOURCES,
  STALL_HOURS,
  buildCensus,
  ghApiCensus,
  renderBrief,
  type CensusGh,
  type CensusOptions,
  type FrameworkIssue,
  type MergedPr,
} from "../src/census.js";
import { censusVerb } from "../src/census_verb.js";
import type { GhApiRunner } from "../src/spec_slices.js";

const NOW = new Date("2026-10-26T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "census-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function manifest(total: unknown = 1002): string {
  const p = join(dir, "manifest.json");
  writeFileSync(p, JSON.stringify({ counts: { overlay_total: total } }));
  return p;
}
function deployRecord(body: unknown): string {
  const p = join(dir, "deploy.json");
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
  return p;
}

/** Fixture GitHub. Any method can be made to throw to simulate a missing source. */
class FakeGh implements CensusGh {
  issues: FrameworkIssue[] = [
    { repo: "harmoniqs/amicode", number: 1902, title: "census-lite", state: "open", created_at: hoursAgo(24 * 5), closed_at: null },
    { repo: "harmoniqs/amicode", number: 1903, title: "reserve", state: "open", created_at: hoursAgo(24), closed_at: null },
    { repo: "harmoniqs/amicode", number: 1900, title: "spec slices", state: "closed", created_at: hoursAgo(24 * 6), closed_at: hoursAgo(30) },
  ];
  closing: Record<string, Array<{ repo: string; number: number; merged_at: string | null }>> = {
    "harmoniqs/amicode#1900": [{ repo: "harmoniqs/amicode", number: 1901, merged_at: hoursAgo(30) }],
  };
  merged: MergedPr[] = [
    { number: 1901, merged_at: hoursAgo(30), review_decision: "APPROVED" },
    { number: 1899, merged_at: hoursAgo(40), review_decision: "REVIEW_REQUIRED" },
    { number: 1898, merged_at: hoursAgo(50), review_decision: null },
  ];
  openPrs = 6;
  fail: Partial<Record<keyof CensusGh, string>> = {};
  private guard(m: keyof CensusGh) {
    if (this.fail[m]) throw new Error(this.fail[m]);
  }
  frameworkIssues() {
    this.guard("frameworkIssues");
    return this.issues;
  }
  closingPrs(issues: Array<{ repo: string; number: number }>) {
    this.guard("closingPrs");
    return issues.map((i) => ({ ...i, prs: this.closing[`${i.repo}#${i.number}`] ?? [] }));
  }
  mergedPrs() {
    this.guard("mergedPrs");
    return this.merged;
  }
  openPrCount() {
    this.guard("openPrCount");
    return this.openPrs;
  }
}

function opts(gh: CensusGh, over: Partial<CensusOptions> = {}): CensusOptions {
  return {
    gh,
    now: NOW,
    prd: { repo: "harmoniqs/amicode", number: 1820 },
    repo: "harmoniqs/amicode",
    base: "main",
    windowDays: 7,
    manifestPath: manifest(),
    deployRecordPath: deployRecord({ commit: "abc", override_reason: "hotfix", built_at: hoursAgo(10) }),
    ...over,
  };
}

describe("coverage — every source is named, ok or gap:<reason>", () => {
  it("all sources ok → coverage carries every source as `ok` and a render timestamp", () => {
    const c = buildCensus(opts(new FakeGh()));
    expect(Object.keys(c.coverage).sort()).toEqual([...CENSUS_SOURCES].sort());
    for (const s of CENSUS_SOURCES) expect(c.coverage[s]).toBe("ok");
    expect(c.rendered_at).toBe(NOW.toISOString());
    expect(c.framework_slices?.open).toBe(2);
    expect(c.framework_slices?.oldest_age_days).toBe(5);
    expect(c.open_prs?.depth).toBe(6);
    expect(c.overlay?.overlay_total).toBe(1002);
    expect(c.override_deploys?.count).toBe(1);
  });

  it("a failing gh source is a named gap and its value is null — never 0", () => {
    const gh = new FakeGh();
    gh.fail.openPrCount = "HTTP 502";
    gh.fail.mergedPrs = "rate limited";
    const c = buildCensus(opts(gh));
    expect(c.coverage.open_prs).toMatch(/^gap:.*HTTP 502/);
    expect(c.coverage.merges).toMatch(/^gap:.*rate limited/);
    expect(c.open_prs).toBeNull();
    expect(c.merges).toBeNull();
    const brief = renderBrief(c);
    expect(brief).toMatch(/open PRs: gap:/);
    expect(brief).toMatch(/merges.*gap:/);
    expect(brief).not.toMatch(/open PRs: 0/);
  });

  it("a missing manifest is a named gap, not overlay 0", () => {
    const c = buildCensus(opts(new FakeGh(), { manifestPath: join(dir, "nope.json") }));
    expect(c.coverage.overlay).toMatch(/^gap:no manifest at /);
    expect(c.overlay).toBeNull();
    expect(renderBrief(c)).toMatch(/overlay files: gap:no manifest/);
  });

  it("a manifest without counts.overlay_total is a named gap", () => {
    const c = buildCensus(opts(new FakeGh(), { manifestPath: manifest("lots") }));
    expect(c.coverage.overlay).toMatch(/^gap:.*overlay_total/);
    expect(c.overlay).toBeNull();
  });

  it("no deploy provenance record → override_deploys is a named gap", () => {
    const c = buildCensus(opts(new FakeGh(), { deployRecordPath: join(dir, "missing", "deploy.json") }));
    expect(c.coverage.override_deploys).toMatch(/^gap:no deploy record at /);
    expect(c.override_deploys).toBeNull();
    expect(renderBrief(c)).toMatch(/override deploys: gap:no deploy record/);
  });

  it("a framework-slices failure gaps slices AND movement, and the stall check is a gap, not 'not stalled'", () => {
    const gh = new FakeGh();
    gh.fail.frameworkIssues = "HTTP 403";
    const c = buildCensus(opts(gh));
    expect(c.coverage.framework_slices).toMatch(/^gap:.*HTTP 403/);
    expect(c.coverage.framework_movement).toMatch(/^gap:/);
    expect(c.framework_slices).toBeNull();
    expect(c.stall).toMatch(/^gap:/);
    expect(c.stalled_since).toBeNull();
    expect(renderBrief(c).split("\n")[0]).toMatch(/stall check unavailable/);
  });

  it("a closing-PR lookup failure gaps movement only", () => {
    const gh = new FakeGh();
    gh.fail.closingPrs = "graphql error";
    const c = buildCensus(opts(gh));
    expect(c.coverage.framework_slices).toBe("ok");
    expect(c.coverage.framework_movement).toMatch(/^gap:.*graphql error/);
    expect(c.stall).toMatch(/^gap:/);
  });
});

describe("override deploys — read from the local provenance record", () => {
  it("a single deploy.json counts its override (scope latest-deploy); no override → 0 is a measured 0", () => {
    const c1 = buildCensus(opts(new FakeGh()));
    expect(c1.override_deploys).toMatchObject({ count: 1, scope: "latest-deploy" });
    const c0 = buildCensus(opts(new FakeGh(), { deployRecordPath: deployRecord({ commit: "abc", override_reason: null, built_at: hoursAgo(1) }) }));
    expect(c0.coverage.override_deploys).toBe("ok");
    expect(c0.override_deploys?.count).toBe(0);
  });

  it("a JSONL log counts overrides inside the window only", () => {
    const lines = [
      { override_reason: "a", built_at: hoursAgo(1) },
      { override_reason: "", built_at: hoursAgo(2) },
      { override_reason: "old", built_at: hoursAgo(24 * 9) },
      { override_reason: "b", built_at: hoursAgo(24 * 6) },
    ];
    const c = buildCensus(opts(new FakeGh(), { deployRecordPath: deployRecord(lines.map((l) => JSON.stringify(l)).join("\n")) }));
    expect(c.override_deploys).toMatchObject({ count: 2, scope: "log", records: 3 });
  });

  it("an unparseable record is a named gap", () => {
    const c = buildCensus(opts(new FakeGh(), { deployRecordPath: deployRecord("{not json") }));
    expect(c.coverage.override_deploys).toMatch(/^gap:unreadable deploy record/);
  });
});

describe("bypass counting — merged PRs on main whose reviewDecision != APPROVED", () => {
  it("APPROVED is without bypass; REVIEW_REQUIRED / CHANGES_REQUESTED / null are bypass", () => {
    const gh = new FakeGh();
    gh.merged = [
      { number: 1, merged_at: hoursAgo(1), review_decision: "APPROVED" },
      { number: 2, merged_at: hoursAgo(2), review_decision: "APPROVED" },
      { number: 3, merged_at: hoursAgo(3), review_decision: "REVIEW_REQUIRED" },
      { number: 4, merged_at: hoursAgo(4), review_decision: "CHANGES_REQUESTED" },
      { number: 5, merged_at: hoursAgo(5), review_decision: null },
    ];
    const c = buildCensus(opts(gh));
    expect(c.merges).toMatchObject({ total: 5, without_bypass: 2, with_bypass: 3, bypass_prs: [3, 4, 5], window_days: 7 });
  });

  it("merges outside the window are excluded even if the search returned them", () => {
    const gh = new FakeGh();
    gh.merged = [
      { number: 1, merged_at: hoursAgo(24 * 7 - 1), review_decision: null },
      { number: 2, merged_at: hoursAgo(24 * 7 + 1), review_decision: null },
    ];
    const c = buildCensus(opts(gh));
    expect(c.merges).toMatchObject({ total: 1, with_bypass: 1, bypass_prs: [1] });
  });

  it("a measured zero merges renders as 0 (it is ok, not a gap)", () => {
    const gh = new FakeGh();
    gh.merged = [];
    const c = buildCensus(opts(gh));
    expect(c.coverage.merges).toBe("ok");
    expect(c.merges).toMatchObject({ total: 0, with_bypass: 0, without_bypass: 0 });
  });
});

describe("stall tripwire — a framework tier frozen 72h becomes the top line", () => {
  function ghMovedAt(h: number): FakeGh {
    const gh = new FakeGh();
    gh.issues = [
      { repo: "harmoniqs/amicode", number: 10, title: "a", state: "open", created_at: hoursAgo(24 * 10), closed_at: null },
      { repo: "harmoniqs/amicode", number: 11, title: "b", state: "closed", created_at: hoursAgo(24 * 10), closed_at: hoursAgo(h) },
    ];
    gh.closing = { "harmoniqs/amicode#11": [{ repo: "harmoniqs/amicode", number: 12, merged_at: hoursAgo(h) }] };
    return gh;
  }

  it("STALL_HOURS is 72", () => expect(STALL_HOURS).toBe(72));

  it("moved 71h59m ago → not stalled; top line is not a STALL", () => {
    const c = buildCensus(opts(ghMovedAt(71 + 59 / 60)));
    expect(c.stall).toBe("ok");
    expect(c.stalled_since).toBeNull();
    expect(c.top_line).not.toMatch(/STALL/);
    expect(renderBrief(c).split("\n")[0]).not.toMatch(/STALL/);
  });

  it("moved exactly 72h ago → stalled, stalled_since = last movement, STALL is the brief's first line", () => {
    const c = buildCensus(opts(ghMovedAt(72)));
    expect(c.stall).toBe("stalled");
    expect(c.stalled_since).toBe(hoursAgo(72));
    expect(c.top_line).toMatch(/^STALL: framework tier has not moved in 72h/);
    expect(renderBrief(c).split("\n")[0]).toContain(c.top_line);
  });

  it("the last movement is the latest of closing-PR merges and slice closures", () => {
    const gh = ghMovedAt(100);
    gh.closing["harmoniqs/amicode#10"] = [{ repo: "harmoniqs/amicode", number: 13, merged_at: hoursAgo(5) }];
    const c = buildCensus(opts(gh));
    expect(c.framework_movement).toMatchObject({ last_moved_at: hoursAgo(5), last_merge_at: hoursAgo(5), last_merge_pr: "harmoniqs/amicode#13" });
    expect(c.stall).toBe("ok");
  });

  it("unmerged closing PRs are not movement", () => {
    const gh = ghMovedAt(100);
    gh.closing["harmoniqs/amicode#10"] = [{ repo: "harmoniqs/amicode", number: 13, merged_at: null }];
    expect(buildCensus(opts(gh)).framework_movement?.last_moved_at).toBe(hoursAgo(100));
  });

  it("a tier that never moved is stalled since its oldest slice was filed", () => {
    const gh = new FakeGh();
    gh.issues = [
      { repo: "harmoniqs/amicode", number: 10, title: "a", state: "open", created_at: hoursAgo(80), closed_at: null },
      { repo: "harmoniqs/amicode", number: 11, title: "b", state: "open", created_at: hoursAgo(10), closed_at: null },
    ];
    gh.closing = {};
    const c = buildCensus(opts(gh));
    expect(c.framework_movement?.last_moved_at).toBeNull();
    expect(c.stall).toBe("stalled");
    expect(c.stalled_since).toBe(hoursAgo(80));
  });
});

describe("renderBrief — 3–6 markdown lines for the morning brief", () => {
  it("carries the timestamp, coverage, and each census line", () => {
    const c = buildCensus(opts(new FakeGh()));
    const lines = renderBrief(c).trimEnd().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeLessThanOrEqual(6);
    const text = lines.join("\n");
    expect(text).toContain(NOW.toISOString());
    expect(text).toMatch(/coverage 6\/6 ok/);
    expect(text).toMatch(/2 open framework slices/);
    expect(text).toMatch(/1 without bypass · 2 with bypass/);
    expect(text).toMatch(/override deploys: 1/);
    expect(text).toMatch(/open PRs: 6/);
    expect(text).toMatch(/overlay files: 1002/);
  });

  it("names the gapped sources in the coverage line", () => {
    const gh = new FakeGh();
    gh.fail.openPrCount = "boom";
    const c = buildCensus(opts(gh, { manifestPath: join(dir, "x.json") }));
    expect(renderBrief(c)).toMatch(/coverage 4\/6 ok \(gaps: open_prs, overlay\)/);
  });

  it("stays within 6 lines when stalled and gapped", () => {
    const gh = new FakeGh();
    gh.issues = [{ repo: "harmoniqs/amicode", number: 10, title: "a", state: "open", created_at: hoursAgo(200), closed_at: null }];
    gh.closing = {};
    gh.fail.mergedPrs = "x";
    const lines = renderBrief(buildCensus(opts(gh))).trimEnd().split("\n");
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines[0]).toMatch(/STALL/);
  });
});

describe("ghApiCensus — the `gh api` argument shapes and parsing", () => {
  type Route = [RegExp, string | { code: number; stderr: string }];
  function recorder(routes: Route[]): { calls: string[][]; runner: GhApiRunner } {
    const calls: string[][] = [];
    const runner: GhApiRunner = (args) => {
      calls.push(args);
      const joined = args.join(" ");
      for (const [re, out] of routes)
        if (re.test(joined)) return typeof out === "string" ? { code: 0, stdout: out, stderr: "" } : { code: out.code, stdout: "", stderr: out.stderr };
      return { code: 1, stdout: "", stderr: `no route for ${joined}` };
    };
    return { calls, runner };
  }
  const raw = (n: number, state: string, body = "", repo = "harmoniqs/amicode") => ({
    id: n * 10,
    number: n,
    title: `t${n}`,
    state,
    created_at: "2026-10-20T00:00:00Z",
    closed_at: state === "closed" ? "2026-10-21T00:00:00Z" : null,
    body,
    repository_url: `https://api.github.com/repos/${repo}`,
  });

  it("frameworkIssues unions PRD sub-issues with marker-carrying search hits, de-duplicated", () => {
    const { calls, runner } = recorder([
      [/sub_issues/, JSON.stringify([[raw(1, "open"), raw(2, "closed")]])],
      [/search\/issues/, JSON.stringify([{ items: [raw(2, "closed", "<!-- amico-spec-slices spec=x row=1 hash=ab -->"), raw(3, "open", "<!-- amico-spec-slices spec=x row=2 hash=ab -->", "harmoniqs/arJev"), raw(4, "open", "mentions amico spec slices only")] }])],
    ]);
    const out = ghApiCensus(runner).frameworkIssues({ repo: "harmoniqs/amicode", number: 1820 });
    expect(out.map((i) => `${i.repo}#${i.number}`).sort()).toEqual(["harmoniqs/amicode#1", "harmoniqs/amicode#2", "harmoniqs/arJev#3"]);
    expect(out.find((i) => i.number === 2)).toMatchObject({ state: "closed", closed_at: "2026-10-21T00:00:00Z" });
    expect(calls[0]).toEqual(["--paginate", "--slurp", "repos/harmoniqs/amicode/issues/1820/sub_issues?per_page=100"]);
    expect(calls[1].join(" ")).toContain("q=org:harmoniqs is:issue in:body amico-spec-slices");
  });

  it("closingPrs batches one GraphQL query per repo and keeps mergedAt", () => {
    const { calls, runner } = recorder([
      [
        /graphql/,
        JSON.stringify({
          data: {
            repository: {
              i5: { closedByPullRequestsReferences: { nodes: [{ number: 6, mergedAt: "2026-10-25T00:00:00Z", repository: { nameWithOwner: "harmoniqs/amicode" } }, { number: 7, mergedAt: null, repository: { nameWithOwner: "harmoniqs/amicode" } }] } },
              i8: null,
            },
          },
        }),
      ],
    ]);
    const out = ghApiCensus(runner).closingPrs([
      { repo: "harmoniqs/amicode", number: 5 },
      { repo: "harmoniqs/amicode", number: 8 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("graphql");
    expect(calls[0].join(" ")).toMatch(/i5: issue\(number: 5\)[\s\S]*i8: issue\(number: 8\)/);
    expect(out).toEqual([
      { repo: "harmoniqs/amicode", number: 5, prs: [{ repo: "harmoniqs/amicode", number: 6, merged_at: "2026-10-25T00:00:00Z" }, { repo: "harmoniqs/amicode", number: 7, merged_at: null }] },
      { repo: "harmoniqs/amicode", number: 8, prs: [] },
    ]);
  });

  it("a GraphQL `errors` payload is a thrown error (→ gap), not an empty result", () => {
    const { runner } = recorder([[/graphql/, JSON.stringify({ errors: [{ message: "bad field" }] })]]);
    expect(() => ghApiCensus(runner).openPrCount("harmoniqs/amicode")).toThrow(/bad field/);
  });

  it("mergedPrs searches merged PRs on the base since the window start and pages by cursor", () => {
    let page = 0;
    const calls: string[][] = [];
    const runner: GhApiRunner = (args) => {
      calls.push(args);
      page++;
      const nodes = page === 1 ? [{ number: 1, mergedAt: "2026-10-25T00:00:00Z", reviewDecision: "APPROVED" }] : [{ number: 2, mergedAt: "2026-10-24T00:00:00Z", reviewDecision: null }];
      return { code: 0, stderr: "", stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: page === 1, endCursor: "C1" }, nodes } } }) };
    };
    const out = ghApiCensus(runner).mergedPrs("harmoniqs/amicode", "main", "2026-10-19T12:00:00Z");
    expect(out).toEqual([
      { number: 1, merged_at: "2026-10-25T00:00:00Z", review_decision: "APPROVED" },
      { number: 2, merged_at: "2026-10-24T00:00:00Z", review_decision: null },
    ]);
    expect(calls[0].join(" ")).toContain("q=repo:harmoniqs/amicode is:pr is:merged base:main merged:>=2026-10-19");
    expect(calls[1].join(" ")).toContain("cursor=C1");
  });

  it("openPrCount reads issueCount; a gh failure throws with stderr", () => {
    const ok = recorder([[/graphql/, JSON.stringify({ data: { search: { issueCount: 9 } } })]]);
    expect(ghApiCensus(ok.runner).openPrCount("harmoniqs/amicode")).toBe(9);
    expect(ok.calls[0].join(" ")).toContain("q=repo:harmoniqs/amicode is:pr is:open");
    const bad = recorder([[/graphql/, { code: 1, stderr: "HTTP 401: Bad credentials" }]]);
    expect(() => ghApiCensus(bad.runner).openPrCount("harmoniqs/amicode")).toThrow(/Bad credentials/);
  });
});

describe("censusVerb — CLI surface", () => {
  const ctx = () => ({ gh: new FakeGh(), now: () => NOW });

  it("default emits the census JSON with verb, rendered_at, coverage, stalled_since", async () => {
    const r = await censusVerb(["--manifest", manifest(), "--deploy-record", join(dir, "none.json")], ctx());
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.verb).toBe("census");
    expect(j.rendered_at).toBe(NOW.toISOString());
    expect(j).toHaveProperty("stalled_since");
    expect((j.coverage as Record<string, string>).override_deploys).toMatch(/^gap:/);
    expect(r.brief).toBeUndefined();
  });

  it("--brief returns the markdown rendering alongside the JSON", async () => {
    const r = await censusVerb(["--brief", "--manifest", manifest()], ctx());
    expect(r.code).toBe(0);
    expect(r.brief).toMatch(/census-lite/);
    expect(r.brief!.trimEnd().split("\n").length).toBeLessThanOrEqual(6);
  });

  it("--window-days and --prd are honored; bad values are usage errors (64)", async () => {
    const r = await censusVerb(["--window-days", "3", "--prd", "harmoniqs/amicode#1820", "--manifest", manifest()], ctx());
    expect((r.json as { merges: { window_days: number } }).merges.window_days).toBe(3);
    expect((await censusVerb(["--window-days", "zero"], ctx())).code).toBe(64);
    expect((await censusVerb(["--prd", "nope"], ctx())).code).toBe(64);
    expect((await censusVerb(["--bogus"], ctx())).code).toBe(64);
  });
});

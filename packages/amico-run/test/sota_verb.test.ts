// sota_verb.test.ts — the `amico sota` verb (#820): the survey surface the
// sota-review skill drives. Hermetic end-to-end: the FETCH cache is seeded
// with fixture payloads (the arXiv Atom fixture + GitHub-shaped fixtures),
// so the verb exercises its REAL production path — cache → queue → parse →
// brief — with ZERO transports. The queue lock, TTL lease, and bounded wait
// are the lens tests' territory; this pins the VERB's contract: usage
// errors, the brief in the JSON, the named outcomes, and the codebase
// round's stamps + retire-or-confirm flags.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sotaVerb } from "../src/sota_verb.js";
import { arxivApiUrl, parseArxivAtom } from "../src/sota_papers.js";
import { githubApiUrl, registryPath } from "../src/sota_codebase.js";
import { cachePath } from "../src/sota_fetch.js";
import { parseWatchedRepoRegistry } from "@amicode/schema";
import { readFileSync as rf } from "node:fs";

const ATOM_FIXTURE = rf(join(__dirname, "fixtures", "sota", "arxiv-live-atom.xml"), "utf8"); // the recorded real-API payload
const FETCHED_AT = "2026-09-05T18:22:20Z"; // the recorded call's harvest time (the feed's own <updated>)

const RELEASES_JSON = JSON.stringify([
  {
    tag_name: "v0.9.0",
    name: "v0.9.0 — trajectory rework",
    published_at: "2026-08-20T00:00:00Z",
    html_url: "https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0",
    body: "breaking: trajectory API now requires integrator selection",
  },
]);

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-verb-"));
}

describe("`amico sota papers` — one on-demand query through the queue", () => {
  it("serves the seeded REAL-API payload from the cache and returns the cited brief", async () => {
    const r = root();
    const url = arxivApiUrl(["optimal control"], 5);
    mkdirSync(join(r, "fetch-cache"), { recursive: true });
    writeFileSync(cachePath(r, url), JSON.stringify({ url, fetched_at: FETCHED_AT, body: ATOM_FIXTURE }) + "\n");
    const res = await sotaVerb(["papers", "--query", "optimal control", "--top", "5", "--root", r]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; via: string; results: number; brief: string; entries: { arxiv: string; url: string }[] };
    expect(j.ok).toBe(true);
    expect(j.via).toBe("cache"); // the verb's own production path reads the cache — no transport ran
    expect(j.results).toBe(parseArxivAtom(ATOM_FIXTURE).length);
    expect(j.results).toBeGreaterThan(0);
    for (const e of j.entries) expect(e.url).toBe(`https://arxiv.org/abs/${e.arxiv}`); // CITED
    expect(j.brief).toMatch(/provenance:/); // STAMPED
    expect(j.brief).toContain("source: arXiv export API over HTTPS");
  });

  it("missing --query is a usage error (exit 64, never a wildcard firehose)", async () => {
    const res = await sotaVerb(["papers", "--root", root()]);
    expect(res.code).toBe(64);
  });

  it("an out-of-range --top is a usage error", async () => {
    const res = await sotaVerb(["papers", "--query", "x", "--top", "0", "--root", root()]);
    expect(res.code).toBe(64);
  });
});

describe("`amico sota codebase` — one watched-repo fetch round", () => {
  const REGISTRY_TOML = `
schema_version = "1"
failure_threshold = 2

[[repos]]
repo = "example/piccolo-adjacent"
why_watched = "API shifts adjacent to our authoring map"
domains = ["julia-optimal-control"]
fetch_surface = ["releases"]
match_keywords = ["trajectory"]
`;

  function seededRoot(): string {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    mkdirSync(join(r, "fetch-cache"), { recursive: true });
    const url = githubApiUrl("example/piccolo-adjacent", "releases");
    writeFileSync(cachePath(r, url), JSON.stringify({ url, fetched_at: "2026-09-05T18:00:00Z", body: RELEASES_JSON }) + "\n");
    return r;
  }

  it("fetches via the cache, filters by match_keywords, cites the event, stamps the registry", async () => {
    const r = seededRoot();
    const res = await sotaVerb(["codebase", "--root", r]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; brief: string; repos: { repo: string; events: number; flagged_for_retire_or_confirm: boolean }[]; stamped_at: string };
    expect(j.ok).toBe(true);
    expect(j.repos).toHaveLength(1);
    expect(j.repos[0].events).toBe(1); // the trajectory release matched
    expect(j.brief).toContain("https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0"); // CITED
    expect(j.brief).toContain("why-watched: API shifts adjacent to our authoring map");
    expect(j.brief).toMatch(/provenance:/);
    // the stamps persisted to the living registry
    const persisted = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
    expect(persisted.repos[0].last_success).toBe(j.stamped_at);
    expect(persisted.repos[0].consecutive_failures).toBe(0);
  });

  it("--repo filters the round to the named canonical repos", async () => {
    const r = seededRoot();
    const res = await sotaVerb(["codebase", "--repo", "example/piccolo-adjacent", "--root", r]);
    expect(res.code).toBe(0);
    const j = res.json as { repos: { repo: string }[] };
    expect(j.repos.map((x) => x.repo)).toEqual(["example/piccolo-adjacent"]);
  });

  it("a non-canonical --repo (a local path smuggle) is a usage error", async () => {
    const res = await sotaVerb(["codebase", "--repo", "../etc/passwd", "--root", root()]);
    expect(res.code).toBe(64);
    expect((res.json as { error: string }).error).toMatch(/owner\/name/);
  });

  it("an unknown lens head is a usage error with the usage text", async () => {
    const res = await sotaVerb(["frobnicate", "--root", root()]);
    expect(res.code).toBe(64);
    expect((res.json as { error: string }).error).toMatch(/unknown lens/);
  });
});

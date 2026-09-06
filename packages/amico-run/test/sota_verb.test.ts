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
// B2: the verb path injects NO clock — the cache seed must be fresh against the
// REAL test clock (a fixed stamp goes stale past the 6h TTL and fires a live
// curl in CI). new Date() here is always fresh: the test runs in seconds.
const FETCHED_AT = new Date().toISOString();

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
    writeFileSync(cachePath(r, url), JSON.stringify({ url, fetched_at: FETCHED_AT, body: ATOM_FIXTURE, count: parseArxivAtom(ATOM_FIXTURE).length }) + "\n");
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
    writeFileSync(cachePath(r, url), JSON.stringify({ url, fetched_at: new Date().toISOString(), body: RELEASES_JSON, count: 1 }) + "\n");
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

// ── living-sota slice 2: the staged-routing verb surface (#living-sota D3) ────

import { mkdtempSync as mkdtemp2, mkdirSync as mkdir2, writeFileSync as wf2, readFileSync as rf2 } from "node:fs";
import {
  appendStageLine,
  stagingStreamPath,
  deriveStagingState,
  EXPIRES_AFTER_DAYS,
  HOPPER_CAMPAIGN,
} from "../src/sota_staging.js";

const ACTIVE_LEDGER = `# Session ledger — Rydberg trajectory integrator

## 2. Verdict table

| item | status |
|---|---|
| H1 integrator drift audit | pending |
`;

function verbSessions(): { dir: string; sessions: string } {
  const dir = mkdtemp2(join(tmpdir(), "sota-verb2-"));
  const sessions = join(dir, "sessions");
  mkdir2(sessions, { recursive: true });
  wf2(join(sessions, "session-20260901-rydberg-integrator.md"), ACTIVE_LEDGER);
  return { dir, sessions };
}

describe("`amico sota watcher` — one watched-repo round routed through staging", () => {
  it("rides the codebase lens and stages matched events into the campaign sidecar (hermetic: seeded cache)", async () => {
    const r = root();
    writeFileSync(registryPath(r), `
schema_version = "1"
failure_threshold = 7

[[repos]]
repo = "example/piccolo-adjacent"
why_watched = "API shifts adjacent to our authoring map"
domains = ["julia-optimal-control"]
fetch_surface = ["releases"]
match_keywords = ["trajectory", "rydberg"]
`);
    mkdirSync(join(r, "fetch-cache"), { recursive: true });
    writeFileSync(cachePath(r, githubApiUrl("example/piccolo-adjacent", "releases")), JSON.stringify({ url: "x", fetched_at: new Date().toISOString(), body: RELEASES_JSON, count: 1 }) + "\n");
    const { sessions } = verbSessions();
    const res = await sotaVerb(["watcher", "--root", r, "--sessions", sessions]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; staged: { event_id: string; campaign: string }[]; deduped: string[] };
    expect(j.ok).toBe(true);
    expect(j.staged).toHaveLength(1);
    expect(j.staged[0]).toMatchObject({ event_id: "github:example/piccolo-adjacent@v0.9.0", campaign: "session-20260901-rydberg-integrator" });
    expect(deriveStagingState(stagingStreamPath(sessions, "session-20260901-rydberg-integrator")).entries.get("github:example/piccolo-adjacent@v0.9.0")?.state).toBe("staged");
  });
});

describe("`amico sota accept` — the PI-instructed acceptance stamp (the sole sanctioned non-job append)", () => {
  it("promotes a staged match on the PI's explicit instruction, recording the instruction provenance", async () => {
    const { sessions } = verbSessions();
    // stage one item through the machinery (the digest's writer)
    appendStageLine(stagingStreamPath(sessions, "session-20260901-rydberg-integrator"), {
      event_id: "arxiv:2606.05060",
      campaign: "session-20260901-rydberg-integrator",
      kind: "paper",
      title: "Fast Rydberg trajectory gates",
      url: "https://arxiv.org/abs/2606.05060",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
      matched: ["rydberg", "trajectory"],
    });
    const res = await sotaVerb([
      "accept",
      "--campaign", "session-20260901-rydberg-integrator",
      "--event", "arxiv:2606.05060",
      "--note", "the integrator drift is load-bearing — accept",
      "--sessions", sessions,
    ]);
    expect(res.code).toBe(0);
    expect(deriveStagingState(stagingStreamPath(sessions, "session-20260901-rydberg-integrator")).entries.get("arxiv:2606.05060")?.state).toBe("accepted");
  });

  it("an accept without a staged match is a NAMED refusal (exit 1) — never a free-floating stamp", async () => {
    const { sessions } = verbSessions();
    const res = await sotaVerb(["accept", "--campaign", "session-20260901-rydberg-integrator", "--event", "arxiv:ghost", "--note", "x", "--sessions", sessions]);
    expect(res.code).toBe(1);
    expect((res.json as { error: string }).error).toMatch(/no staged match/i);
  });

  it("a second accept is an idempotent no-op (exit 0, still one accept line)", async () => {
    const { sessions } = verbSessions();
    const path = stagingStreamPath(sessions, "session-20260901-rydberg-integrator");
    appendStageLine(path, {
      event_id: "arxiv:2606.05060",
      campaign: "session-20260901-rydberg-integrator",
      kind: "paper",
      title: "t",
      url: "https://arxiv.org/abs/2606.05060",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
    });
    await sotaVerb(["accept", "--campaign", "session-20260901-rydberg-integrator", "--event", "arxiv:2606.05060", "--note", "first", "--sessions", sessions]);
    const again = await sotaVerb(["accept", "--campaign", "session-20260901-rydberg-integrator", "--event", "arxiv:2606.05060", "--note", "again", "--sessions", sessions]);
    expect(again.code).toBe(0);
    const lines = rf2(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2); // stage + accept — the stamp records once
  });

  it("a missing --note is a usage error — the schema records the instruction, an unstamped acceptance is refused", async () => {
    const { sessions } = verbSessions();
    const res = await sotaVerb(["accept", "--campaign", "session-20260901-rydberg-integrator", "--event", "x", "--sessions", sessions]);
    expect(res.code).toBe(64);
  });

  it("a campaign stem that could traverse is a usage error (the sidecar path is a file name, never a path)", async () => {
    const { sessions } = verbSessions();
    const res = await sotaVerb(["accept", "--campaign", "../../etc", "--event", "x", "--note", "x", "--sessions", sessions]);
    expect(res.code).toBe(64);
  });
});

describe("`amico sota awaiting-the-eye` — the pending listing from derived state", () => {
  it("renders pending staged matches + expired-without-review counts, never accepted material", async () => {
    const { sessions } = verbSessions();
    const path = stagingStreamPath(sessions, "session-20260901-rydberg-integrator");
    appendStageLine(path, {
      event_id: "arxiv:2606.05060",
      campaign: "session-20260901-rydberg-integrator",
      kind: "paper",
      title: "Fast Rydberg trajectory gates",
      url: "https://arxiv.org/abs/2606.05060",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
      matched: ["rydberg", "trajectory"],
    });
    appendStageLine(stagingStreamPath(sessions, HOPPER_CAMPAIGN), {
      event_id: "arxiv:2606.99999",
      campaign: HOPPER_CAMPAIGN,
      kind: "paper",
      title: "Protein folding via deep learning",
      url: "https://arxiv.org/abs/2606.99999",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
      matched: [],
      reason: "below-threshold",
    });
    const res = await sotaVerb(["awaiting-the-eye", "--sessions", sessions]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; text: string; pending: number; expired_without_review: number };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(2);
    expect(j.expired_without_review).toBe(0);
    expect(j.text).toContain("Fast Rydberg trajectory gates");
    expect(j.text).toContain("Protein folding via deep learning");
    expect(j.text).toMatch(/never rendered as currency/i);
  });

  it("a swept-and-expired campaign reads in the expired count (chronic non-review masks itself)", async () => {
    const { sessions } = verbSessions();
    const path = stagingStreamPath(sessions, "session-20260901-rydberg-integrator");
    const now = Date.now();
    appendStageLine(path, {
      event_id: "arxiv:2606.05060",
      campaign: "session-20260901-rydberg-integrator",
      kind: "paper",
      title: "old",
      url: "https://arxiv.org/abs/2606.05060",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
    }, { nowMs: () => now - (EXPIRES_AFTER_DAYS + 1) * 86_400_000 });
    const sweep = await sotaVerb(["sweep", "--sessions", sessions]);
    expect(sweep.code).toBe(0);
    const res = await sotaVerb(["awaiting-the-eye", "--sessions", sessions]);
    const j = res.json as { pending: number; expired_without_review: number };
    expect(j.pending).toBe(0);
    expect(j.expired_without_review).toBe(1);
  });
});

describe("`amico sota sweep` — the job's expiry + compaction pass (O2's cadence driver)", () => {
  it("drops expired staged matches with the recorded line and compacts nothing inside the window", async () => {
    const { sessions } = verbSessions();
    const path = stagingStreamPath(sessions, "session-20260901-rydberg-integrator");
    const now = Date.now();
    appendStageLine(path, {
      event_id: "arxiv:2606.05060",
      campaign: "session-20260901-rydberg-integrator",
      kind: "paper",
      title: "old",
      url: "https://arxiv.org/abs/2606.05060",
      provenance: { job: "papers-digest", via: "fetched", source: "arXiv export API over HTTPS", fetched_at: new Date().toISOString() },
    }, { nowMs: () => now - (EXPIRES_AFTER_DAYS + 1) * 86_400_000 });
    const res = await sotaVerb(["sweep", "--sessions", sessions]);
    expect(res.code).toBe(0);
    const j = res.json as { ok: boolean; streams: { campaign: string; dropped: string[]; compacted: number }[] };
    expect(j.streams).toHaveLength(1);
    expect(j.streams[0]).toMatchObject({ campaign: "session-20260901-rydberg-integrator", dropped: ["arxiv:2606.05060"], compacted: 0 });
    expect(deriveStagingState(path).entries.get("arxiv:2606.05060")?.state).toBe("dropped");
  });
});

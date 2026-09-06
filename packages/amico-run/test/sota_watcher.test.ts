// sota_watcher.test.ts — the SOTA watcher (#living-sota slice 2, spec
// spec-20260905-103000 D3 / S3): release/changelog/issue events from the
// watched-repo registry ride the IDENTICAL staged path as papers — the slice-1
// codebase lens provides the fetch (GitHub API against canonical repos, never
// a local checkout); the watcher adds the ROUTING: matched events enumerate
// the active campaigns and append stage lines through the same sota_staging
// machinery, idempotent by event id, provenance-stamped with the repo+surface.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSotaWatcher } from "../src/sota_watcher.js";
import { githubApiUrl, registryPath } from "../src/sota_codebase.js";
import { cachePath } from "../src/sota_fetch.js";
import { stagingStreamPath, deriveStagingState } from "../src/sota_staging.js";

let root: string;
let sessionsDir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sota-watcher-"));
  sessionsDir = join(root, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const REGISTRY_TOML = `
schema_version = "1"
failure_threshold = 7

[[repos]]
repo = "example/piccolo-adjacent"
why_watched = "API shifts adjacent to our authoring map"
domains = ["julia-optimal-control"]
fetch_surface = ["releases", "issues"]
match_keywords = ["trajectory", "rydberg"]
`;

const RELEASES_JSON = JSON.stringify([
  {
    tag_name: "v0.9.0",
    name: "v0.9.0 — trajectory rework",
    published_at: "2026-08-20T00:00:00Z",
    html_url: "https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0",
    body: "breaking: the Rydberg trajectory API now requires integrator selection",
  },
]);

const ISSUES_JSON = JSON.stringify([
  {
    number: 42,
    title: "Rydberg subsystem levels regression",
    html_url: "https://github.com/example/piccolo-adjacent/issues/42",
    updated_at: "2026-08-22T00:00:00Z",
    body: "the trajectory integrator regressed for rydberg subsystem_levels",
  },
]);

const ACTIVE_LEDGER = `# Session ledger — Rydberg trajectory integrator

## 1. Objective & standing directives

- Objective: keep the rydberg integrator selection honest across the trajectory rework.

## 2. Verdict table

| item | status |
|---|---|
| H1 integrator drift audit | pending |
`;

const CLOCK_MS = 1_000_000_000_000;

function seed(): void {
  writeFileSync(registryPath(root), REGISTRY_TOML);
  mkdirSync(join(root, "fetch-cache"), { recursive: true });
  // the cache seed stamps AT the frozen fake clock — the TTL freshness check
  // compares fetched_at against the same nowMs the watcher runs on
  const stamp = new Date(CLOCK_MS).toISOString();
  writeFileSync(cachePath(root, githubApiUrl("example/piccolo-adjacent", "releases")), JSON.stringify({ url: "x", fetched_at: stamp, body: RELEASES_JSON, count: 1 }) + "\n");
  writeFileSync(cachePath(root, githubApiUrl("example/piccolo-adjacent", "issues")), JSON.stringify({ url: "x", fetched_at: stamp, body: ISSUES_JSON, count: 1 }) + "\n");
  writeFileSync(join(sessionsDir, "session-20260901-rydberg-integrator.md"), ACTIVE_LEDGER);
}

describe("runSotaWatcher — the watcher rides the IDENTICAL staged path (S3, the watcher criterion)", () => {
  it("release + issue events route into the matching campaign's sidecar with github event ids and repo/surface provenance", async () => {
    seed();
    const res = await runSotaWatcher({ root, sessionsDir, nowMs: () => CLOCK_MS });
    expect(res.lens.ok).toBe(true);
    expect(res.staged).toHaveLength(2);
    expect(res.staged.map((s) => s.event_id).sort()).toEqual(["github:example/piccolo-adjacent#42", "github:example/piccolo-adjacent@v0.9.0"]);
    // the identical staged path: the campaign sidecar, kinds release/issue, stamps present
    const path = stagingStreamPath(sessionsDir, "session-20260901-rydberg-integrator");
    const st = deriveStagingState(path);
    const release = st.entries.get("github:example/piccolo-adjacent@v0.9.0");
    expect(release?.state).toBe("staged");
    expect(release?.kind).toBe("release");
    expect(release?.url).toBe("https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0"); // CITED
    expect(release?.provenance?.job).toBe("sota-watcher");
    expect((release?.provenance as Record<string, unknown>).repo).toBe("example/piccolo-adjacent");
    expect((release?.provenance as Record<string, unknown>).surface).toBe("releases");
    expect(typeof release?.review_by).toBe("string"); // the review-by stamp rides
    const issue = st.entries.get("github:example/piccolo-adjacent#42");
    expect(issue?.kind).toBe("issue");
    expect(issue?.matched).toContain("rydberg");
  });

  it("a second watcher round on the same payloads dedupes by event id — no double delivery, one stage line per event", async () => {
    seed();
    await runSotaWatcher({ root, sessionsDir, nowMs: () => CLOCK_MS });
    const twice = await runSotaWatcher({ root, sessionsDir, nowMs: () => CLOCK_MS });
    expect(twice.staged).toHaveLength(0);
    expect(twice.deduped.sort()).toEqual(["github:example/piccolo-adjacent#42", "github:example/piccolo-adjacent@v0.9.0"]);
    const raw = readFileSync(stagingStreamPath(sessionsDir, "session-20260901-rydberg-integrator"), "utf8").trim().split("\n");
    expect(raw).toHaveLength(2);
  });

  it("no campaign match → the hopper stream, same shape (the identical fixtures, hopper fallback)", async () => {
    seed();
    rmSync(join(sessionsDir, "session-20260901-rydberg-integrator.md")); // no active campaigns
    const res = await runSotaWatcher({ root, sessionsDir, nowMs: () => CLOCK_MS });
    expect(res.staged).toHaveLength(0);
    expect(res.hopper).toHaveLength(2);
    const st = deriveStagingState(stagingStreamPath(sessionsDir, "hopper"));
    expect(st.entries.get("github:example/piccolo-adjacent@v0.9.0")?.state).toBe("staged");
    expect(st.entries.get("github:example/piccolo-adjacent@v0.9.0")?.reason).toBe("no-campaign-match");
  });

  it("a fetch-failed surface is a NAMED failure in the round summary — the watcher never silently skips it", async () => {
    seed();
    // the releases cache stays (that surface reads the cache and stages); the
    // issues surface has NO cache and the injected transport 403s — a NAMED
    // failure in the round, while the release still routes
    rmSync(cachePath(root, githubApiUrl("example/piccolo-adjacent", "issues")));
    const res = await runSotaWatcher({
      root,
      sessionsDir,
      nowMs: () => CLOCK_MS,
      fetchFn: (async () => ({ ok: false as const, status: 403, error: "HTTP 403 (rate-limited unauthenticated GitHub)" })) as never,
    });
    expect(res.staged).toHaveLength(1); // the cached release routed
    const issues = res.lens.repos[0].surfaces.find((s) => s.surface === "issues");
    expect(issues?.ok).toBe(false);
    expect(issues?.error).toMatch(/403/); // the named failure — never a silent skip
  });
});

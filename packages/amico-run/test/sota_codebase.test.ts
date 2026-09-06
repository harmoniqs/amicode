// sota_codebase.test.ts — the CODEBASE lens (#820, spec spec-20260905-103000
// living-sota D1/D3-data / S1/S2): the watched-repo registry is validator-
// checked TOML data (adding a repo is a data edit, never code); the fetch
// surface is the GitHub API against CANONICAL repos (never a local fork
// checkout); events surface as cited, provenance-stamped, keyword-filtered
// briefs; last-success stamps update on success and consecutive failures
// accrue toward the retire-or-confirm flag. GitHub-shaped fixtures only —
// the transport here is injected and REFUSES anything that is not an
// https://api.github.com/repos/<canonical> URL.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REGISTRY_FILENAME,
  registryPath,
  githubApiUrl,
  githubSourceKey,
  loadRegistry,
  parseGithubReleases,
  parseGithubIssues,
  runCodebaseLens,
  curlGithubFetch,
  renderCodebaseBrief,
} from "../src/sota_codebase.js";
import { parseWatchedRepoRegistry, flaggedForRetireOrConfirm } from "@amicode/schema";
import type { SotaFetch } from "../src/sota_fetch.js";

function root(): string {
  return mkdtempSync(join(tmpdir(), "sota-code-"));
}

function vclock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    jump: (ms: number) => {
      t += ms;
    },
  };
}

// A registry fixture (the S2 shape) — deliberately NOT the seed so the
// bootstrap path and the read path are tested apart.
const REGISTRY_TOML = `
schema_version = "1"
failure_threshold = 2

[[repos]]
repo = "example/piccolo-adjacent"
why_watched = "API shifts adjacent to our authoring map"
domains = ["julia-optimal-control"]
fetch_surface = ["releases", "issues"]
match_keywords = ["trajectory", "integrator"]

[[repos]]
repo = "example/agent-harness"
why_watched = "the harness field's canonical repo"
domains = ["agent-harness"]
fetch_surface = ["issues"]
match_keywords = ["session"]
`;

// GitHub-shaped fixtures (the real API's response shape).
const RELEASES_JSON = JSON.stringify([
  {
    tag_name: "v0.9.0",
    name: "v0.9.0 — trajectory rework",
    published_at: "2026-08-20T00:00:00Z",
    html_url: "https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0",
    body: "breaking: trajectory API now requires integrator selection at construction",
  },
  {
    tag_name: "v0.8.1",
    name: "patch release",
    published_at: "2026-07-01T00:00:00Z",
    html_url: "https://github.com/example/piccolo-adjacent/releases/tag/v0.8.1",
    body: "docs only",
  },
]);

const ISSUES_JSON = JSON.stringify([
  {
    number: 42,
    title: "session tree persistence",
    html_url: "https://github.com/example/agent-harness/issues/42",
    updated_at: "2026-08-25T00:00:00Z",
    body: "sessions should survive restarts",
  },
  {
    number: 43,
    title: "unrelated typography",
    html_url: "https://github.com/example/agent-harness/issues/43",
    updated_at: "2026-08-26T00:00:00Z",
    body: "nothing relevant",
  },
]);

/** The canonical-only transport: serves GitHub-shaped fixtures for known
 *  canonical repo URLs, REFUSES anything else (file://, local paths, http://,
 *  or a URL for an unregistered repo). This is the never-a-local-checkout
 *  property made mechanical. */
function fixtureGithub(): { fetchFn: SotaFetch; calls: string[] } {
  const calls: string[] = [];
  const fetch = (async (url: string) => {
    calls.push(url);
    if (!/^https:\/\/api\.github\.com\/repos\//.test(url)) {
      return { ok: false as const, status: 0, error: `refused non-canonical fetch target: ${url}` };
    }
    if (url.includes("/releases")) return { ok: true as const, status: 200, body: RELEASES_JSON, count: 2 };
    if (url.includes("/issues")) return { ok: true as const, status: 200, body: ISSUES_JSON, count: 2 };
    return { ok: false as const, status: 404, error: `no fixture for ${url}` };
  }) as SotaFetch;
  return { fetchFn: fetch, calls };
}

describe("githubApiUrl — the fetch surface is the GitHub API against CANONICAL repos", () => {
  it("builds canonical api.github.com URLs for each declared surface", () => {
    expect(githubApiUrl("example/piccolo-adjacent", "releases")).toBe(
      "https://api.github.com/repos/example/piccolo-adjacent/releases?per_page=10",
    );
    expect(githubApiUrl("example/agent-harness", "issues")).toBe(
      "https://api.github.com/repos/example/agent-harness/issues?state=open&per_page=20",
    );
    expect(githubApiUrl("example/piccolo-adjacent", "changelog")).toBe(
      "https://api.github.com/repos/example/piccolo-adjacent/releases?per_page=10",
    );
  });

  it("the builder CANNOT emit a local checkout path or a non-https scheme", () => {
    for (const surface of ["releases", "issues", "changelog"] as const) {
      const url = githubApiUrl("a/b", surface);
      expect(url.startsWith("https://api.github.com/repos/")).toBe(true);
    }
  });
});

describe("the GitHub-shaped parsers (tolerant, zero-dep)", () => {
  it("releases: tag, name, published_at, html_url, body", () => {
    const rs = parseGithubReleases(RELEASES_JSON);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ tag: "v0.9.0", title: "v0.9.0 — trajectory rework" });
    expect(rs[0].url).toBe("https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0");
  });

  it("issues: number, title, url, updated_at", () => {
    const is = parseGithubIssues(ISSUES_JSON, "example/agent-harness");
    expect(is).toHaveLength(2);
    expect(is[0]).toMatchObject({ id: "example/agent-harness#42", title: "session tree persistence" });
  });

  it("malformed JSON degrades to a named failure — never a silent empty brief", () => {
    expect(parseGithubReleases("{not json")).toEqual([]);
    expect(parseGithubIssues("")).toEqual([]);
  });
});

describe("loadRegistry — validator-checked TOML, bootstrapped from the seed (S2)", () => {
  it("an EMPTY sota root bootstraps from the packaged seed — the seed itself validates", () => {
    const r = root();
    const reg = loadRegistry(r);
    expect(reg.repos.length).toBeGreaterThanOrEqual(7); // the spec's D3 seed set
    expect(existsSync(registryPath(r))).toBe(true); // the living copy now exists
    // the seed is DATA that passes the validator (a drifted seed is a loud authoring failure)
    const persisted = readFileSync(registryPath(r), "utf8");
    expect(() => parseWatchedRepoRegistry(persisted)).not.toThrow();
  });

  it("a MALFORMED living registry fails LOUDLY, field-precise (never a silent skip)", () => {
    const r = root();
    mkdirSync(r, { recursive: true });
    writeFileSync(registryPath(r), "this is [not toml");
    expect(() => loadRegistry(r)).toThrow(/watched-repos\.toml/);
  });

  it("a schema-violating living registry (a non-canonical repo slug) fails loudly too", () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML.replace('repo = "example/agent-harness"', 'repo = "../etc/passwd"'));
    expect(() => loadRegistry(r)).toThrow(/schema violation/);
  });

  it("the registry filename is the pinned constant", () => {
    expect(REGISTRY_FILENAME).toBe("watched-repos.toml");
  });
});

describe("runCodebaseLens — the fetch round, GitHub-shaped fixtures only (S1)", () => {
  it("fetches each repo's declared surfaces via the GitHub API, filters events by match_keywords, cites what matched", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const { fetchFn: fetch, calls } = fixtureGithub();
    const res = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: vclock().nowMs, sleep: vclock().sleep });
    // 2 surfaces for repo 1 (releases + issues) + 1 for repo 2 (issues)
    expect(calls).toHaveLength(3);
    expect(calls.every((u) => u.startsWith("https://api.github.com/repos/"))).toBe(true); // never a local checkout
    expect(calls).toContain("https://api.github.com/repos/example/piccolo-adjacent/releases?per_page=10");
    expect(calls).toContain("https://api.github.com/repos/example/agent-harness/issues?state=open&per_page=20");
    // keyword filter: the trajectory release matches; the docs-only patch does not
    const repo1 = res.repos.find((x) => x.repo === "example/piccolo-adjacent")!;
    const releaseMatches = repo1.surfaces.find((s) => s.surface === "releases")!.events;
    expect(releaseMatches.map((e) => e.title)).toContain("v0.9.0 — trajectory rework");
    expect(releaseMatches).toHaveLength(1); // the patch release (no keyword match) is filtered
    // the issue lens's keyword filter: "session" matches #42, not #43
    const repo2 = res.repos.find((x) => x.repo === "example/agent-harness")!;
    const issueMatches = repo2.surfaces.find((s) => s.surface === "issues")!.events;
    expect(issueMatches.map((e) => e.title)).toContain("session tree persistence");
    expect(issueMatches).toHaveLength(1);
    // the brief CITES matched events by their canonical URLs and stamps provenance
    expect(res.brief).toContain("https://github.com/example/piccolo-adjacent/releases/tag/v0.9.0");
    expect(res.brief).toContain("https://github.com/example/agent-harness/issues/42");
    expect(res.brief).toMatch(/provenance:/);
    expect(res.brief).toContain("source: GitHub API");
  });

  it("ADDING A REPO TO THE TOML changes behavior with ZERO code edits — the registry is data", async () => {
    const r = root();
    const { fetchFn: fetch, calls } = fixtureGithub();
    // one repo first
    writeFileSync(registryPath(r), REGISTRY_TOML.replace(/\n\n\[\[repos\]\]\nrepo = "example\/agent-harness"[\s\S]*$/, "\n"));
    const before = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(before.repos).toHaveLength(1);
    const callsBefore = calls.length;
    // THE DATA EDIT: append a second repo to the SAME TOML — no code change
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const after = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(after.repos).toHaveLength(2);
    expect(calls.length).toBeGreaterThan(callsBefore); // the new repo's surfaces were fetched
    expect(after.brief).toContain("example/agent-harness");
  });

  it("the anomaly floor rides per-source: an empty-200 against a nonzero mean renders 'anomalous'", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const emptyIss = JSON.stringify([]);
    const { fetchFn: fetch, calls } = fixtureGithub();
    const c = vclock();
    // a first round seeds nonzero history for the issues surface of repo 2…
    const first = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: c.nowMs, sleep: c.sleep });
    expect(first.ok).toBe(true);
    // …then craft 6 more fetch-days of nonzero history for that surface key…
    for (let i = 0; i < 6; i++) {
      const { recordFetchOutcome } = await import("../src/sota_history.js");
      recordFetchOutcome(r, githubSourceKey("example/agent-harness", "issues"), { date: `2026-08-0${i + 1}`, count: 3 });
    }
    // …and age past the cache TTL so the empty round actually fetches
    c.jump(7 * 60 * 60 * 1000);
    // …and make the surface return an EMPTY 200 (a silent-quiet failure — the floor's whole point)
    const emptyFetch = (async (url: string) => {
      calls.push(url);
      if (url.includes("example/agent-harness/issues")) {
        return { ok: true as const, status: 200, body: emptyIss, count: 0 };
      }
      return fetch(url);
    }) as SotaFetch;
    const res = await runCodebaseLens({ root: r, fetchFn: emptyFetch, nowMs: c.nowMs, sleep: c.sleep });
    expect(res.brief).toContain("scan returned nothing — anomalous");
    expect(res.brief).not.toMatch(/nothing new/i);
  });
});

describe("stamps + the retire-or-confirm flag (S2 — quiet failures are the ones that matter)", () => {
  it("a SUCCESSFUL round stamps last_success and resets consecutive_failures — persisted, re-readable", async () => {
    const r = root();
    // the same shape, with a PRIOR failure accrued (the reset path is the point)
    writeFileSync(registryPath(r), REGISTRY_TOML.replace('match_keywords = ["trajectory", "integrator"]', 'match_keywords = ["trajectory", "integrator"]\nlast_success = ""\nconsecutive_failures = 1'));
    const { fetchFn: fetch } = fixtureGithub();
    const res = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(res.ok).toBe(true);
    // the persisted registry carries the stamps
    const persisted = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
    for (const repo of persisted.repos) {
      expect(repo.last_success).not.toBe(""); // STAMPED
      expect(repo.consecutive_failures).toBe(0); // reset
    }
    expect(res.stamp.iso).toBe(persisted.repos[0].last_success); // the reported stamp IS the persisted one
  });

  it("a FAILED round accrues consecutive_failures; N failures FLAG the entry for retire-or-confirm in the brief", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML); // failure_threshold = 2 (data, per-registry)
    const failing = (async (url: string) =>
      ({ ok: false as const, status: 503, error: "github down" })) as SotaFetch;
    // round 1: failures accrue, not yet flagged (threshold 2) — no flag SECTION yet
    const round1 = await runCodebaseLens({ root: r, fetchFn: failing, nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(round1.brief).not.toMatch(/^## Retire-or-confirm/m);
    const after1 = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
    expect(after1.repos.every((x) => x.consecutive_failures === 1)).toBe(true);
    expect(after1.repos.every((x) => x.last_success === "")).toBe(true); // never a silent success stamp
    // round 2: AT the threshold — flagged, and the brief names the human decision
    const round2 = await runCodebaseLens({ root: r, fetchFn: failing, nowMs: vclock().nowMs, sleep: vclock().sleep });
    expect(round2.brief).toMatch(/^## Retire-or-confirm \(the human decision/m);
    expect(round2.brief).toContain("example/piccolo-adjacent");
    const after2 = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
    for (const repo of after2.repos) {
      expect(repo.consecutive_failures).toBe(2);
      expect(flaggedForRetireOrConfirm(repo, after2.failure_threshold)).toBe(true); // DERIVED at read
    }
  });

  it("a MIXED round: success on one surface still stamps that repo (per-repo verdicts, never all-or-nothing)", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const c = vclock();
    const mixed = (async (url: string) =>
      url.includes("example/agent-harness")
        ? { ok: false as const, status: 503, error: "github down" }
        : { ok: true as const, status: 200, body: RELEASES_JSON, count: 2 }) as SotaFetch;
    await runCodebaseLens({ root: r, fetchFn: mixed, nowMs: c.nowMs, sleep: c.sleep });
    const persisted = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
    const ok1 = persisted.repos.find((x) => x.repo === "example/piccolo-adjacent")!;
    const bad = persisted.repos.find((x) => x.repo === "example/agent-harness")!;
    expect(ok1.last_success).not.toBe("");
    expect(ok1.consecutive_failures).toBe(0);
    expect(bad.last_success).toBe("");
    expect(bad.consecutive_failures).toBe(1);
  });
});

describe("renderCodebaseBrief — the PI-register shape", () => {
  it("leads with the outcome; every cited event carries its canonical URL; provenance stamps the fetch round", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const { fetchFn: fetch } = fixtureGithub();
    const res = await runCodebaseLens({ root: r, fetchFn: fetch, nowMs: vclock().nowMs, sleep: vclock().sleep });
    const lines = res.brief.split("\n");
    expect(lines[0]).toMatch(/^# SOTA codebase brief/);
    expect(lines[0]).toMatch(/\d+ repos scanned/); // the outcome leads
    expect(res.brief).toMatch(/why-watched/); // details-informed: the human reason renders
    expect(res.brief).toMatch(/scanned at:/);
    expect(res.brief).toMatch(/source: GitHub API/);
  });
});

// ── B1: HTTP errors must not launder as empty successes (the stamps end) ────
// curl WITHOUT --fail exits 0 on a 403/429 (unauthenticated GitHub is 60
// req/h — the most common real failure); the old transport hardcoded
// status 200 / ok true / count 0, so a rate-limited round RESET
// consecutive_failures, STAMPED last_success, and recorded a fake-zero
// success in fetch history — the retire-or-confirm flag and the anomaly
// floor both disarmed exactly when the fleet chronically fails.

/** A fake `curl` that behaves like real curl WITH --fail on an HTTP error:
 *  the write-out on stdout, the error on stderr, exit 22. */
function fakeCurl404Dir(): string {
  const dir = mkdtempSync(join(tmpdir(), "sota-fakecurl-"));
  writeFileSync(
    join(dir, "curl"),
    "#!/bin/sh\nprintf '\\n404'\nprintf 'curl: (22) The requested URL returned error: 404\\n' >&2\nexit 22\n",
  );
  chmodSync(join(dir, "curl"), 0o755);
  return dir;
}

describe("B1 — a 404/429 round through the PRODUCTION transport is a named failure (stamps end)", () => {
  it("accrues consecutive_failures, does NOT stamp last_success, records NO fetch history, and renders the real status", async () => {
    const r = root();
    writeFileSync(registryPath(r), REGISTRY_TOML);
    const dir = fakeCurl404Dir();
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath}`;
    try {
      const res = await runCodebaseLens({ root: r, nowMs: vclock().nowMs, sleep: vclock().sleep }); // default fetch = curlGithubFetch
      expect(res.ok).toBe(false); // the round FAILED — under the old laundering it "succeeded"
      for (const repo of res.repos) {
        expect(repo.ok).toBe(false);
        for (const s of repo.surfaces) {
          expect(s.ok).toBe(false);
          expect(s.error).toMatch(/404/); // the NAMED failure
          expect(s.error).not.toMatch(/anomalous|no matched/i); // never rendered as a scan verdict
        }
      }
      // the stamps: failures accrue; last_success stays empty (no laundering reset)
      const persisted = parseWatchedRepoRegistry(readFileSync(registryPath(r), "utf8"));
      for (const repo of persisted.repos) {
        expect(repo.last_success).toBe("");
        expect(repo.consecutive_failures).toBe(1);
      }
      // the history: NO fake zero recorded for any surface
      const { readFetchHistory } = await import("../src/sota_history.js");
      for (const repo of persisted.repos) {
        for (const surface of repo.fetch_surface) {
          expect(readFetchHistory(r, githubSourceKey(repo.repo, surface))).toEqual([]);
        }
      }
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe("githubSourceKey — collision-free, filesystem-safe (nit)", () => {
  it("the flattening pair that collides (a/b__c vs a__b/c) produces DISTINCT keys", () => {
    expect(githubSourceKey("a/b__c", "issues")).not.toBe(githubSourceKey("a__b/c", "issues"));
    expect(githubSourceKey("a--b/c", "issues")).not.toBe(githubSourceKey("a/b--c", "issues")); // the `--` variant collides too
  });

  it("the key is always a safe single file name (no `/`, no invented directories)", () => {
    for (const repo of ["example/piccolo-adjacent", "a/b__c", "a__b/c", "x/y/z"]) {
      const key = githubSourceKey(repo, "releases");
      expect(key).not.toMatch(/\//);
    }
  });
});

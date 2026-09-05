// watched_repos.test.ts — S2, the watched-repo registry validator (#820, spec
// spec-20260905-103000 D3-data / watched_repo_registry_is_data): the registry
// is validator-checked TOML — repos, why-watched, feeding-which-domains,
// fetch surface, match keywords, last-success stamps — so adding a repo is a
// DATA EDIT, never code. A malformed registry fails LOUDLY with
// field-precise errors; N consecutive failures (default 7, IN THE SCHEMA)
// flag the entry for human retire-or-confirm (derived — the flag can never
// disagree with the counter it reads).
//
// Same idiom as mode_registry.test.ts: the ONE shared validator both the
// extension's vitest suite and amico-run's lenses import — a registry that
// passes tests passes the machinery.
import { describe, it, expect } from "vitest";
import {
  validateWatchedRepoRegistry,
  parseWatchedRepoRegistry,
  flaggedForRetireOrConfirm,
  DEFAULT_FAILURE_THRESHOLD,
  type WatchedRepo,
} from "../src/watched_repos.js";

const GOOD = `
schema_version = "1"

[[repos]]
repo = "anomalyco/opencode"
why_watched = "the canonical harness our vendored fork tracks — drift here is drift in the product"
domains = ["agent-harness"]
fetch_surface = ["releases", "issues"]
match_keywords = ["plugin", "permission", "session"]
last_success = "2026-09-05T01:02:03Z"
consecutive_failures = 0
`;

const MINIMAL = `
schema_version = "1"

[[repos]]
repo = "earendil-works/pi"
why_watched = "the minimal-core harness field the fork-split session surveyed"
domains = ["agent-harness"]
fetch_surface = ["releases"]
match_keywords = ["session"]
`;

describe("validateWatchedRepoRegistry (S2 — validator-checked data)", () => {
  it("a well-formed registry validates, zero errors", () => {
    const v = validateWatchedRepoRegistry(GOOD);
    expect(v.errors, v.errors.join("\n")).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it("accepts a parsed object (not just text) — the IO seam stays in amico-run", () => {
    expect(validateWatchedRepoRegistry(parseWatchedRepoRegistry(GOOD)).ok).toBe(true);
  });

  it("a malformed TOML registry fails NAMED (parse error, never a silent empty)", () => {
    const v = validateWatchedRepoRegistry("this is [not toml");
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /parse error/.test(e))).toBe(true);
  });

  it("a schema violation fails FIELD-PRECISE: a missing why_watched names the key", () => {
    const bad = MINIMAL.replace('why_watched = "the minimal-core harness field the fork-split session surveyed"\n', "");
    const v = validateWatchedRepoRegistry(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /why_watched/.test(e))).toBe(true);
  });

  it("a bad fetch surface (outside the enum) fails, the allowed set rendered", () => {
    const v = validateWatchedRepoRegistry(MINIMAL.replace('fetch_surface = ["releases"]', 'fetch_surface = ["wiki"]'));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /releases/.test(e) && /changelog/.test(e))).toBe(true);
  });

  it("a non-canonical repo slug (no owner, or a path traversal) fails the pattern", () => {
    for (const repo of ["opencode", "../etc/passwd", "a/b/c", ""]) {
      const v = validateWatchedRepoRegistry(MINIMAL.replace("repo = \"earendil-works/pi\"", `repo = "${repo}"`));
      expect(v.ok, `repo="${repo}" must fail`).toBe(false);
      expect(v.errors.some((e) => /repo/.test(e))).toBe(true);
    }
  });

  it("an empty match_keywords array fails (a watched repo with no match vocabulary watches nothing)", () => {
    const v = validateWatchedRepoRegistry(MINIMAL.replace('match_keywords = ["session"]', "match_keywords = []"));
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /match_keywords/.test(e))).toBe(true);
  });

  it("an unknown top-level key fails (additionalProperties: false — the registry is closed data)", () => {
    const v = validateWatchedRepoRegistry(GOOD + "\nextra_key = true\n");
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /extra_key/.test(e))).toBe(true);
  });

  it("a duplicate repo entry fails at registry level (one repo, one entry — the dedup discipline)", () => {
    const dup = MINIMAL + MINIMAL.slice(MINIMAL.indexOf("[[repos]]"));
    const v = validateWatchedRepoRegistry(dup);
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => /duplicate/.test(e))).toBe(true);
    expect(() => parseWatchedRepoRegistry(dup)).toThrow(/duplicate/);
  });
});

describe("parseWatchedRepoRegistry — the machinery's typed read", () => {
  it("parses a full registry: every field, byte-faithful", () => {
    const r = parseWatchedRepoRegistry(GOOD);
    expect(r.schema_version).toBe("1");
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({
      repo: "anomalyco/opencode",
      why_watched: "the canonical harness our vendored fork tracks — drift here is drift in the product",
      domains: ["agent-harness"],
      fetch_surface: ["releases", "issues"],
      match_keywords: ["plugin", "permission", "session"],
      last_success: "2026-09-05T01:02:03Z",
      consecutive_failures: 0,
    });
  });

  it("applies the IN-SCHEMA defaults: failure_threshold 7; omitted stamps read as empty/zero", () => {
    expect(DEFAULT_FAILURE_THRESHOLD).toBe(7); // the schema carries the default — one source of truth
    const r = parseWatchedRepoRegistry(MINIMAL);
    expect(r.failure_threshold).toBe(7);
    expect(r.repos[0].last_success).toBe("");
    expect(r.repos[0].consecutive_failures).toBe(0);
  });

  it("an explicit failure_threshold overrides the default (per-fleet tuning is data too)", () => {
    const r = parseWatchedRepoRegistry(`schema_version = "1"\nfailure_threshold = 3\n` + MINIMAL.split("\n").slice(2).join("\n"));
    expect(r.failure_threshold).toBe(3);
  });

  it("an invalid registry THROWS field-precise (loud authoring failure, the parseModeManifest idiom)", () => {
    expect(() => parseWatchedRepoRegistry("nope")).toThrow(/watched-repos\.toml/);
  });
});

describe("flaggedForRetireOrConfirm (N-failure flagging — derived, never stored)", () => {
  const entry = (n: number): WatchedRepo => ({
    repo: "earendil-works/pi",
    why_watched: "field survey",
    domains: ["agent-harness"],
    fetch_surface: ["releases"],
    match_keywords: ["session"],
    last_success: "",
    consecutive_failures: n,
  });

  it("below the threshold: active, not flagged", () => {
    expect(flaggedForRetireOrConfirm(entry(6), 7)).toBe(false);
    expect(flaggedForRetireOrConfirm(entry(0), 7)).toBe(false);
  });

  it("AT and past the threshold: flagged for human retire-or-confirm (quiet failures are the ones that matter)", () => {
    expect(flaggedForRetireOrConfirm(entry(7), 7)).toBe(true);
    expect(flaggedForRetireOrConfirm(entry(9), 7)).toBe(true);
  });

  it("the flag respects a registry's explicit threshold (data, not code)", () => {
    expect(flaggedForRetireOrConfirm(entry(3), 3)).toBe(true);
    expect(flaggedForRetireOrConfirm(entry(2), 3)).toBe(false);
  });
});

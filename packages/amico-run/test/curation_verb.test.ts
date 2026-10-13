// curation_verb.test.ts — the CLI surfaces of the three weekly curation jobs
// (amicode #1685, brain flywheel slice 6): `amico claims promote / prune /
// synthesize`, each dry-run by default (the claims doctrine), --apply writes,
// and — the notturno chassis, the distill precedent — each files (or honestly
// skips) a scheduled-passes.md receipt through --jobs + --dashboards, with
// the instance deny-list gate firing before any body work (org config is
// never read by the public verb).
//
// The trust boundaries this suite pins:
//   - promote PROPOSES: the bundle is an artifact a human merges; the verb
//     never opens a PR, never merges, never pushes (the double gate is the
//     spec's Key Decision);
//   - synthesize proposes to the HOPPER, never to human-fed strategy — a
//     decoy STRATEGY.md must survive a run byte-identical.
//
// Hermetic: the committed curation-registry fixture copied into temp dirs,
// inline notturno job registries (the distill tinyRegistry pattern), a fixed
// clock — never the live vault, never the org registry.
//
// Run: `pnpm --filter @amicode/amico-run test curation_verb`
import { describe, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as stringifyYaml } from "yaml";

import { claimsVerb } from "../src/claims_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { parseClaimNote } from "../src/claims.js";
import { resolveMountStack } from "../src/mounts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const REGISTRY_FIXTURE = join(FIXTURES, "curation-registry");
const VAULT_FIXTURE = join(FIXTURES, "vault");
const NOON = () => new Date("2026-10-02T12:00:00.000Z");

/** A fresh ops dir for the whole file: the promote state stamp's default home
 *  is AMICO_OPS_DIR-seamed, and a suite run must NEVER touch the live
 *  machine's ops tree (an apply without --state otherwise writes ~/.amico). */
const OPS = mkdtempSync(join(tmpdir(), "curation-ops-"));
const ENV: NodeJS.ProcessEnv = { AMICODE_OPS_DIR: OPS };

/** A temp copy of the committed curation registry — apply paths never touch
 *  the fixture of record. */
function tempRegistry(opts: { without?: string[] } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "curation-reg-"));
  cpSync(REGISTRY_FIXTURE, dir, { recursive: true });
  for (const file of opts.without ?? []) rmSync(join(dir, file));
  return dir;
}

/** An inline notturno job registry (the distill tinyRegistry pattern). */
function jobsRegistry(dir: string, opts: { record?: "always" | "acted"; jobs?: string[]; name?: string } = {}): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, opts.name ?? "jobs.toml");
  const ids = opts.jobs ?? ["promote", "prune", "synthesize"];
  const record = opts.record ?? "always";
  writeFileSync(
    file,
    ids
      .map(
        (id) =>
          `[job.${id}]\nworkflow = "notturno-${id}.yml"\ncadence = "0 6 * * 1"\nsurface = "mini"\nwarrant = "stage"\nenabled = false\nrecord = "${record}"\n`,
      )
      .join("\n"),
  );
  return file;
}

/** A synthetic scope-team claim note, rendered as a registry file. */
function syntheticNote(file: string, scope = "team"): string {
  const claim = {
    type: "insight",
    statement: `synthetic claim ${file}`,
    status: "unverified",
    confidence: "medium",
    evidence: [],
    applied: 0,
    last_applied: null,
    history: [{ date: "2026-10-01T00:00:00.000Z", event: "created", note: "synthetic (curation verb test)" }],
    scope,
    tags: ["synthetic"],
  };
  return `---\n${stringifyYaml(claim, { lineWidth: 0 }).trimEnd()}\n---\n\n# ${claim.statement}\n\nsynthetic.\n`;
}

// ── usage + the never-a-guess refusals ─────────────────────────────────────────

describe("amico claims curation — usage + the never-a-guess refusals", () => {
  it.each([["promote"], ["prune"], ["synthesize"]])("%s: unknown flag → 64", async (sub) => {
    const r = await claimsVerb([sub, "--bogus"], ENV);
    expect(r.code).toBe(64);
  });

  it.each([["promote"], ["prune"], ["synthesize"]])("%s: no registry, no mount → 64, never a guess", async (sub) => {
    const bare = mkdtempSync(join(tmpdir(), "curation-bare-"));
    const r = await claimsVerb([sub], { ...ENV, AMICO_VAULTS_ROOT: bare });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--registry");
  });

  it.each([["promote"], ["prune"], ["synthesize"]])(
    "%s: --jobs without --dashboards is a usage error (the receipt has nowhere to land)",
    async (sub) => {
      const dir = mkdtempSync(join(tmpdir(), "curation-jobs-"));
      const r = await claimsVerb([sub, "--registry", tempRegistry(), "--jobs", jobsRegistry(dir)], ENV);
      expect(r.code).toBe(64);
      expect((r.json as { error: string }).error).toContain("--dashboards");
    },
  );

  it("the three subs are routed by the claims verb and named in its summary (the job slate)", async () => {
    const claims = SPINE_VERBS.find((v) => v.name === "claims");
    expect(claims).toBeDefined();
    expect(claims!.summary).toContain("promote");
    expect(claims!.summary).toContain("prune");
    expect(claims!.summary).toContain("synthesize");
  });
});

// ── promote — AC 1 (one PR per vault, the 10-cap, never auto-merged) ───────────

describe("amico claims promote — the proposal bundle (AC 1)", () => {
  it("dry-run is report-only: the plan, the PR body, and no bundle on disk", async () => {
    const registry = tempRegistry();
    const r = await claimsVerb(["promote", "--registry", registry, "--from", "vault-aaron"], ENV, { now: NOON });
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);
    expect(json.selected).toEqual(["best_practice_warm_starts.md", "insight_two_qubit_cr.md", "insight_two_qubit_harder.md"]);
    expect(json.proposes_only).toBe(true);
    const body = json.pr_body as string;
    expect(body).toContain("promote: vault-aaron → armonissima (3 claims, 2026-10-02)");
    expect(body).toContain("never opens a PR");
    // the audit artifact is NOT on disk in a dry run, and nothing was proposed
    expect(existsSync(join(registry, "promotions"))).toBe(false);
    expect("receipt" in json).toBe(false);
  });

  it("apply writes the bundle: PR-BODY.md + one verbatim-plus-provenance copy per claim, and stamps the state", async () => {
    const registry = tempRegistry();
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const r = await claimsVerb(
      ["promote", "--registry", registry, "--state", state, "--from", "vault-aaron", "--apply"],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(0);
    const bundle = join(registry, "promotions", "promote-20261002-120000");
    expect(existsSync(join(bundle, "PR-BODY.md"))).toBe(true);
    const files = readdirSync(bundle).sort();
    expect(files).toEqual(["PR-BODY.md", "best_practice_warm_starts.md", "insight_two_qubit_cr.md", "insight_two_qubit_harder.md"]);
    // copy-never-move: the registry keeps its claims, untouched
    expect(parseClaimNote(readFileSync(join(registry, "insight_two_qubit_harder.md"), "utf8")).ok).toBe(true);
    const copy = readFileSync(join(bundle, "insight_two_qubit_harder.md"), "utf8");
    expect(copy).toContain("Provenance");
    expect(copy).toContain("promote-20261002-120000");
    // the state stamp: the three claims are out of the pool for the next run
    expect(JSON.parse(readFileSync(state, "utf8")).proposals["insight_two_qubit_harder.md"].bundle).toBe(
      "promote-20261002-120000",
    );
  });

  it("re-run is an honest no-op: the state excludes proposed claims, no second bundle", async () => {
    const registry = tempRegistry();
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const first = await claimsVerb(
      ["promote", "--registry", registry, "--state", state, "--from", "vault-aaron", "--apply"],
      ENV,
      { now: NOON },
    );
    expect((first.json as Record<string, unknown>).selected).toHaveLength(3);
    const second = await claimsVerb(
      ["promote", "--registry", registry, "--state", state, "--from", "vault-aaron", "--apply"],
      ENV,
      { now: () => new Date("2026-10-03T12:00:00.000Z") },
    );
    expect(second.code).toBe(0);
    expect((second.json as Record<string, unknown>).selected).toEqual([]);
    expect(existsSync(join(registry, "promotions", "promote-20261003-120000"))).toBe(false);
  });

  it("the 10-cap: 12 eligible → ONE bundle with 10 copies, 2 carried to the next run", async () => {
    const registry = tempRegistry();
    for (const file of readdirSync(registry).filter((f) => f.endsWith(".md"))) rmSync(join(registry, file));
    for (let i = 0; i < 12; i++) writeFileSync(join(registry, `synthetic_${String(i).padStart(2, "0")}.md`), syntheticNote(`s${i}`));
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const r = await claimsVerb(["promote", "--registry", registry, "--state", state, "--apply"], ENV, { now: NOON });
    expect(r.code).toBe(0);
    const bundle = join(registry, "promotions", "promote-20261002-120000");
    expect(readdirSync(bundle).filter((f) => f !== "PR-BODY.md")).toHaveLength(10);
    expect((r.json as Record<string, unknown>).overflow_carried).toEqual(["synthetic_10.md", "synthetic_11.md"]);
    // overflow carries: the NEXT run proposes the remaining two, its own bundle
    const next = await claimsVerb(["promote", "--registry", registry, "--state", state, "--apply"], ENV, {
      now: () => new Date("2026-10-09T12:00:00.000Z"),
    });
    expect(next.code).toBe(0);
    expect((next.json as Record<string, unknown>).selected).toEqual(["synthetic_10.md", "synthetic_11.md"]);
    expect(existsSync(join(registry, "promotions", "promote-20261009-120000"))).toBe(true);
  });

  it("never auto-merged, structurally: the bundle is the only artifact and the JSON says so", async () => {
    const registry = tempRegistry();
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const r = await claimsVerb(["promote", "--registry", registry, "--state", state, "--apply"], ENV, { now: NOON });
    const json = r.json as Record<string, unknown>;
    expect(json.proposes_only).toBe(true);
    expect(json.auto_merge).toBe(false);
    const body = readFileSync(join(registry, "promotions", "promote-20261002-120000", "PR-BODY.md"), "utf8");
    expect(body).toContain("never opens a PR");
    expect(body).toMatch(/a human/i);
    // nothing left the tree: the registry still holds all 7 fixture claims
    expect(readdirSync(registry).filter((f) => f.endsWith(".md")).sort()).toEqual(
      readdirSync(REGISTRY_FIXTURE).filter((f) => f.endsWith(".md")).sort(),
    );
  });

  it("an existing bundle dir is never clobbered (the audit artifact) → 64", async () => {
    const registry = tempRegistry();
    mkdirSync(join(registry, "promotions", "promote-20261002-120000"), { recursive: true });
    const r = await claimsVerb(["promote", "--registry", registry, "--apply"], ENV, { now: NOON });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("promote-20261002-120000");
  });
});

// ── the receipt chassis (AC 4 — each job files pass receipts) ─────────────────

describe("amico claims curation — the notturno pass receipt (the distill chassis)", () => {
  it("promote apply with --jobs + --dashboards files the scheduled-passes.md record (job id, counts)", async () => {
    const registry = tempRegistry();
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const dir = mkdtempSync(join(tmpdir(), "curation-dash-"));
    const dashboards = join(dir, "dashboards");
    const r = await claimsVerb(
      ["promote", "--registry", registry, "--state", state, "--apply", "--jobs", jobsRegistry(dir), "--dashboards", dashboards],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(0);
    expect((r.json as Record<string, Record<string, unknown>>).receipt).toMatchObject({ filed: true, job: "promote" });
    const text = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(text).toContain("## Pass 2026-10-02 — promote — ok");
    expect(text).toContain("bundle promote-20261002-120000");
  });

  it("an unregistered job id is refused: the registry membership check (exit 2, no receipt)", async () => {
    const registry = tempRegistry();
    const dir = mkdtempSync(join(tmpdir(), "curation-dash-"));
    const r = await claimsVerb(
      ["prune", "--registry", registry, "--vault", VAULT_FIXTURE, "--apply", "--jobs", jobsRegistry(dir, { jobs: ["promote"] }), "--dashboards", dir],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(2);
    expect((r.json as Record<string, unknown>).error).toContain("unknown job 'prune'");
  });

  it("a deny-listed jobs registry is refused loudly (exit 64) — org config never runs through the public verb", async () => {
    const registry = tempRegistry();
    const sub = join(mkdtempSync(join(tmpdir(), "curation-org-")), "automation", "notturno");
    const jobsFile = jobsRegistry(sub, { name: "notturno.toml" });
    writeFileSync(
      join(sub, "instance-deny-list.toml"),
      '[[deny]]\npath = "automation/notturno/notturno.toml"\nreason = "instance config by construction"\n',
    );
    const r = await claimsVerb(
      ["synthesize", "--registry", registry, "--hopper", join(mkdtempSync(join(tmpdir(), "hopper-"))), "--apply", "--jobs", jobsFile, "--dashboards", sub],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).error).toContain("deny");
  });

  it("record = \"acted\" + nothing to do → the receipt self-filters (skipped, honestly named)", async () => {
    const registry = tempRegistry({ without: ["insight_unresolved.md", "insight_padded_tags.md"] });
    // no fixes + no drift → nothing acted; the prune job records on action only
    const dir = mkdtempSync(join(tmpdir(), "curation-dash-"));
    const dashboards = join(dir, "dashboards");
    const state = join(mkdtempSync(join(tmpdir(), "curation-state-")), "promote-state.json");
    const prune = await claimsVerb(
      ["prune", "--registry", registry, "--vault", VAULT_FIXTURE, "--apply", "--jobs", jobsRegistry(dir, { record: "acted" }), "--dashboards", dashboards],
      ENV,
      { now: NOON },
    );
    expect(prune.code).toBe(0);
    expect((prune.json as Record<string, Record<string, unknown>>).receipt).toMatchObject({
      filed: false,
      skipped: true,
    });

    // promote with everything already proposed: same self-filter
    const first = await claimsVerb(["promote", "--registry", registry, "--state", state, "--apply"], ENV, { now: NOON });
    expect(first.code).toBe(0);
    const second = await claimsVerb(
      ["promote", "--registry", registry, "--state", state, "--apply", "--jobs", jobsRegistry(dir, { record: "acted" }), "--dashboards", dashboards],
      ENV,
      { now: () => new Date("2026-10-03T12:00:00.000Z") },
    );
    expect((second.json as Record<string, Record<string, unknown>>).receipt).toMatchObject({
      filed: false,
      skipped: true,
    });
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
  });

  it("no --jobs registry → the body still runs, the receipt is honestly not filed", async () => {
    const registry = tempRegistry();
    const r = await claimsVerb(["promote", "--registry", registry, "--apply"], ENV, { now: NOON });
    expect(r.code).toBe(0);
    expect((r.json as Record<string, Record<string, unknown>>).receipt).toMatchObject({ filed: false });
  });
});

// ── prune — AC 2 (hygiene diffs + flagged drift, unambiguous fixes only) ──────

describe("amico claims prune — schema-check + hygiene (AC 2)", () => {
  it("dry-run: the hygiene diff + the drift (the claims lint's findings, reused verbatim), no writes", async () => {
    const registry = tempRegistry();
    const r = await claimsVerb(["prune", "--registry", registry, "--vault", VAULT_FIXTURE], ENV, { now: NOON });
    // drift present (the unresolved pointer) → findings exit 1, the lint convention
    expect(r.code).toBe(1);
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);
    expect(json.fixes).toHaveLength(2);
    expect(json.drift).toEqual([expect.stringContaining("insight_unresolved.md") as unknown as string]);
    // nothing was written: the padded claim is byte-identical
    expect(readFileSync(join(registry, "insight_padded_tags.md"), "utf8")).toEqual(
      readFileSync(join(REGISTRY_FIXTURE, "insight_padded_tags.md"), "utf8"),
    );
  });

  it("apply applies ONLY the unambiguous fixes (frontmatter swapped, prose verbatim) and still exits 1 on drift", async () => {
    const registry = tempRegistry();
    const r = await claimsVerb(["prune", "--registry", registry, "--vault", VAULT_FIXTURE, "--apply"], ENV, { now: NOON });
    expect(r.code).toBe(1); // honest: the pass acted, but drift stays for a human
    const fixed = parseClaimNote(readFileSync(join(registry, "insight_padded_tags.md"), "utf8"));
    expect(fixed.ok).toBe(true);
    if (fixed.ok) {
      expect(fixed.claim.evidence).toEqual(["memory-card/feedback_warm_starts.md"]);
      expect(fixed.claim.tags).toEqual(["warm-start"]);
    }
    // prose untouched (the machinery-never-edits-prose doctrine)
    const body = readFileSync(join(registry, "insight_padded_tags.md"), "utf8").split(/^---[\s\S]*?---\n/)[1]!;
    expect(readFileSync(join(REGISTRY_FIXTURE, "insight_padded_tags.md"), "utf8").endsWith(body)).toBe(true);
    // the drift claim was NOT "fixed" by deleting its pointer (a pointer is never a guess)
    const driftClaim = parseClaimNote(readFileSync(join(registry, "insight_unresolved.md"), "utf8"));
    expect(driftClaim.ok).toBe(true);
    if (driftClaim.ok) expect(driftClaim.claim.evidence).toEqual(["memory-card/gone_card.md"]);
  });

  it("a clean registry: fixes applied, no drift, exit 0, and the receipt filed", async () => {
    const registry = tempRegistry({ without: ["insight_unresolved.md"] });
    const dir = mkdtempSync(join(tmpdir(), "curation-dash-"));
    const dashboards = join(dir, "dashboards");
    const r = await claimsVerb(
      ["prune", "--registry", registry, "--vault", VAULT_FIXTURE, "--apply", "--jobs", jobsRegistry(dir), "--dashboards", dashboards],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.fixes).toHaveLength(2);
    expect(json.drift).toEqual([]);
    const text = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(text).toContain("## Pass 2026-10-02 — prune — ok");
    expect(text).toContain("2 fixes");
  });
});

// ── synthesize — AC 3 (hopper proposals, never strategy) ───────────────────────

describe("amico claims synthesize — cross-claim patterns → the hopper (AC 3)", () => {
  it("apply writes the hopper proposal(s); a decoy STRATEGY.md survives byte-identical", async () => {
    const vault = mkdtempSync(join(tmpdir(), "curation-vault-"));
    mkdirSync(join(vault, "hopper"), { recursive: true });
    const strategy = join(vault, "STRATEGY.md");
    writeFileSync(strategy, "# Strategy\n\nhuman-fed, human-owned — the synthesize job never touches this file.\n");
    const r = await claimsVerb(
      ["synthesize", "--registry", tempRegistry(), "--hopper", join(vault, "hopper"), "--apply"],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(0);
    const files = readdirSync(join(vault, "hopper"));
    expect(files).toEqual(["synthesize-transmon.md"]);
    const note = readFileSync(join(vault, "hopper", "synthesize-transmon.md"), "utf8");
    expect(note).toContain("status: proposed");
    expect(note).toContain("../amicode/claims/best_practice_warm_starts.md");
    // the trust boundary: strategy is byte-identical
    expect(readFileSync(strategy, "utf8")).toBe(
      "# Strategy\n\nhuman-fed, human-owned — the synthesize job never touches this file.\n",
    );
    const json = r.json as Record<string, unknown>;
    expect(json.wrote).toEqual([join(vault, "hopper", "synthesize-transmon.md")]);
  });

  it("re-run is idempotent: the existing hopper proposal is a named skip, no duplicate note", async () => {
    const vault = mkdtempSync(join(tmpdir(), "curation-vault-"));
    mkdirSync(join(vault, "hopper"), { recursive: true });
    const registry = tempRegistry();
    const first = await claimsVerb(["synthesize", "--registry", registry, "--hopper", join(vault, "hopper"), "--apply"], ENV, { now: NOON });
    expect(first.code).toBe(0);
    const second = await claimsVerb(["synthesize", "--registry", registry, "--hopper", join(vault, "hopper"), "--apply"], ENV, { now: NOON });
    expect(second.code).toBe(0);
    expect((second.json as Record<string, unknown>).wrote).toEqual([]);
    expect((second.json as Record<string, unknown>).skipped).toEqual([expect.stringContaining("synthesize-transmon.md") as unknown as string]);
    expect(readdirSync(join(vault, "hopper"))).toEqual(["synthesize-transmon.md"]);
  });

  it("dry-run reports the patterns and writes nothing", async () => {
    const vault = mkdtempSync(join(tmpdir(), "curation-vault-"));
    mkdirSync(join(vault, "hopper"), { recursive: true });
    const r = await claimsVerb(["synthesize", "--registry", tempRegistry(), "--hopper", join(vault, "hopper")], ENV, { now: NOON });
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);
    expect(json.patterns).toHaveLength(1);
    expect(readdirSync(join(vault, "hopper"))).toEqual([]);
  });

  it("no mount and no --hopper → 64 (the hopper area is never a guess)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "curation-bare-"));
    const r = await claimsVerb(["synthesize", "--registry", tempRegistry()], { ...ENV, AMICO_VAULTS_ROOT: bare });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--hopper");
  });

  it("the receipt files under the synthesize job id", async () => {
    const vault = mkdtempSync(join(tmpdir(), "curation-vault-"));
    mkdirSync(join(vault, "hopper"), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "curation-dash-"));
    const dashboards = join(dir, "dashboards");
    const r = await claimsVerb(
      [
        "synthesize",
        "--registry",
        tempRegistry(),
        "--hopper",
        join(vault, "hopper"),
        "--apply",
        "--jobs",
        jobsRegistry(dir),
        "--dashboards",
        dashboards,
      ],
      ENV,
      { now: NOON },
    );
    expect(r.code).toBe(0);
    const text = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(text).toContain("## Pass 2026-10-02 — synthesize — ok");
  });
});

// ── AC 5 — the manual /dream invocation is documented as retired ───────────────

describe("amico claims curation — the /dream retirement (AC 5)", () => {
  it("the jobs doc exists and retires the manual invocation in favor of the three jobs", () => {
    const doc = join(HERE, "..", "..", "..", "docs", "brain-flywheel-jobs.md");
    expect(existsSync(doc)).toBe(true);
    const text = readFileSync(doc, "utf8");
    expect(text).toContain("/dream");
    expect(text).toContain("retired");
    for (const job of ["promote", "prune", "synthesize"]) expect(text).toContain(job);
    // the doc names the notturno job registry rows (the cadence contract the instance registers)
    expect(text).toContain("cadence");
  });
});

// ── the public tier (amicode #1688, brain flywheel slice 9) ─────────────────────
//
// The brain's outbound face on the SAME promote machinery: a hermetic mount
// stack (the committed fixtures — the source personal vault with the
// public-registry claims + the two-note evidence cards, and the kind: public
// target mount), the two-note visibility split checked at promotion time (the
// public-safe claim passes; the two taint classes refuse BY NAME), the
// marker/kind mount conventions (verified, never guessed), and the bundle's
// third artifact — INDEX.md, the public vault's generated index.
describe("amico claims promote --tier public — the public tier (#1688)", () => {
  /** A hermetic mount stack: <root>/vault-aaron (personal, the claims registry
   *  + the evidence cards) + <root>/vault-public (public) — assembled from the
   *  committed fixtures so the mount conventions are exercised for real. */
  function publicStack(): { root: string; registry: string; mount: string } {
    const root = mkdtempSync(join(tmpdir(), "public-stack-"));
    const source = join(root, "vault-aaron");
    mkdirSync(join(source, "amicode"), { recursive: true });
    cpSync(join(FIXTURES, "public-registry"), join(source, "amicode", "claims"), { recursive: true });
    cpSync(join(FIXTURES, "vault", "amicode", "memory"), join(source, "amicode", "memory"), { recursive: true });
    writeFileSync(join(source, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');
    cpSync(join(FIXTURES, "public-mount"), join(root, "vault-public"), { recursive: true });
    return { root, registry: join(source, "amicode", "claims"), mount: join(root, "vault-public") };
  }

  it("the mount is discoverable by the conventions: the stack resolves the public mount (marker kind, last in read precedence, read-only)", async () => {
    const { root, mount } = publicStack();
    const stack = resolveMountStack(root);
    expect(stack.mounts).toHaveLength(2);
    expect(stack.mounts[0]).toMatchObject({ kind: "personal", name: "vault-aaron", writable: true });
    expect(stack.mounts[1]).toMatchObject({ kind: "public", name: "vault-public", writable: false });
    // read precedence: the public tier is the stack's outer face (rank last)
    expect(stack.mounts[1]!.path).toBe(mount);
  });

  it("dry-run: the plan names the target mount, the public-safe claim, and the refusals — nothing written", async () => {
    const { root } = publicStack();
    const r = await claimsVerb(["promote", "--tier", "public", "--from", "vault-aaron"], { ...ENV, AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.dry_run).toBe(true);
    expect(json.tier).toBe("public");
    expect(json.target).toMatchObject({ name: "vault-public" });
    // the public-safe claim is selected; the two taint classes refuse BY NAME
    expect(json.selected).toEqual(["best_practice_public_safe.md"]);
    expect(json.refused).toEqual([
      { file: "insight_local_evidence.md", refusals: [expect.stringContaining("private-mechanism") as unknown as string] },
      { file: "insight_mechanism_link.md", refusals: [expect.stringContaining("mechanism") as unknown as string] },
    ]);
    // the proposal body targets the public mount and names the refusals
    const body = json.pr_body as string;
    expect(body).toContain("promote: vault-aaron → vault-public (1 claims, 2026-10-02)");
    expect(body).toContain("Refused by the two-note check");
    // the index render rides the dry-run (the bundle's third artifact)
    expect(json.index as string).toContain("best_practice_public_safe.md");
    expect(existsSync(join(root, "vault-aaron", "amicode", "claims", "promotions"))).toBe(false);
  });

  it("apply: the bundle carries PR-BODY + the public-safe copy + INDEX.md; the refused claims are NOT in the bundle, NOT stamped, named in the body", async () => {
    const { root, registry } = publicStack();
    const state = join(mkdtempSync(join(tmpdir(), "public-state-")), "promote-state.json");
    const r = await claimsVerb(
      ["promote", "--tier", "public", "--from", "vault-aaron", "--state", state, "--apply"],
      { ...ENV, AMICO_VAULTS_ROOT: root },
      { now: NOON },
    );
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json.proposes_only).toBe(true);
    expect(json.auto_merge).toBe(false);
    const bundle = join(registry, "promotions", "promote-20261002-120000");
    expect(readdirSync(bundle).sort()).toEqual(["INDEX.md", "PR-BODY.md", "best_practice_public_safe.md"]);
    // the copy is verbatim + both-ways provenance (promoted_from/promoted_to)
    const copy = readFileSync(join(bundle, "best_practice_public_safe.md"), "utf8");
    expect(copy.startsWith(readFileSync(join(registry, "best_practice_public_safe.md"), "utf8"))).toBe(true);
    expect(copy).toContain("promoted_from: vault-aaron");
    expect(copy).toContain("promoted_to: vault-public");
    // the refused claims never ride the bundle, and are named in the body
    expect(existsSync(join(bundle, "insight_local_evidence.md"))).toBe(false);
    expect(existsSync(join(bundle, "insight_mechanism_link.md"))).toBe(false);
    const body = readFileSync(join(bundle, "PR-BODY.md"), "utf8");
    expect(body).toContain("insight_local_evidence.md");
    expect(body).toContain("insight_mechanism_link.md");
    // the INDEX render is generated from the bundle's claims
    expect(readFileSync(join(bundle, "INDEX.md"), "utf8")).toContain("best_practice_public_safe.md");
    // copy-never-move: the registry keeps every claim, untouched
    expect(readdirSync(registry).filter((f) => f.endsWith(".md")).sort()).toEqual(
      readdirSync(join(FIXTURES, "public-registry")).sort(),
    );
    // only the public-safe claim is stamped as proposed; refusals stay in the pool
    const stamped = JSON.parse(readFileSync(state, "utf8")).proposals as Record<string, unknown>;
    expect(Object.keys(stamped)).toEqual(["best_practice_public_safe.md"]);
  });

  it("a refused claim stays in the pool: the re-run re-refuses it BY NAME, never proposes it", async () => {
    const { root, registry } = publicStack();
    const state = join(mkdtempSync(join(tmpdir(), "public-state-")), "promote-state.json");
    const first = await claimsVerb(
      ["promote", "--tier", "public", "--from", "vault-aaron", "--state", state, "--apply"],
      { ...ENV, AMICO_VAULTS_ROOT: root },
      { now: NOON },
    );
    expect(first.code).toBe(0);
    const second = await claimsVerb(
      ["promote", "--tier", "public", "--from", "vault-aaron", "--state", state, "--apply"],
      { ...ENV, AMICO_VAULTS_ROOT: root },
      { now: () => new Date("2026-10-09T12:00:00.000Z") },
    );
    expect(second.code).toBe(0);
    const json = second.json as Record<string, unknown>;
    expect(json.selected).toEqual([]);
    expect((json.refused as { file: string }[]).map((x) => x.file)).toEqual([
      "insight_local_evidence.md",
      "insight_mechanism_link.md",
    ]);
    // no second bundle: the safe claim is proposed, the taints are refused, nothing else exists
    expect(existsSync(join(registry, "promotions", "promote-20261009-120000"))).toBe(false);
  });

  it("--to an explicit public mount is marker-verified and works without a stack; a NON-public --to is refused (never guessed)", async () => {
    const { root, registry, mount } = publicStack();
    const state = join(mkdtempSync(join(tmpdir(), "public-state-")), "promote-state.json");
    // the explicit mount works even with no public mount in the stack
    const bare = mkdtempSync(join(tmpdir(), "public-bare-"));
    const ok = await claimsVerb(
      ["promote", "--tier", "public", "--registry", registry, "--vault", join(FIXTURES, "vault"), "--to", mount, "--from", "vault-aaron", "--state", state, "--apply"],
      { ...ENV, AMICO_VAULTS_ROOT: bare },
      { now: NOON },
    );
    expect(ok.code).toBe(0);
    expect((ok.json as Record<string, unknown>).target).toMatchObject({ name: "vault-public", path: mount });
    // a non-public dir is refused by its marker — the target is verified, never guessed
    const bad = await claimsVerb(
      ["promote", "--tier", "public", "--registry", registry, "--vault", join(FIXTURES, "vault"), "--to", join(root, "vault-aaron"), "--from", "vault-aaron"],
      { ...ENV, AMICO_VAULTS_ROOT: bare },
      { now: NOON },
    );
    expect(bad.code).toBe(64);
    expect((bad.json as { error: string }).error).toContain("public");
  });

  it("no public mount in the stack and no --to → 64 (the destination is never a guess)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "public-bare-"));
    const registry = tempRegistry(); // scope-team claims only — the target refusal fires before the pool matters
    const r = await claimsVerb(["promote", "--tier", "public", "--registry", registry], { ...ENV, AMICO_VAULTS_ROOT: bare }, { now: NOON });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--to");
  });

  it("--tier bogus → 64", async () => {
    const r = await claimsVerb(["promote", "--tier", "everywhere"], ENV, { now: NOON });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--tier");
  });

  it("the public tier files the SAME promote job receipt (one job, two tiers — no second promotion path)", async () => {
    const { root } = publicStack();
    const dir = mkdtempSync(join(tmpdir(), "public-dash-"));
    const dashboards = join(dir, "dashboards");
    const state = join(mkdtempSync(join(tmpdir(), "public-state-")), "promote-state.json");
    const r = await claimsVerb(
      ["promote", "--tier", "public", "--from", "vault-aaron", "--state", state, "--apply", "--jobs", jobsRegistry(dir), "--dashboards", dashboards],
      { ...ENV, AMICO_VAULTS_ROOT: root },
      { now: NOON },
    );
    expect(r.code).toBe(0);
    expect((r.json as Record<string, Record<string, unknown>>).receipt).toMatchObject({ filed: true, job: "promote" });
    const text = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    expect(text).toContain("## Pass 2026-10-02 — promote — ok");
    expect(text).toContain("public tier");
    expect(text).toContain("refused");
  });
});

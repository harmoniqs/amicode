// Nightly skill-freshness cadence (amicode#587) — the orchestrator's DRY-RUN
// contract, exercised on the lint-harness fixture trees (test/fixtures/skill-drift).
//
// --dry-run is the testable seam by design: it writes the per-surface report
// files and WOULD-DO lines to stderr, and appends NO receipt and touches NO
// issues. The receipt-append and GitHub issue-opener paths are therefore NOT
// network-tested here — they run only outside --dry-run and are verified by
// the documented manual run on the server (issue Testing Decisions).
//
// Like the lint CLI e2e suite, the whole describe runs only under a node with
// native TS type-stripping (the orchestrator execs scripts/skill_drift_lint.mts
// through `node`); it skips cleanly on older node (CI's node 20).
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const NODE_STRIPS_TYPES = (process.features as { typescript?: string } | undefined)?.typescript === "strip";
(NODE_STRIPS_TYPES ? describe : describe.skip)("skill-freshness orchestrator (--dry-run, fixtures)", () => {
  const EXT_ROOT = path.resolve(__dirname, "..", "..");
  const OPS_SCRIPT = path.resolve(EXT_ROOT, "..", "..", "ops", "skill-freshness", "run-skill-freshness.sh");
  const FIXTURES = path.resolve(EXT_ROOT, "test", "fixtures", "skill-drift");
  const FIXTURE_SKILLS = path.join(FIXTURES, "skills"); // mixed tree: clean + drifted + dup + malformed + broken-paths
  const FIXTURE_PACKAGES = path.join(FIXTURES, "packages");

  const tmpDirs: string[] = [];
  function tmpRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-freshness-"));
    tmpDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Env wiring every surface at a fixture/temp path — NOTHING here points at
   *  the real vault, staging tree, receipts journal, or network. The vault
   *  surface defaults to an absent dir (the skipped-surface honesty case). */
  function fixtureEnv(dir: string, overrides: Record<string, string> = {}): Record<string, string> {
    return {
      SKILL_FRESHNESS_LINT: path.join(EXT_ROOT, "scripts", "skill_drift_lint.mts"),
      SKILL_FRESHNESS_PUBLIC: FIXTURE_SKILLS,
      SKILL_FRESHNESS_VAULT: path.join(dir, "absent-vault-skills"),
      SKILL_FRESHNESS_STAGING: FIXTURE_SKILLS,
      SKILL_FRESHNESS_PACKAGES: FIXTURE_PACKAGES,
      SKILL_FRESHNESS_REPORTS: path.join(dir, "reports"),
      SKILL_FRESHNESS_RECEIPTS: path.join(dir, "receipts", "upgrade-receipts.jsonl"),
      SKILL_FRESHNESS_MIN_PUBLIC: "1",
      SKILL_FRESHNESS_MIN_VAULT: "1",
      SKILL_FRESHNESS_MIN_STAGING: "1",
      ...overrides,
    };
  }

  function runDryRun(env: Record<string, string>) {
    return spawnSync("/bin/bash", [OPS_SCRIPT, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  function readReport(reportsDir: string, surface: string): any {
    const candidates = fs.readdirSync(reportsDir).filter((f) => f.endsWith(`-${surface}.json`));
    expect(candidates, `one ${surface} report expected`).toHaveLength(1);
    return JSON.parse(fs.readFileSync(path.join(reportsDir, candidates[0]), "utf8"));
  }

  it("mixed tree: exits 1 on structural failures, writes both ran-surface reports + WOULD-DO, and NO receipt", () => {
    const dir = tmpRoot();
    const env = fixtureEnv(dir);
    const r = runDryRun(env);

    expect(r.status).toBe(1); // structural failures in the fixture tree (dup + malformed + broken link)
    expect(r.stderr).toMatch(/WOULD-DO/);
    expect(r.stderr).toMatch(/WOULD-DO.*tracking issue/i); // drift detected → the issue WOULD be opened/updated
    // skipped-surface honesty: the absent vault dir is reported, never a crash
    expect(r.stderr).toMatch(/skip/i);
    expect(r.stderr).toMatch(/absent-vault-skills/);

    // reports written for the two surfaces that ran; each parses as the lint JSON
    const publicReport = readReport(path.join(dir, "reports"), "public");
    expect(publicReport.ok).toBe(false);
    expect(publicReport.aggregate.structuralFailures).toBeGreaterThanOrEqual(1);
    const stagingReport = readReport(path.join(dir, "reports"), "staging");
    expect(stagingReport.ok).toBe(false);
    // staging ran the FULL cross-check (semantic drift reported), public was structural-only
    expect(stagingReport.aggregate.drifted).toBeGreaterThanOrEqual(1);
    expect(publicReport.aggregate.verified + publicReport.aggregate.drifted).toBe(0);

    // the receipt journal was NOT touched (dry-run appends nothing)
    expect(fs.existsSync(env.SKILL_FRESHNESS_RECEIPTS)).toBe(false);
  });

  it("clean tree: exits 0, clean reports, WOULD-DO says no issue action, and still NO receipt", () => {
    const dir = tmpRoot();
    const cleanTree = path.join(dir, "clean-skills");
    fs.cpSync(path.join(FIXTURE_SKILLS, "clean"), path.join(cleanTree, "clean"), { recursive: true });
    const env = fixtureEnv(dir, {
      SKILL_FRESHNESS_PUBLIC: cleanTree,
      SKILL_FRESHNESS_STAGING: cleanTree,
    });
    const r = runDryRun(env);

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WOULD-DO.*no issue action/i);
    const publicReport = readReport(path.join(dir, "reports"), "public");
    expect(publicReport.ok).toBe(true);
    const stagingReport = readReport(path.join(dir, "reports"), "staging");
    expect(stagingReport.ok).toBe(true);
    expect(stagingReport.aggregate.drifted).toBe(0);
    expect(stagingReport.aggregate.verified).toBeGreaterThan(0); // full cross-check actually verified against FixturePkg
    expect(fs.existsSync(env.SKILL_FRESHNESS_RECEIPTS)).toBe(false);
  });

  it("every surface absent: all skipped honestly, no crash, exit 0, only the WOULD-DO skeleton on stderr", () => {
    const dir = tmpRoot();
    const env = fixtureEnv(dir, {
      SKILL_FRESHNESS_PUBLIC: path.join(dir, "absent-public"),
      SKILL_FRESHNESS_STAGING: path.join(dir, "absent-staging"),
    });
    const r = runDryRun(env);

    expect(r.status).toBe(0); // skipping is honest degradation, not failure
    expect(r.stderr).toMatch(/absent-public/);
    expect(r.stderr).toMatch(/absent-staging/);
    expect(r.stderr).toMatch(/absent-vault-skills/);
    expect(fs.existsSync(path.join(dir, "reports"))).toBe(false); // nothing ran → nothing reported
    expect(fs.existsSync(env.SKILL_FRESHNESS_RECEIPTS)).toBe(false);
  });

  it("min-skills floor fires through the orchestrator: 1-skill tree with floor 99 → exit 1, floor failure in the report", () => {
    const dir = tmpRoot();
    const cleanTree = path.join(dir, "clean-skills");
    fs.cpSync(path.join(FIXTURE_SKILLS, "clean"), path.join(cleanTree, "clean"), { recursive: true });
    const env = fixtureEnv(dir, {
      SKILL_FRESHNESS_STAGING: cleanTree,
      SKILL_FRESHNESS_MIN_STAGING: "99",
    });
    const r = runDryRun(env);

    expect(r.status).toBe(1);
    const stagingReport = readReport(path.join(dir, "reports"), "staging");
    expect(stagingReport.topStructural.map((f: { message: string }) => f.message)).toContainEqual(
      "min-skills floor not met: 1 < 99",
    );
    expect(fs.existsSync(env.SKILL_FRESHNESS_RECEIPTS)).toBe(false);
  });

  it("absent packages root degrades honestly: staging still runs, claims go UNVERIFIABLE, exit reflects structure only", () => {
    const dir = tmpRoot();
    const cleanTree = path.join(dir, "clean-skills");
    fs.cpSync(path.join(FIXTURE_SKILLS, "clean"), path.join(cleanTree, "clean"), { recursive: true });
    const env = fixtureEnv(dir, {
      SKILL_FRESHNESS_PUBLIC: cleanTree, // public clean too — this test isolates the
      SKILL_FRESHNESS_STAGING: cleanTree, // absent-packages degradation, not the mixed tree
      SKILL_FRESHNESS_PACKAGES: path.join(dir, "absent-packages"),
    });
    const r = runDryRun(env);

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/absent-packages/); // noted, not fatal
    const stagingReport = readReport(path.join(dir, "reports"), "staging");
    expect(stagingReport.ok).toBe(true);
    expect(stagingReport.aggregate.unverifiable).toBeGreaterThan(0);
    expect(fs.existsSync(env.SKILL_FRESHNESS_RECEIPTS)).toBe(false);
  });
});

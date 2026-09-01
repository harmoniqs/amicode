// campaign_verb.test.ts — SEAM 7 (#709): the `amico campaign decay` CLI surface
// — the non-UI delivery path. Prints the decay trend (family, campaign counts,
// the three metrics' deltas) from EXISTING records only. The verb body is
// src/campaign_verb.ts; the pure computation it projects is src/flywheel.ts.
import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignVerb } from "../src/campaign_verb.js";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FLYWHEEL_FIXTURES = join(PKG_ROOT, "fixtures", "flywheel");

function pinnedRunsFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-runs-"));
  cpSync(join(FLYWHEEL_FIXTURES, "runs"), root, { recursive: true });
  utimesSync(
    join(root, "lab-fx", "r20260801-020000Z-fa02", "FINISHED"),
    new Date("2026-08-01T02:03:20Z"),
    new Date("2026-08-01T02:03:20Z"),
  );
  return root;
}

describe("amico campaign decay — the CLI surface (SEAM 7, #709)", () => {
  it("prints the decay trend: families, campaign counts, the three metrics' deltas — from existing records only", () => {
    const { json, code } = campaignVerb([
      "decay",
      "--runs-root",
      pinnedRunsFixture(),
      "--task-root",
      join(FLYWHEEL_FIXTURES, "tasks"),
      "--store-root",
      join(FLYWHEEL_FIXTURES, "store"),
    ]);
    expect(code).toBe(0);
    const r = json as Record<string, any>;
    expect(r.verb).toBe("campaign");
    expect(r.subcommand).toBe("decay");
    expect(r.scanned.runs).toBeGreaterThan(0);
    expect(r.scanned.tasks).toBeGreaterThan(0);
    expect(r.scanned.store).toBeGreaterThan(0);
    const fp = r.families.find((f: any) => f.family === "first-pulse");
    expect(fp).toBeDefined();
    const runDirSeries = fp.scopes.find((s: any) => s.record_kind === "run-dir");
    expect(runDirSeries.campaigns.length).toBe(3);
    expect(runDirSeries.campaigns[1].deltas.iterations).toBe(-70);
    expect(runDirSeries.campaigns[0].decay).toBe("baseline");
    // the store series + the task series are separate campaigns of the same family
    expect(fp.scopes.map((s: any) => s.record_kind).sort()).toEqual(["run-dir", "store-entry"]);
    // the named findings ride the output (F4: stated, never silent)
    expect(r.findings.length).toBe(6);
    expect(r.findings.join(" ")).toMatch(/F-709-1/);
  });

  it("no --runs-root → the studio runs root (AMICODE_STUDIO_CONFIG manifest), hermetic", () => {
    const studio = mkdtempSync(join(tmpdir(), "flywheel-studio-"));
    const absent = join(tmpdir(), "no-such-flywheel-store");
    writeFileSync(
      join(studio, "config.toml"),
      `schema_version = "1"\nstudio_root = "${studio}"\nruns = "${pinnedRunsFixture()}"\n`,
    );
    const prev = process.env.AMICODE_STUDIO_CONFIG;
    process.env.AMICODE_STUDIO_CONFIG = join(studio, "config.toml");
    try {
      // --store-root isolated so the machine's real bank never leaks into the report
      const { json, code } = campaignVerb(["decay", "--store-root", absent]);
      expect(code).toBe(0);
      const r = json as Record<string, any>;
      expect(r.runs_root[0]).toContain("flywheel-runs");
      expect(r.families.length).toBeGreaterThan(0);
    } finally {
      if (prev === undefined) delete process.env.AMICODE_STUDIO_CONFIG;
      else process.env.AMICODE_STUDIO_CONFIG = prev;
    }
  });

  it("an absent runs root is an honest EMPTY report, exit 0 — never an error dump", () => {
    const absent = join(tmpdir(), "no-such-flywheel-root");
    const { json, code } = campaignVerb(["decay", "--runs-root", absent, "--store-root", absent]);
    expect(code).toBe(0);
    const r = json as Record<string, any>;
    expect(r.families).toEqual([]);
    expect(r.findings.length).toBeGreaterThan(0); // the honesty is static
  });

  it("an unknown subcommand is a usage error (exit 64) naming the usage", () => {
    const { json, code } = campaignVerb(["trend"]);
    expect(code).toBe(64);
    const r = json as Record<string, any>;
    expect(r.error).toMatch(/unknown subcommand/);
    expect(r.usage).toMatch(/amico campaign decay/);
  });
});

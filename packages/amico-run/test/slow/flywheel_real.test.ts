// flywheel_real.test.ts — SEAM 7 (#709): the REAL-STORE proof, env-gated.
// `flywheel_decay_computed_on_one_historical_run_dir == 1` — the decay
// computation proven against the machine's real historical runs store (the
// runs store is machine-local, so the gate is an env var; the director runs
// it against the real backlog):
//
//   AMICO_TEST_RUNS_ROOT="$HOME/armonia/data/runs" \
//     pnpm --filter @amicode/amico-run run test:slow
//
// The proof is COMPUTABILITY, not a dashboard: the derivation attributes real
// run dirs to a family, the family aggregates into ≥2 historical campaigns,
// and the three metrics' deltas compute where the records carry them. Also
// aggregates the pulse bank's real entries where the fields permit.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { computeDecay, deriveRunDirFamily } from "../../src/flywheel.js";

const RUNS_ROOT = process.env.AMICO_TEST_RUNS_ROOT ?? join(homedir(), "armonia", "data", "runs");

describe.skipIf(!process.env.AMICO_TEST_RUNS_ROOT)("slow: the flywheel decay over the REAL runs store", () => {
  it("a REAL historical run dir derives to a family with its metrics (the computability proof, one record)", () => {
    expect(existsSync(RUNS_ROOT)).toBe(true);
    const report = computeDecay({ runsRoots: [RUNS_ROOT] });
    expect(report.scanned.runs).toBeGreaterThan(200); // the ~284-run backlog (or grown)
    const runDirSeries = report.families.flatMap((f) => f.scopes).filter((s) => s.record_kind === "run-dir");
    expect(runDirSeries.length).toBeGreaterThan(0);
    expect(
      runDirSeries.some(
        (s) =>
          s.campaigns.some((c) => c.iterations !== null) &&
          s.campaigns.some((c) => c.wall_s !== null && c.wall_source !== "unavailable"),
      ),
    ).toBe(true);
  });

  it("the historical backlog aggregates into ≥2 campaigns of a family — a REAL trend computes", () => {
    const report = computeDecay({ runsRoots: [RUNS_ROOT] });
    const withTrend = report.families.flatMap((f) => f.scopes).filter((s) => s.campaigns.length >= 2);
    expect(withTrend.length).toBeGreaterThan(0);
    // a series with ≥2 campaigns must carry at least one computed delta metric
    expect(
      withTrend.some((s) => {
        const deltas = s.campaigns.filter((c) => c.deltas !== null);
        return (
          deltas.length > 0 &&
          deltas.some(
            (d) => d.deltas!.iterations !== null || d.deltas!.wall_s !== null || d.deltas!.acquisitions !== null,
          )
        );
      }),
    ).toBe(true);
    // the FIRST campaign of every series is a stated baseline — never faked
    for (const s of withTrend) {
      expect(s.campaigns[0]!.decay).toBe("baseline");
      expect(s.campaigns[0]!.deltas).toBeNull();
    }
  });

  it("one concrete historical run dir, end-to-end (the named proof artifact)", () => {
    // ground the proof on ONE specific real record: derive it, then verify
    // the family + the metrics the record actually carries
    const lab = join(RUNS_ROOT, "default");
    const names = readdirSync(lab).filter((n) => n.startsWith("r2"));
    const firstRun = names.find(
      (n) => existsSync(join(lab, n, "FINISHED")) && existsSync(join(lab, n, "result.toml")),
    );
    expect(firstRun).toBeDefined();
    const r = deriveRunDirFamily(join(lab, firstRun!));
    expect(r?.kind).toBe("run-dir");
    if (r?.kind !== "run-dir") return;
    expect(r.family).toBe("first-pulse"); // the real backlog: fixed-time gate synthesis
    expect(r.platform).toBe("transmon"); // [system].template = "TransmonSystem"
    expect(r.metrics.iterations).toBeGreaterThan(0); // result.toml iterations
    // the wall clock: record-carried wall_seconds, the FINISHED-mtime fallback,
    // or honestly UNAVAILABLE — the mtime is second-truncated while created_at
    // is ms-precision, so a sub-second run can read mtime < created_at: stated
    // (wall_source "unavailable"), never a conjured number (F-709-1).
    expect(["record", "finished-mtime", "unavailable"]).toContain(r.metrics.wall_source);
    if (r.metrics.wall_s !== undefined) expect(r.metrics.wall_s).toBeGreaterThanOrEqual(0);
    if (r.metrics.wall_source === "finished-mtime") {
      expect(statSync(join(r.dir, "FINISHED")).mtimeMs).toBeGreaterThan(0); // the fs fallback is real
    }
  });

  it("aggregates the historical PULSE BANK where the fields permit (store families across ≥2 days)", () => {
    const report = computeDecay({
      runsRoots: [RUNS_ROOT],
      storeRoots: [join(homedir(), ".amico", "vaults", "armonissima", "catalog")],
    });
    const storeSeries = report.families
      .filter((f) => f.family === "first-pulse" || f.family === "tune-up")
      .flatMap((f) => f.scopes)
      .filter((s) => s.record_kind === "store-entry");
    expect(report.scanned.store).toBeGreaterThan(25); // the real bank's ~32 entries
    expect(storeSeries.length).toBeGreaterThan(0);
    // the real bank spans 2026-03-24..26: the first-pulse store series carries ≥2 campaigns
    const fp = storeSeries.find((s) => s.scope.startsWith("bank:"));
    expect(fp!.campaigns.length).toBeGreaterThanOrEqual(2);
  });
});

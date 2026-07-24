// Ledger query aggregation (Plan 3 / L1 Task 4) — L-A's honest priors: medians +
// IQR over source="user" solves, joined to their verdicts on problem_hash, with a
// verified count, honest provenance, and a mechanically-capped confidence.
// Run: pnpm --filter @amicode/amico-run test ledger_query
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRecord, type SolveRecord, type LedgerRecord } from "../src/ledger.js";
import { bucketN, bucketT, queryDefaults, aggregate, K_MIN } from "../src/ledger_query.js";

let dir: string;
const prevEnv = process.env.AMICO_LEDGER;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ledger-q-"));
  process.env.AMICO_LEDGER = join(dir, "runs.jsonl");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (prevEnv === undefined) delete process.env.AMICO_LEDGER;
  else process.env.AMICO_LEDGER = prevEnv;
});

function solve(over: {
  problem_hash: string;
  structure_hash?: string;
  source?: SolveRecord["source"];
  N?: number;
  T?: number;
  Q?: number;
  R?: number;
  du_bound?: number;
  max_iter?: number;
  integrator?: string;
  platform?: string;
  template?: string;
  trajectory?: string;
  levels?: number;
  goal?: string;
}): SolveRecord {
  const summary: SolveRecord["summary"] = {
    platform: over.platform ?? "transmon",
    template: over.template ?? "SplinePulseProblem",
    trajectory: over.trajectory ?? "unitary",
    N: over.N ?? 100,
    T: over.T ?? 100.0,
    goal: over.goal ?? "CZ",
    solver: "ipopt",
    strategy: "direct",
  };
  if (over.levels !== undefined) summary.levels = over.levels;
  if (over.Q !== undefined) (summary as Record<string, unknown>).Q = over.Q;
  if (over.R !== undefined) (summary as Record<string, unknown>).R = over.R;
  if (over.du_bound !== undefined) (summary as Record<string, unknown>).du_bound = over.du_bound;
  if (over.max_iter !== undefined) (summary as Record<string, unknown>).max_iter = over.max_iter;
  if (over.integrator !== undefined) (summary as Record<string, unknown>).integrator = over.integrator;
  return {
    type: "solve",
    ts: "t",
    problem_hash: over.problem_hash,
    structure_hash: over.structure_hash ?? "abc",
    kind: "control",
    tier: "spec",
    summary,
    source: over.source ?? "user",
    outcome: { converged: true, fidelity: 0.999, iterations: 200 },
    versions: { Piccolo: "0.9.2" },
  };
}
const agree = (problem_hash: string): LedgerRecord => ({ type: "verdict", ts: "t", problem_hash, verdict: "agree" });

describe("bucketN / bucketT edges", () => {
  it("bucketN is monotone and puts common regimes in distinct buckets", () => {
    expect(bucketN(10)).toBe(0);
    expect(bucketN(100)).toBe(bucketN(100)); // deterministic
    expect(bucketN(11)).toBe(bucketN(24)); // same sub-25 bucket
    expect(bucketN(300)).toBeGreaterThan(bucketN(100));
  });
  it("bucketT is monotone across duration decades", () => {
    expect(bucketT(5)).toBe(0);
    expect(bucketT(500)).toBeGreaterThan(bucketT(50));
  });
});

describe("queryDefaults — honest priors at a structure_hash × bucket", () => {
  it("medians over source=user solves; excludes replay AND simulated; joins verdicts on problem_hash", () => {
    // two USER solves, DISTINCT problem_hashes (same structure+bucket) — the
    // realistic L-A case where Q/R/du_bound vary; exactly one is verified.
    appendRecord(solve({ problem_hash: "ph-A", Q: 100_000, R: 1e-4, du_bound: 40, max_iter: 300, integrator: "spline" }));
    appendRecord(solve({ problem_hash: "ph-B", Q: 200_000, R: 1e-4, du_bound: 60, max_iter: 500, integrator: "spline" }));
    appendRecord(agree("ph-A")); // verifies ph-A only
    // noise that must NOT contribute to priors:
    appendRecord(solve({ problem_hash: "ph-C", source: "replay", Q: 999_999 }));
    appendRecord(solve({ problem_hash: "ph-D", source: "simulated", Q: 888_888 }));

    const q = queryDefaults({ structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) });

    expect(q.total).toBe(2); // replay + simulated excluded
    expect(q.verified).toBe(1); // only ph-A has an agree verdict
    expect(q.key).toBe("primary");
    expect(q.params.Q?.value).toBe(150_000); // median(100k, 200k)
    expect(q.params.du_bound?.value).toBe(50); // median(40, 60)
    expect(q.params.integrator?.value).toBe("spline"); // categorical mode
    expect(q.provenance).toMatch(/n=2 runs, 1 verified/);
    expect(["high", "medium", "low"]).toContain(q.confidence);
  });

  // structure_hash covers the TYPE skeleton, not the task: a CZ and an X gate on the
// same system/template/solver share a structure_hash by design (correct for warm-pool
  // routing). Without the goal key, an easy X gate inherits a hard CZ's medians.
  it("goal key keeps a CZ's medians out of an X gate's bucket (same structure_hash)", () => {
    appendRecord(solve({ problem_hash: "cz-1", goal: "CZ", Q: 200_000, max_iter: 500 }));
    appendRecord(solve({ problem_hash: "cz-2", goal: "CZ", Q: 200_000, max_iter: 500 }));
    appendRecord(solve({ problem_hash: "x-1", goal: "X", Q: 1_000, max_iter: 50 }));
    appendRecord(solve({ problem_hash: "x-2", goal: "X", Q: 1_000, max_iter: 50 }));

    const base = { structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) };

    const x = queryDefaults({ ...base, goal: "X" });
    expect(x.total).toBe(2); // ONLY the X solves
    expect(x.params.Q?.value).toBe(1_000); // NOT median(1k,1k,200k,200k) = 100_500
    expect(x.params.max_iter?.value).toBe(50);
    expect(x.provenance).toMatch(/goal=X/);

    const cz = queryDefaults({ ...base, goal: "CZ" });
    expect(cz.total).toBe(2);
    expect(cz.params.Q?.value).toBe(200_000);

    // Omitting the goal is still allowed — but it mixes both populations, and the
    // provenance must SAY so rather than implying a tighter key than was used.
    const mixed = queryDefaults(base);
    expect(mixed.total).toBe(4);
    expect(mixed.params.Q?.value).toBe(100_500); // the misleading average, made visible
    expect(mixed.provenance).toMatch(/goal not keyed/);
  });

  it("goal key applies to the FALLBACK key too, not just the primary", () => {
    // distinct structure_hashes so the primary key can never match → fallback path.
    appendRecord(solve({ problem_hash: "f-cz", structure_hash: "s1", goal: "CZ", Q: 300_000 }));
    appendRecord(solve({ problem_hash: "f-x1", structure_hash: "s2", goal: "X", Q: 2_000 }));
    appendRecord(solve({ problem_hash: "f-x2", structure_hash: "s3", goal: "X", Q: 2_000 }));

    const q = queryDefaults({
      structure_hash: "no-such-structure",
      n_bucket: bucketN(100),
      t_bucket: bucketT(100),
      goal: "X",
      platform: "transmon",
      template: "SplinePulseProblem",
      trajectory: "unitary",
    });
    expect(q.key).toBe("fallback");
    expect(q.total).toBe(2); // the CZ solve is excluded by the goal key
    expect(q.params.Q?.value).toBe(2_000);
  });

  it("interim cap: an unverified contributing run bars 'high' (caps at medium)", () => {
    // many tight-IQR user solves but NONE verified → would-be-high, capped medium.
    for (let i = 0; i < 8; i++) {
      appendRecord(solve({ problem_hash: `ph-${i}`, Q: 100_000, R: 1e-4, du_bound: 50 }));
    }
    const q = queryDefaults({ structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) });
    expect(q.total).toBe(8);
    expect(q.verified).toBe(0);
    expect(q.confidence).toBe("medium"); // interim cap — not "high"
  });

  it("all-verified tight-IQR high-n aggregation earns 'high'", () => {
    for (let i = 0; i < 6; i++) {
      appendRecord(solve({ problem_hash: `ph-${i}`, Q: 100_000, R: 1e-4, du_bound: 50 }));
      appendRecord(agree(`ph-${i}`));
    }
    const q = queryDefaults({ structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) });
    expect(q.verified).toBe(6);
    expect(q.confidence).toBe("high");
  });

  it("sparse (below K_MIN at the primary, no fallback key) → low confidence", () => {
    appendRecord(solve({ problem_hash: "ph-1", Q: 100_000 }));
    const q = queryDefaults({ structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) });
    expect(q.total).toBeLessThan(K_MIN);
    expect(q.confidence).toBe("low");
  });

  it("relaxes to the (platform, template, trajectory, levels) fallback key when primary < K_MIN", () => {
    // query structure has a single solve (< K_MIN) → fall back to the coarse key,
    // which matches solves at OTHER structure_hashes sharing the attributes.
    appendRecord(solve({ problem_hash: "ph-x", structure_hash: "xyz", levels: 3, Q: 111_111 }));
    for (let i = 0; i < 3; i++) {
      appendRecord(solve({ problem_hash: `ph-f${i}`, structure_hash: `other-${i}`, levels: 3, Q: 120_000 }));
    }
    const q = queryDefaults({
      structure_hash: "xyz",
      n_bucket: bucketN(100),
      t_bucket: bucketT(100),
      platform: "transmon",
      template: "SplinePulseProblem",
      trajectory: "unitary",
      levels: 3,
    });
    expect(q.key).toBe("fallback");
    expect(q.total).toBeGreaterThanOrEqual(K_MIN);
  });

  it("no matches anywhere → key 'none', empty params, low, honest provenance", () => {
    const q = queryDefaults({ structure_hash: "absent", n_bucket: 0, t_bucket: 0 });
    expect(q.key).toBe("none");
    expect(q.total).toBe(0);
    expect(q.confidence).toBe("low");
    expect(q.provenance).toMatch(/n=0 runs, 0 verified/);
  });

  it("aggregate is a pure function over a record array (no ledger I/O)", () => {
    const recs: LedgerRecord[] = [
      solve({ problem_hash: "ph-A", Q: 100_000 }),
      solve({ problem_hash: "ph-B", Q: 300_000 }),
      agree("ph-A"),
    ];
    const q = aggregate(recs, { structure_hash: "abc", n_bucket: bucketN(100), t_bucket: bucketT(100) });
    expect(q.params.Q?.value).toBe(200_000);
    expect(q.verified).toBe(1);
  });
});

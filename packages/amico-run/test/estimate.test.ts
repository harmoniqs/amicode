// Δ10 / issue #34 (C1) — the v0 estimator: a faithful port of the aws-infra
// t-shirt-sizing logic to SolveSpec-assembly time.
//
// ── GOLDEN TABLE PROVENANCE ──────────────────────────────────────────────────
// Reference: aws-infra @ origin/staging : examples/tshirt_sizing.py (A-v1).
// Every `score` / `size` below was produced by RUNNING that exact file
// (extract_key_vars → get_memory_estimate → get_tshirt_size) on the quoted
// Julia `content` (python3, 2026-07-20). The reference math:
//   knot_point_state_dim = prod(levels.values)   (1 when levels are absent
//                                                 or the fill() length var is
//                                                 unresolvable — the reference
//                                                 stores an error STRING and
//                                                 get_memory_estimate skips it)
//   knot_point_state_dim *= knot_point_state_dim (unitary trajectory)
//   score = N * knot_point_state_dim**2          (i.e. N * prod(levels)^4)
//   size  = score > 12000 ? "MEDIUM" : "SMALL"   (strict >; A-v1 has no LARGE)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import {
  extractKeyVars,
  memoryScore,
  tshirtSize,
  estimateFromVars,
  localRamBytes,
  BYTES_PER_SCORE_UNIT,
  SCORE_MEDIUM_THRESHOLD,
} from "../src/estimate.js";

interface GoldenCase {
  name: string;
  content: string; // the Julia source fed to the reference
  N: number;
  num_qudits?: number;
  levels?: { length: number; values: number[] };
  levelsUnresolved?: boolean; // reference stored an error string for levels
  score: number; // reference get_memory_estimate output
  size: "SMALL" | "MEDIUM"; // reference get_tshirt_size output
}

const GOLDEN: GoldenCase[] = [
  {
    name: "fill(2, num_qudits), N=50 → 12800 MEDIUM",
    content: "num_qudits = 2\nlevels = fill(2, num_qudits)\nN = 50\n",
    N: 50,
    num_qudits: 2,
    levels: { length: 2, values: [2, 2] },
    score: 12800,
    size: "MEDIUM",
  },
  {
    name: "fill(2, num_qudits), N=40 → 10240 SMALL",
    content: "num_qudits = 2\nlevels = fill(2, num_qudits)\nN = 40\n",
    N: 40,
    num_qudits: 2,
    levels: { length: 2, values: [2, 2] },
    score: 10240,
    size: "SMALL",
  },
  {
    name: "levels=[2], N=750 → exactly 12000 is SMALL (strict >)",
    content: "N = 750\nlevels = [2]\n",
    N: 750,
    levels: { length: 1, values: [2] },
    score: 12000,
    size: "SMALL",
  },
  {
    name: "levels=[2], N=751 → 12016 MEDIUM (boundary)",
    content: "N = 751\nlevels = [2]\n",
    N: 751,
    levels: { length: 1, values: [2] },
    score: 12016,
    size: "MEDIUM",
  },
  {
    name: "scalar levels=3, N=100 → 8100 SMALL",
    content: "N = 100\nlevels = 3\n",
    N: 100,
    levels: { length: 1, values: [3] },
    score: 8100,
    size: "SMALL",
  },
  {
    name: "num_qubits alias, fill(2, num_qubits), N=3 → 12288 MEDIUM",
    content: "num_qubits = 3\nlevels = fill(2, num_qubits)\nN = 3\n",
    N: 3,
    num_qudits: 3,
    levels: { length: 3, values: [2, 2, 2] },
    score: 12288,
    size: "MEDIUM",
  },
  {
    name: "num_qubits alias, fill(2, num_qubits), N=2 → 8192 SMALL",
    content: "num_qubits = 3\nlevels = fill(2, num_qubits)\nN = 2\n",
    N: 2,
    num_qudits: 3,
    levels: { length: 3, values: [2, 2, 2] },
    score: 8192,
    size: "SMALL",
  },
  {
    name: "fill(3, dims) with a named length var → 43046721 MEDIUM",
    content: "dims = 4\nlevels = fill(3, dims)\nN = 1\n",
    N: 1,
    levels: { length: 4, values: [3, 3, 3, 3] },
    score: 43046721,
    size: "MEDIUM",
  },
  {
    name: "levels=[3,3,2], N=100 → 10497600 MEDIUM",
    content: "N = 100\nnum_qudits = 3\nlevels = [3, 3, 2]\n",
    N: 100,
    num_qudits: 3,
    levels: { length: 3, values: [3, 3, 2] },
    score: 10497600,
    size: "MEDIUM",
  },
  {
    name: "no levels at all → score falls back to N (reference behavior)",
    content: "N = 300\n",
    N: 300,
    score: 300,
    size: "SMALL",
  },
  {
    name: "unresolvable fill() length var → levels dropped, score = N",
    content: "N = 300\nlevels = fill(2, mystery)\n",
    N: 300,
    levelsUnresolved: true,
    score: 300,
    size: "SMALL",
  },
  {
    name: "indented assignments still match (^\\s* anchors)",
    content: "  N = 60\n  num_qudits = 2\n  levels = fill(2, num_qudits)\n",
    N: 60,
    num_qudits: 2,
    levels: { length: 2, values: [2, 2] },
    score: 15360,
    size: "MEDIUM",
  },
];

// ── AC1: sizeClass matches tshirt_sizing.py on the same {N, levels, num_qudits} ──
describe("estimator port — golden table vs aws-infra tshirt_sizing.py", () => {
  for (const g of GOLDEN) {
    it(g.name, () => {
      const vars = extractKeyVars(g.content);
      expect(vars.N).toBe(g.N);
      expect(vars.num_qudits).toBe(g.num_qudits);
      if (g.levelsUnresolved) {
        expect(vars.levels).toBeUndefined();
        expect(vars.levelsUnresolved).toBeTruthy();
      } else {
        expect(vars.levels).toEqual(g.levels);
      }
      const score = memoryScore(vars);
      expect(score).toBe(g.score);
      expect(tshirtSize(score)).toBe(g.size);
    });
  }

  it("threshold constant is the reference's 12000", () => {
    expect(SCORE_MEDIUM_THRESHOLD).toBe(12000);
  });

  it("levels precedence is fill > array > scalar, as in the reference", () => {
    // All three forms present: the reference's fill() branch wins regardless of line order.
    const vars = extractKeyVars("levels = [5, 5]\nlevels = 7\nn_sys = 3\nlevels = fill(2, n_sys)\nN = 10\n");
    expect(vars.levels).toEqual({ length: 3, values: [2, 2, 2] });
  });
});

// ── AC2: estimate over the local-RAM threshold surfaces the offload suggestion ──
describe("offload suggestion vs local RAM", () => {
  const vars = { N: 50, num_qudits: 2, levels: { length: 2, values: [2, 2] } }; // score 12800

  it("estimatedBytes = score × 8 (Float64 count)", () => {
    const e = estimateFromVars(vars, {});
    expect(e.score).toBe(12800);
    expect(e.estimatedBytes).toBe(12800 * BYTES_PER_SCORE_UNIT);
  });

  it("estimate over the threshold → offloadSuggested true, reason says so", () => {
    const e = estimateFromVars(vars, { AMICO_LOCAL_RAM_BYTES: "1024" });
    expect(e.offloadSuggested).toBe(true);
    expect(e.localRamBytes).toBe(1024);
    expect(e.reason).toMatch(/exceeds local RAM/);
    expect(e.reason).toMatch(/nothing auto-routes/);
  });

  it("estimate under the threshold → offloadSuggested false", () => {
    const e = estimateFromVars(vars, { AMICO_LOCAL_RAM_BYTES: String(1024 ** 4) });
    expect(e.offloadSuggested).toBe(false);
    expect(e.reason).toMatch(/fits within local RAM/);
  });

  it("estimate exactly AT the threshold does NOT suggest (strict >)", () => {
    const e = estimateFromVars(vars, { AMICO_LOCAL_RAM_BYTES: String(12800 * BYTES_PER_SCORE_UNIT) });
    expect(e.offloadSuggested).toBe(false);
  });

  it("no env override → threshold is the machine's total RAM (os.totalmem)", () => {
    expect(localRamBytes({})).toBe(totalmem());
  });

  it("invalid AMICO_LOCAL_RAM_BYTES → loud ConfigError, never a silent fallback", () => {
    expect(() => localRamBytes({ AMICO_LOCAL_RAM_BYTES: "lots" })).toThrow(/AMICO_LOCAL_RAM_BYTES/);
    expect(() => localRamBytes({ AMICO_LOCAL_RAM_BYTES: "-5" })).toThrow(/AMICO_LOCAL_RAM_BYTES/);
  });

  it("sizeClass and suggestion are independent: a SMALL solve can still exceed a tiny RAM budget", () => {
    const e = estimateFromVars({ N: 300 }, { AMICO_LOCAL_RAM_BYTES: "100" }); // score 300 → SMALL
    expect(e.sizeClass).toBe("SMALL");
    expect(e.offloadSuggested).toBe(true);
  });
});


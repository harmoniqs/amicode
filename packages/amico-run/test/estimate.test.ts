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
import { execFileSync, spawnSync } from "node:child_process";
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

// ── AC3: the CLI seam — `amico-run estimate` (script or --spec), data only ──
const BUNDLE = join(__dirname, "..", "dist", "amico-run.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "amico-est-"));
}

const SCRIPT_MEDIUM = "num_qudits = 2\nlevels = fill(2, num_qudits)\nN = 50\n"; // score 12800 → MEDIUM

describe("estimate subcommand", () => {
  it("estimate <script.jl> → the full JSON contract on stdout", () => {
    const dir = tmp();
    const script = join(dir, "solve.jl");
    writeFileSync(script, SCRIPT_MEDIUM);
    const r = run(["estimate", script], { AMICO_LOCAL_RAM_BYTES: "1024" });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({
      sizeClass: "MEDIUM",
      score: 12800,
      estimatedBytes: 12800 * 8,
      localRamBytes: 1024,
      offloadSuggested: true,
      reason: expect.stringMatching(/exceeds local RAM/),
      inputs: { N: 50, num_qudits: 2, levels: { length: 2, values: [2, 2] } },
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("estimate --spec <solvespec.json> → same contract via the spec's script_path", () => {
    const dir = tmp();
    writeFileSync(join(dir, "solve.jl"), SCRIPT_MEDIUM);
    const spec = join(dir, "spec.json");
    // relative script_path resolves against the spec file's directory (relocatable pair)
    writeFileSync(
      spec,
      JSON.stringify({ schema_version: "2", script_path: "solve.jl", lab_id: "lab-1", executor: "local" }),
    );
    const r = run(["estimate", "--spec", spec], { AMICO_LOCAL_RAM_BYTES: String(1024 ** 4) });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.sizeClass).toBe("MEDIUM");
    expect(out.offloadSuggested).toBe(false);
    expect(out.inputs).toEqual({ N: 50, num_qudits: 2, levels: { length: 2, values: [2, 2] } });
    rmSync(dir, { recursive: true, force: true });
  });

  it("NOTHING auto-routes: output is data (no executor key), the spec file is not modified", () => {
    const dir = tmp();
    writeFileSync(join(dir, "solve.jl"), SCRIPT_MEDIUM);
    const spec = join(dir, "spec.json");
    const specBody = JSON.stringify({ schema_version: "2", script_path: "solve.jl", lab_id: "lab-1" });
    writeFileSync(spec, specBody);
    const r = run(["estimate", "--spec", spec], { AMICO_LOCAL_RAM_BYTES: "1024" }); // suggestion fires
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.offloadSuggested).toBe(true);
    expect("executor" in out).toBe(false); // a suggestion signal, never a routing decision
    expect(readFileSync(spec, "utf8")).toBe(specBody); // spec untouched on disk
    rmSync(dir, { recursive: true, force: true });
  });

  it("invalid spec (schema) → 64 with the schema reason", () => {
    const dir = tmp();
    const spec = join(dir, "spec.json");
    writeFileSync(spec, JSON.stringify({ schema_version: "2", script_path: "s.jl" })); // lab_id missing
    const r = run(["estimate", "--spec", spec]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/solvespec schema/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("script with no N → 64 naming what could not be extracted", () => {
    const dir = tmp();
    const script = join(dir, "solve.jl");
    writeFileSync(script, "levels = [2, 2]\n");
    const r = run(["estimate", script]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/could not extract N/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("unresolvable levels → estimate still returned (reference fallback) + stderr warning", () => {
    const dir = tmp();
    const script = join(dir, "solve.jl");
    writeFileSync(script, "N = 300\nlevels = fill(2, mystery)\n");
    // spawnSync (not execFileSync): the warning lands on stderr of a SUCCESS exit.
    const r = spawnSync("node", [BUNDLE, "estimate", script], {
      encoding: "utf8",
      env: { ...process.env, AMICO_LOCAL_RAM_BYTES: String(1024 ** 4) },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.score).toBe(300); // reference: unresolvable levels contribute nothing
    expect(out.sizeClass).toBe("SMALL");
    expect(out.inputs.levels).toBeUndefined();
    expect(r.stderr).toMatch(/mystery/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing script / missing spec / no args / both forms → 64 one-liners", () => {
    const dir = tmp();
    expect(run(["estimate"]).code).toBe(64);
    expect(run(["estimate", join(dir, "nope.jl")]).code).toBe(64);
    expect(run(["estimate", "--spec", join(dir, "nope.json")]).code).toBe(64);
    writeFileSync(join(dir, "s.jl"), "N = 1\n");
    writeFileSync(join(dir, "spec.json"), "{}");
    const both = run(["estimate", join(dir, "s.jl"), "--spec", join(dir, "spec.json")]);
    expect(both.code).toBe(64);
    rmSync(dir, { recursive: true, force: true });
  });

  it("invalid AMICO_LOCAL_RAM_BYTES → 64 naming the variable", () => {
    const dir = tmp();
    const script = join(dir, "solve.jl");
    writeFileSync(script, SCRIPT_MEDIUM);
    const r = run(["estimate", script], { AMICO_LOCAL_RAM_BYTES: "lots" });
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/AMICO_LOCAL_RAM_BYTES/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a bare script literally named `estimate` still launches (dispatch checks the file exists)", () => {
    // Same guard as resolve/sandbox: trySubcommand must NOT swallow an existing file.
    // Needs cwd=dir so argv[0] is the literal `estimate` that exists on disk.
    const dir = tmp();
    writeFileSync(join(dir, "estimate"), "N = 1\n");
    let code = 0;
    let stderr = "";
    try {
      execFileSync("node", [BUNDLE, "estimate", "--runs-root", join(dir, "runs"), "--julia", join(dir, "no-julia")], {
        encoding: "utf8",
        cwd: dir,
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      code = err.status ?? -1;
      stderr = err.stderr ?? "";
    }
    // The launch path fails on the missing julia binary — NOT with the estimate
    // subcommand's usage/extract errors, which proves dispatch skipped it.
    expect(code).not.toBe(0);
    expect(stderr).not.toMatch(/amico-run estimate:/);
    rmSync(dir, { recursive: true, force: true });
  });
});


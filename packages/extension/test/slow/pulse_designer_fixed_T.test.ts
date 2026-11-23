import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// #613: the vetted pulse-designer template promises the user's gate time T (the
// interview asks for it in ns). `timesteps_all_equal = true` gave a uniform mesh
// with a FREE duration scale (Piccolo.jl#317 · DirectTrajOpt.jl#145), so the
// solved pulse could come back longer or shorter than T. This runs the real
// template on a tiny grid and asserts the solved trajectory's duration is T.
// Gated on a real Julia project with Piccolo ≥ 2.2 (the template's own probe).
const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const TEMPLATE = join(__dirname, "..", "..", "scores", "pulse-designer", "templates", "solve.jl");

const T_NS = 10.0;

// Shrink only the FILL-IN knobs that set cost (N, max_iter); T stays the default.
function tinyTemplate(): string {
  const src = readFileSync(TEMPLATE, "utf8");
  const out = src
    .replace(/^N\s*=\s*\d+/m, "N          = 11")
    .replace(/^max_iter\s*=\s*\d+/m, "max_iter   = 15")
    .replace(/^T\s*=\s*[\d.]+/m, `T          = ${T_NS}`);
  expect(out).toMatch(/^N {10}= 11/m);
  expect(out).toMatch(/^max_iter {3}= 15/m);
  return out;
}

const READ_DURATION = String.raw`
using Piccolo, JLD2
traj = JLD2.load(ARGS[1], "traj")
println("DURATION=", get_duration(traj))
`;

describe.skipIf(!PROJECT)("slow: pulse-designer template fixes the gate time T (#613)", () => {
  it("solved trajectory duration equals T within tolerance", () => {
    const dir = mkdtempSync(join(tmpdir(), "pd-fixed-T-"));
    writeFileSync(join(dir, "solve.jl"), tinyTemplate());
    writeFileSync(join(dir, "read_duration.jl"), READ_DURATION);
    execFileSync("julia", [`--project=${PROJECT}`, "solve.jl"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 900_000,
      stdio: ["ignore", "pipe", "inherit"],
    });
    expect(existsSync(join(dir, "pulse.jld2"))).toBe(true);
    const out = execFileSync("julia", [`--project=${PROJECT}`, "read_duration.jl", join(dir, "pulse.jld2")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 600_000,
    });
    const duration = Number(out.match(/DURATION=(\S+)/)![1]);
    expect(Math.abs(duration - T_NS)).toBeLessThan(1e-6 * T_NS);
  }, 1_200_000);
});

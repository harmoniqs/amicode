import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";

const PROJECT = process.env.AMICO_TEST_JULIA_PROJECT;
const RUN = join(__dirname, "..", "..", "..", "amico-run", "dist", "amico-run.js"); // β.1 bundle
const TEMPLATE = join(__dirname, "..", "..", "templates", "solve_template.jl");

describe.skipIf(!PROJECT)("slow: solve_template.jl through amico-run (β.3 AC)", () => {
  it("unmodified template → FINISHED{completed} + pulse + iter PNG + AMICODE_ITER", () => {
    const root = mkdtempSync(join(tmpdir(), "tmpl-vet-"));
    const stdout = execFileSync(
      "node",
      [RUN, TEMPLATE, "--runs-root", join(root, "runs"), "--project", PROJECT!, "--lab", "devlab"],
      { encoding: "utf8", timeout: 600_000 },
    );
    expect(stdout).toMatch(/AMICODE_ITER iter=/);
    expect(stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=/); // mirror β.1
    const runDir = stdout.match(/AMICODE_FINISHED .*runDir=(.+)/)![1].trim(); // anchored capture
    expect(parse(readFileSync(join(runDir, "FINISHED"), "utf8")).status).toBe("completed");
    expect(existsSync(join(runDir, "pulse.jld2"))).toBe(true);
    expect(readdirSync(runDir).some((f) => /^iter_\d+\.png$/.test(f))).toBe(true);
    const r = parse(readFileSync(join(runDir, "result.toml"), "utf8")) as Record<string, unknown>;
    expect(r.fidelity as number).toBeGreaterThan(0.99);
  }, 600_000);
});

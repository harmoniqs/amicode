import { describe, it, expect, beforeAll } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";
import { readSolverMode, solverModeFile } from "../src/solver_mode.js";

// Piccolissimo + Altissimo is a cloud-only tier. These tests pin the two halves
// of that guarantee: the reader that decides which solver is selected, and the
// launch refusal that makes "cloud-only" true rather than merely advertised.

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

/** An ops dir carrying a solver-mode.json with the given raw contents. */
function opsDirWith(root: string, contents: string): string {
  const dir = join(root, "ops");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "solver-mode.json"), contents);
  return dir;
}

describe("readSolverMode", () => {
  it("reads hp when the extension wrote hp", () => {
    const dir = opsDirWith(tmpRoot(), JSON.stringify({ mode: "hp", status: "ready" }));
    expect(readSolverMode({ AMICODE_OPS_DIR: dir })).toBe("hp");
  });

  it("reads piccolo when the extension wrote piccolo", () => {
    const dir = opsDirWith(tmpRoot(), JSON.stringify({ mode: "piccolo", status: "ready" }));
    expect(readSolverMode({ AMICODE_OPS_DIR: dir })).toBe("piccolo");
  });

  // Fail-safe direction matters: this value can only REFUSE a local run, so a
  // bad read must never invent "hp" and block ordinary free-tier work. A missing
  // file is the normal state on a fresh install.
  it("absent / corrupt / mode-less file → piccolo, never a throw", () => {
    expect(readSolverMode({ AMICODE_OPS_DIR: join(tmpRoot(), "nope") })).toBe("piccolo");
    expect(readSolverMode({ AMICODE_OPS_DIR: opsDirWith(tmpRoot(), "{ not json") })).toBe("piccolo");
    expect(readSolverMode({ AMICODE_OPS_DIR: opsDirWith(tmpRoot(), "{}") })).toBe("piccolo");
    expect(readSolverMode({ AMICODE_OPS_DIR: opsDirWith(tmpRoot(), '{"mode":"HP"}') })).toBe("piccolo");
  });

  it("resolves $AMICODE_OPS_DIR → ~/.amico/amicode, matching the extension's writer", () => {
    expect(solverModeFile({ AMICODE_OPS_DIR: "/tmp/ops" })).toBe(join("/tmp/ops", "solver-mode.json"));
    expect(solverModeFile({})).toMatch(/\.amico[/\\]amicode[/\\]solver-mode\.json$/);
    // an empty value is not a directory — fall back rather than resolve to "/"
    expect(solverModeFile({ AMICODE_OPS_DIR: "  " })).toMatch(/\.amico[/\\]amicode[/\\]/);
  });
});

describe("Piccolissimo + Altissimo never solves locally", () => {
  // The bug: selecting HP grants the `issimo` entitlement, so the import scan
  // admits a local `using Piccolissimo` and the laptop precompiles the whole HP
  // stack (IPOPT included) until amico-run's process-group timeout SIGTERMs it
  // mid-precompile. Refusing the launch is the durable fix.
  it("refuses a local launch and exits 64", () => {
    const root = tmpRoot();
    const ops = opsDirWith(root, JSON.stringify({ mode: "hp", status: "ready" }));
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run([script, "--runs-root", join(root, "runs"), "--julia", julia], { AMICODE_OPS_DIR: ops });
    expect(r.code).toBe(64);
    expect(r.stderr).toContain("Harmoniqs Cloud");
    expect(r.stderr).toMatch(/never solves locally/);
    // it must name the way out, in both directions
    expect(r.stderr).toMatch(/--executor remote/);
    expect(r.stderr).toMatch(/switch the solver to Piccolo/);
  });

  // The refusal has to cover a bare `amico-run script.jl` too: runGate only sees
  // --spec runs, so a gate-only check would leave the commonest path open.
  it("refuses even with no --spec (the gate never runs on that path)", () => {
    const root = tmpRoot();
    const ops = opsDirWith(root, JSON.stringify({ mode: "hp", status: "ready" }));
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run([script, "--runs-root", join(root, "runs"), "--julia", julia], { AMICODE_OPS_DIR: ops });
    expect(r.code).toBe(64);
    // and it dies BEFORE any run dir exists — no half-run to clean up
    expect(r.stdout).not.toContain("AMICODE_FINISHED");
  });

  // A remote HP launch is exactly what we want to PERMIT, so prove the refusal
  // stays out of its way and the run completes. Against FakeCloud, never the
  // real one: pointed at a live cloud this test would submit a real solve and
  // then poll it (it did, once, before AMICO_CLOUD_URL was pinned here).
  // FakeCloud runs in THIS process, so the async execFile pattern is mandatory —
  // execFileSync would block the event loop and deadlock the fake.
  it("does not touch a remote launch — that is the whole point", async () => {
    const fake = new FakeCloud();
    await fake.start();
    fake.state = {
      task_status: "Running",
      liveness: "alive",
      iters: [{ iter: 1, f: "1.0e-2", inf_pr: "1e-8", inf_du: "1e-6" }],
      finished: { status: "completed" },
    };
    try {
      const root = tmpRoot();
      const ops = opsDirWith(root, JSON.stringify({ mode: "hp", status: "ready" }));
      const script = fakeJulia(root, "s.jl", "");
      const r = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveP) => {
        let stdout = "";
        let stderr = "";
        const child = execFile("node", [BUNDLE, script, "--executor", "remote", "--runs-root", join(root, "runs")], {
          env: { ...process.env, AMICODE_OPS_DIR: ops, AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: fake.token },
        });
        child.stdout!.on("data", (d: string) => {
          stdout += d;
        });
        child.stderr!.on("data", (d: string) => {
          stderr += d;
        });
        child.on("exit", (c) => resolveP({ code: c ?? -1, stdout, stderr }));
      });
      expect(r.stderr).not.toMatch(/never solves locally/);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0/);
    } finally {
      await fake.stop();
    }
  }, 15000);

  it("piccolo mode is byte-identical to before — a local run still runs", () => {
    const root = tmpRoot();
    const ops = opsDirWith(root, JSON.stringify({ mode: "piccolo", status: "ready" }));
    const julia = fakeJulia(root, "j", `console.log('AMICODE_ITER iter=1 f=0.5'); console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run([script, "--runs-root", join(root, "runs"), "--julia", julia], { AMICODE_OPS_DIR: ops });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/never solves locally/);
  });

  it("no solver-mode.json at all → local runs work (fresh install)", () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run([script, "--runs-root", join(root, "runs"), "--julia", julia], {
      AMICODE_OPS_DIR: join(root, "absent-ops"),
    });
    expect(r.code).toBe(0);
  });
});

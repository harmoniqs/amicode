// #2045 D — `amico run --adopt <runDir>`: an orchestrator that takes a PREPARED run (manifest,
// solvespec, problem.toml already on disk), skips the gate / warrant / solver-mode checks and
// run-dir creation, runs it, does free-tier verification itself and prints NO protocol lines.
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeJulia, readToml, tmpRoot } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";
import { readRunLock } from "../src/run_lock.js";
import { buildBundle, cliEnv, runCli, spawnCli } from "./launch_harness.js";
import type { SubmitOpts } from "../src/types.js";

beforeAll(buildBundle);

function prepare(root: string, juliaBody: string, extra: Partial<SubmitOpts> = {}) {
  const julia = fakeJulia(root, "j", juliaBody);
  const prepared = new LocalExecutor().prepareRun(fakeJulia(root, "s.jl", ""), {
    runsRoot: join(root, "runs"),
    julia: { julia },
    ...extra,
  });
  return prepared;
}

describe("adopt mode (#2045 D)", () => {
  it("runs a prepared run to completion: FINISHED, run.log, lock, no AMICODE_* lines, exit 0", async () => {
    const root = tmpRoot();
    const p = prepare(root, `console.log('AMICODE_ITER iter=1 f=0.5'); console.log('DONE f=0.99')`);
    const r = await runCli(["run", "--adopt", p.runDir], cliEnv());
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/AMICODE_(FINISHED|VERIFIED)/);
    expect(readToml(join(p.runDir, "FINISHED"))).toEqual({ status: "completed", exit_code: 0 });
    expect(await import("node:fs").then((fs) => fs.readFileSync(join(p.runDir, "run.log"), "utf8"))).toContain("DONE f=0.99");
    expect(readRunLock(p.runDir)).toMatchObject({ run_id: p.runId, protection: "none", unit: null, ended: true });
  }, 30000);

  it("--unit records protection unit in the lock", async () => {
    const root = tmpRoot();
    const p = prepare(root, `process.exit(0)`);
    const r = await runCli(["run", "--adopt", p.runDir, "--unit", "amico-run-test-abc.service"], cliEnv());
    expect(r.code).toBe(0);
    expect(readRunLock(p.runDir)).toMatchObject({ protection: "unit", unit: "amico-run-test-abc.service" });
  }, 30000);

  it("failed run maps to the launcher's exit code", async () => {
    const root = tmpRoot();
    const p = prepare(root, `process.exit(7)`);
    const r = await runCli(["run", "--adopt", p.runDir], cliEnv());
    expect(r.code).toBe(7);
    expect(readToml(join(p.runDir, "FINISHED"))).toEqual({ status: "failed", exit_code: 7 });
  }, 30000);

  it("SIGTERM aborts the run (this is how `stop` works): FINISHED aborted, exit 130", async () => {
    const root = tmpRoot();
    const p = prepare(root, `console.log('READY'); setInterval(() => {}, 1000)`);
    const proc = spawnCli(["run", "--adopt", p.runDir], cliEnv());
    // adopt prints nothing, so wait on the run log instead
    await waitForFile(join(p.runDir, "run.log"), "READY");
    proc.child.kill("SIGTERM");
    const r = await proc.result;
    expect(r.code).toBe(130);
    expect(readToml(join(p.runDir, "FINISHED")).status).toBe("aborted");
    expect(readRunLock(p.runDir)!.ended).toBe(true);
  }, 30000);

  it("skips the gate and warrant: an armed warrant context with an empty ledger does not refuse an adoption", async () => {
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    const julia = fakeJulia(root, "j", `console.log('ok')`);
    const spec = { schema_version: "2", script_path: script, lab_id: "default", tier: "vetted", plan_hash: "sha256:nope" };
    writeFileSync(join(root, "ledger.jsonl"), "");
    const p = new LocalExecutor().prepareRun(script, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec: { canonical: JSON.stringify(spec), tier: "vetted", hashes: { spec_hash: "sha256:1" } },
    });
    const r = await runCli(["run", "--adopt", p.runDir], cliEnv({ AMICO_WARRANTS: "1", AMICO_LEDGER: join(root, "ledger.jsonl") }));
    expect(r.code).toBe(0);
    expect(readToml(join(p.runDir, "FINISHED")).status).toBe("completed");
  }, 30000);

  it("free tier: adopt runs the verification itself; the final verification.toml is not pending", async () => {
    const root = tmpRoot();
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    const harness = fakeJulia(
      root,
      "h.js",
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[process.argv.length-2],'verification.toml'),'schema_version = "1"\\nagree = true\\n')`,
    );
    writeFileSync(
      join(root, "authoring.json"),
      JSON.stringify({ schema_version: 1, allowlist: ["Piccolo"], support_set: [], verify_harness: harness, verify_tolerance: 0.01 }),
    );
    const script = fakeJulia(root, "s.jl", "");
    const spec = { schema_version: "2", script_path: script, lab_id: "default", tier: "free", env: { kind: "sandbox", project: env } };
    const p = new LocalExecutor().prepareRun(script, {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", `console.log('DONE f=0.99')`), project: env },
      spec: { canonical: JSON.stringify(spec), tier: "free", hashes: { spec_hash: "sha256:2" } },
    });
    const r = await runCli(["run", "--adopt", p.runDir], cliEnv({ AMICO_AUTHORING_FILE: join(root, "authoring.json"), AMICO_VERIFY_RUNNER: harness }));
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/AMICODE_VERIFIED/);
    const v = readToml(join(p.runDir, "verification.toml"));
    expect(v.agree).toBe(true);
    expect(v.pending).toBeUndefined();
  }, 30000);

  it("a v4 problem_spec run is adopted through the typed-spec runner", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('ARGS ' + process.argv.slice(2).join(' '))`);
    const spec = { schema_version: "4", lab_id: "default", tier: "vetted", problem_spec: { system: { template: "X" } } };
    const p = new LocalExecutor().prepareRun(undefined, {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec: { canonical: JSON.stringify(spec), tier: "vetted", hashes: { spec_hash: "sha256:3" }, problem_spec: spec.problem_spec },
    });
    const r = await runCli(["run", "--adopt", p.runDir], cliEnv());
    expect(r.code).toBe(0);
    const log = await import("node:fs").then((fs) => fs.readFileSync(join(p.runDir, "run.log"), "utf8"));
    expect(log).toContain("Piccolo.Specs.solve_spec");
    expect(log).toContain(join(p.runDir, "problem.toml"));
  }, 30000);

  it("refuses: missing dir, already-finished run, run already owned by a live orchestrator", async () => {
    const root = tmpRoot();
    const missing = await runCli(["run", "--adopt", join(root, "nope")], cliEnv());
    expect(missing.code).toBe(64);
    expect(missing.stderr).toMatch(/adopt/);

    const done = prepare(root, `process.exit(0)`);
    expect((await runCli(["run", "--adopt", done.runDir], cliEnv())).code).toBe(0);
    const again = await runCli(["run", "--adopt", done.runDir], cliEnv());
    expect(again.code).toBe(64);
    expect(again.stderr).toMatch(/already finished/);

    const live = prepare(root, `console.log('READY'); setInterval(() => {}, 1000)`);
    const first = spawnCli(["run", "--adopt", live.runDir], cliEnv());
    await waitForFile(join(live.runDir, "run.log"), "READY");
    const second = await runCli(["run", "--adopt", live.runDir], cliEnv());
    expect(second.code).toBe(64);
    expect(second.stderr).toMatch(/already (owned|running)/);
    first.child.kill("SIGTERM");
    await first.result;
    expect(existsSync(join(live.runDir, "FINISHED"))).toBe(true);
  }, 40000);

  it("not a run dir (no manifest) → 64", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "d"));
    const r = await runCli(["run", "--adopt", join(root, "d")], cliEnv());
    expect(r.code).toBe(64);
  });
});

async function waitForFile(file: string, needle: string, ms = 20000): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (readFileSync(file, "utf8").includes(needle)) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${needle} in ${file}`);
}

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeJulia, hermeticOpsEnv, readToml, tmpRoot } from "./helpers.js";
import { FakeCloud } from "./fake_cloud.js";

const BUNDLE = join(__dirname, "..", "dist", "amico-run.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BUNDLE, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...hermeticOpsEnv(), ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("amico-run CLI", () => {
  it("clean solve: relays iter lines, prints AMICODE_FINISHED, exits 0", () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('AMICODE_ITER iter=1 f=0.5'); console.log('DONE f=0.99')`);
    const script = fakeJulia(root, "s.jl", "");
    const r = run([script, "--runs-root", join(root, "runs"), "--julia", julia]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("AMICODE_ITER iter=1 f=0.5");
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=.+/);
  });
  it("julia rc 7 passes through as exit 7", () => {
    const root = tmpRoot();
    const r = run([
      fakeJulia(root, "s.jl", ""),
      "--runs-root",
      join(root, "runs"),
      "--julia",
      fakeJulia(root, "j", "process.exit(7)"),
    ]);
    expect(r.code).toBe(7);
    expect(r.stdout).toContain("status=failed exitCode=7");
  });
  it("missing script → 64, stderr one-liner, no run dir", () => {
    const root = tmpRoot();
    const r = run([join(root, "nope.jl"), "--runs-root", join(root, "runs")]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/script not found/);
  });
  it("unknown flag → 64 (never silently swallowed, spec Q68)", () => {
    const root = tmpRoot();
    const r = run([fakeJulia(root, "s.jl", ""), "--gates", "X"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/unknown flag/);
  });
  it("--executor remote without cloud config → 64 (config-class), no run dir", () => {
    const root = tmpRoot();
    const r = run([fakeJulia(root, "s.jl", ""), "--executor", "remote", "--runs-root", join(root, "runs")], {
      AMICO_CLOUD_FILE: join(root, "no-such-cloud.json"), // hermetic: ignore any real ~/.amico/cloud.json
      AMICO_CLOUD_URL: "",
      AMICO_CLOUD_TOKEN: "",
    });
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/cloud config/);
    expect(existsSync(join(root, "runs"))).toBe(false);
  });

  it("--executor bogus → 64 naming the supported set", () => {
    const root = tmpRoot();
    const r = run([fakeJulia(root, "s.jl", ""), "--executor", "bogus"]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/local, remote/);
  });

  it("--spec + --executor remote: the launch gate still runs (junk spec dies in the GATE, not a remote reject)", () => {
    // High-Performance + Cloud path: --spec + remote is ACCEPTED (the gate is a
    // static local check). A junk spec must die in the GATE with the gate's
    // message, NOT a blanket 'not supported' reject.
    const root = tmpRoot();
    writeFileSync(join(root, "spec.json"), "{}");
    const r = run(
      [fakeJulia(root, "s.jl", ""), "--executor", "remote", "--spec", join(root, "spec.json")],
      { AMICO_CLOUD_URL: "http://127.0.0.1:1", AMICO_CLOUD_TOKEN: "t" },
    );
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/gate:/);
    expect(r.stderr).not.toMatch(/not supported/);
  });

  it("--executor remote full lane through the bundle (fake cloud): iter relay + AMICODE_FINISHED, exit 0", async () => {
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
      const script = fakeJulia(root, "s.jl", "");
      // ASYNC lane (the SIGTERM-test pattern, cli.test.ts:191-196) — NEVER the
      // sync run() helper here: FakeCloud runs IN this test process, and
      // execFileSync would block the event loop, so the fake could never answer
      // the child CLI's HTTP requests (deadlock until undici's timeout).
      const r = await new Promise<{ code: number; stdout: string }>((resolveP) => {
        let stdout = "";
        const child = execFile(
          "node",
          [BUNDLE, script, "--executor", "remote", "--runs-root", join(root, "runs")],
          { env: { ...process.env, ...hermeticOpsEnv(), AMICO_CLOUD_URL: fake.base, AMICO_CLOUD_TOKEN: fake.token } },
        );
        child.stdout!.on("data", (d: string) => {
          stdout += d;
        });
        child.on("exit", (c) => resolveP({ code: c ?? -1, stdout }));
      });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("AMICODE_ITER iter=1 f=1.0e-2");
      expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 runDir=.+/);
    } finally {
      await fake.stop();
    }
  }, 15000);
  it("--spec: gate failure → 64, one-line stderr reason, NO run dir (spec C)", () => {
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    writeFileSync(join(root, "bad.json"), JSON.stringify({ nope: true }));
    const r = run([
      script,
      "--runs-root",
      join(root, "runs"),
      "--spec",
      join(root, "bad.json"),
      "--julia",
      fakeJulia(root, "j", ""),
    ]);
    expect(r.code).toBe(64);
    expect(r.stderr).toMatch(/solvespec schema/);
    expect(existsSync(join(root, "runs"))).toBe(false);
  });
  it("--spec pass: solvespec.json persisted canonical + run.toml v2 stamped (spec C)", () => {
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    const spec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      executor: "local",
      tier: "vetted",
      hashes: { system_hash: "sha256:ab" },
    };
    writeFileSync(join(root, "spec.json"), JSON.stringify(spec));
    const r = run([
      script,
      "--runs-root",
      join(root, "runs"),
      "--spec",
      join(root, "spec.json"),
      "--julia",
      fakeJulia(root, "j", `console.log('DONE f=0.99')`),
    ]);
    expect(r.code).toBe(0);
    const match = /runDir=(\S+)/.exec(r.stdout);
    expect(match).toBeTruthy();
    const runDir = match![1];
    const persisted = JSON.parse(readFileSync(join(runDir, "solvespec.json"), "utf8"));
    expect(persisted).toMatchObject({ tier: "vetted", lab_id: "default" });
    const manifest = readToml(join(runDir, "run.toml"));
    expect(manifest.schema_version).toBe("2");
    expect(manifest.tier).toBe("vetted");
    expect((manifest.hashes as Record<string, unknown>).system_hash).toBe("sha256:ab");
    expect((manifest.hashes as Record<string, unknown>).spec_hash).toMatch(/^sha256:/);
  });
  it("--spec env.kind=project sets the julia --project arg from env.project (spec C)", () => {
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "Project.toml"), `[deps]\n`);
    writeFileSync(join(env, "Manifest.toml"), `julia_version = "1.11.0"\n`);
    const spec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      tier: "vetted",
      env: { kind: "project", project: env },
    };
    writeFileSync(join(root, "spec.json"), JSON.stringify(spec));
    const julia = fakeJulia(root, "j", `console.log('ARGS ' + process.argv.slice(2).join(' '))`);
    const r = run([script, "--runs-root", join(root, "runs"), "--spec", join(root, "spec.json"), "--julia", julia]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`--project=${env}`);
  });
  it("--spec tier=free: verification runs after FINISHED (AMICODE_VERIFIED + verification.toml); vetted: neither (spec C)", () => {
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "Project.toml"), `[deps]\n`);
    writeFileSync(join(env, "Manifest.toml"), `julia_version = "1.11.0"\n`);
    // fake harness (node) that writes agree=true; wired as the julia binary so
    // runVerification spawns it (AMICO_VERIFY_RUNNER unset → spec.julia_binary)
    const harness = fakeJulia(
      root,
      "h.js",
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[process.argv.length-2],'verification.toml'),'schema_version = "1"\\nagree = true\\n')`,
    );
    writeFileSync(
      join(root, "authoring.json"),
      JSON.stringify({
        schema_version: 1,
        allowlist: ["Piccolo"],
        support_set: ["JLD2", "TOML"],
        verify_harness: harness,
        verify_tolerance: 0.01,
      }),
    );
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const AUTH = { AMICO_AUTHORING_FILE: join(root, "authoring.json"), AMICO_VERIFY_RUNNER: harness };

    const freeSpec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      tier: "free",
      env: { kind: "sandbox", project: env },
    };
    writeFileSync(join(root, "free.json"), JSON.stringify(freeSpec));
    const rFree = run(
      [script, "--runs-root", join(root, "runs"), "--spec", join(root, "free.json"), "--julia", julia],
      AUTH,
    );
    expect(rFree.code).toBe(0);
    expect(rFree.stdout).toMatch(/AMICODE_VERIFIED agree=true/);
    const freeDir = /runDir=(\S+)/.exec(rFree.stdout)![1];
    expect(existsSync(join(freeDir, "verification.toml"))).toBe(true);

    const vetSpec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      tier: "vetted",
      env: { kind: "provisioned" },
    };
    writeFileSync(join(root, "vet.json"), JSON.stringify(vetSpec));
    const rVet = run(
      [script, "--runs-root", join(root, "runs2"), "--spec", join(root, "vet.json"), "--julia", julia],
      AUTH,
    );
    expect(rVet.stdout).not.toMatch(/AMICODE_VERIFIED/);
    const vetDir = /runDir=(\S+)/.exec(rVet.stdout)![1];
    expect(existsSync(join(vetDir, "verification.toml"))).toBe(false);
  });
  it("REGRESSION (hpc tier added): a free/Piccolo local solve runs unchanged with NO cloud key", () => {
    // Guards the design promise "Piccolo works like before": the hpc tier +
    // remote executor + gate rule must not touch the free/local path. This spec
    // has no cloud config in scope (env pair cleared, cloud.json pointed at a
    // nonexistent file) — a local free solve must still complete, exit 0.
    const root = tmpRoot();
    const script = fakeJulia(root, "s.jl", "");
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "Project.toml"), `[deps]\n`);
    writeFileSync(join(env, "Manifest.toml"), `julia_version = "1.11.0"\n`);
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const freeSpec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      tier: "free",
      executor: "local",
      env: { kind: "sandbox", project: env },
    };
    writeFileSync(join(root, "free.json"), JSON.stringify(freeSpec));
    const r = run(
      [script, "--runs-root", join(root, "runs"), "--spec", join(root, "free.json"), "--julia", julia],
      { AMICO_CLOUD_FILE: join(root, "no-such-cloud.json"), AMICO_CLOUD_URL: "", AMICO_CLOUD_TOKEN: "" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0/);
  });
  it("SIGTERM to the CLI → abort lane, exit 130", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('READY'); setInterval(() => {}, 1000)`);
    const script = fakeJulia(root, "s.jl", "");
    const code: number = await new Promise((resolveP) => {
      const child = execFile("node", [BUNDLE, script, "--runs-root", join(root, "runs"), "--julia", julia], {
        env: { ...process.env, ...hermeticOpsEnv() },
      });
      child.stdout!.on("data", (d: string) => {
        if (d.includes("READY")) child.kill("SIGTERM");
      });
      child.on("exit", (c) => resolveP(c ?? -1));
    });
    expect(code).toBe(130);
  }, 15000);
});

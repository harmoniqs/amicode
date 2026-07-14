import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpRoot, fakeJulia, readToml } from "./helpers.js";
import { maskedHash } from "../src/baseline.js";

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
  it("--executor remote → 64 (only local in β)", () => {
    const root = tmpRoot();
    const r = run([fakeJulia(root, "s.jl", ""), "--executor", "remote"]);
    expect(r.code).toBe(64);
  });
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
  it("--spec tier=composed: verification runs too (spec-20260708-112732 §4.3 tier-2 extension)", () => {
    const root = tmpRoot();
    // exemplar with the template's default fill-point markers
    const exemplar = `using Piccolo\nusing JLD2, TOML\n# ── FILL IN ──────\nT = 10.0\n# ─────────────────\nsolve()\n`;
    const index = join(root, "exemplars.json");
    writeFileSync(
      index,
      JSON.stringify({
        schema_version: 1,
        exemplars: [
          {
            id: "ex-cz",
            platform: "rydberg",
            kind: "gate_synthesis",
            size: 2,
            path: "ex-cz/script.jl",
            packages: ["Piccolo", "JLD2", "TOML"],
            baseline_hash: maskedHash(exemplar),
          },
        ],
      }),
    );
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
        exemplars: index,
        verify_harness: harness,
        verify_tolerance: 0.01,
      }),
    );
    // authored script: an inside-fill-point edit → passes the masked-baseline gate
    const script = fakeJulia(root, "s.jl", "");
    writeFileSync(script, exemplar.replace("T = 10.0", "T = 25.0"));
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const spec = {
      schema_version: "2",
      script_path: script,
      lab_id: "default",
      executor: "local",
      tier: "composed",
      env: { kind: "provisioned" },
      source: { exemplar_id: "ex-cz" },
    };
    writeFileSync(join(root, "composed.json"), JSON.stringify(spec));
    const r = run([script, "--runs-root", join(root, "runs"), "--spec", join(root, "composed.json"), "--julia", julia], {
      AMICO_AUTHORING_FILE: join(root, "authoring.json"),
      AMICO_VERIFY_RUNNER: harness,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/AMICODE_VERIFIED agree=true/);
    const dir = /runDir=(\S+)/.exec(r.stdout)![1];
    expect(existsSync(join(dir, "verification.toml"))).toBe(true);
  });
  it("SIGTERM to the CLI → abort lane, exit 130", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('READY'); setInterval(() => {}, 1000)`);
    const script = fakeJulia(root, "s.jl", "");
    const code: number = await new Promise((resolveP) => {
      const child = execFile("node", [BUNDLE, script, "--runs-root", join(root, "runs"), "--julia", julia]);
      child.stdout!.on("data", (d: string) => {
        if (d.includes("READY")) child.kill("SIGTERM");
      });
      child.on("exit", (c) => resolveP(c ?? -1));
    });
    expect(code).toBe(130);
  }, 15000);
});

// #2045 B — goldens for the launcher's client-visible contract: stdout lines and exit
// code of `amico run` on a completed, a failed, an aborted and a verification-disagrees
// run. Captured from the PRE-CHANGE launcher and kept byte-identical through the
// prepare/start refactor and the thin-client placement work.
// Regenerate deliberately with UPDATE_GOLDEN=1 (never to make a failing run pass).
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeJulia, tmpRoot } from "./helpers.js";
import { buildBundle, cliEnv, normalize, runCli, spawnCli } from "./launch_harness.js";

const GOLDEN = join(__dirname, "fixtures", "launch-golden");
beforeAll(buildBundle);

function expectGolden(name: string, stdout: string, code: number): void {
  const out = join(GOLDEN, `${name}.stdout`);
  const rc = join(GOLDEN, `${name}.code`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(out, stdout);
    writeFileSync(rc, `${code}\n`);
  }
  expect(existsSync(out), `golden ${name} missing — run with UPDATE_GOLDEN=1`).toBe(true);
  expect(stdout).toBe(readFileSync(out, "utf8"));
  expect(code).toBe(Number(readFileSync(rc, "utf8").trim()));
}

// stdout/stderr readers are separate streams: space the lines so their order is fixed.
const CLEAN = `
console.log('AMICODE_ITER iter=1 f=1.0e-2');
setTimeout(() => { console.error('warn: a stderr line'); }, 150);
setTimeout(() => { console.log('plain log line'); console.log('AMICODE_ITER iter=2 f=3.0e-4'); console.log('DONE fidelity=0.9999'); }, 350);
`;

describe("launcher goldens (#2045 B)", () => {
  it("completed run", async () => {
    const root = tmpRoot();
    const r = await runCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", fakeJulia(root, "j", CLEAN)],
      cliEnv(),
    );
    expectGolden("completed", normalize(r.stdout, root), r.code);
  }, 30000);

  it("failed run (julia exits 7)", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('AMICODE_ITER iter=1 f=0.5'); setTimeout(() => process.exit(7), 150)`);
    const r = await runCli(["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", julia], cliEnv());
    expectGolden("failed", normalize(r.stdout, root), r.code);
  }, 30000);

  it("aborted run (client SIGINT)", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('READY'); setInterval(() => {}, 1000)`);
    const p = spawnCli(["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", julia], cliEnv());
    await p.waitFor("READY");
    p.child.kill("SIGINT");
    const r = await p.result;
    expectGolden("aborted", normalize(r.stdout, root), r.code);
  }, 30000);

  it("free tier, verification disagrees", async () => {
    const root = tmpRoot();
    const env = join(root, "env");
    mkdirSync(env, { recursive: true });
    writeFileSync(join(env, "Project.toml"), `[deps]\n`);
    writeFileSync(join(env, "Manifest.toml"), `julia_version = "1.11.0"\n`);
    const harness = fakeJulia(
      root,
      "h.js",
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[process.argv.length-2],'verification.toml'),'schema_version = "1"\\nagree = false\\n')`,
    );
    writeFileSync(
      join(root, "authoring.json"),
      JSON.stringify({ schema_version: 1, allowlist: ["Piccolo"], support_set: ["JLD2", "TOML"], verify_harness: harness, verify_tolerance: 0.01 }),
    );
    const script = fakeJulia(root, "s.jl", "");
    writeFileSync(
      join(root, "free.json"),
      JSON.stringify({ schema_version: "2", script_path: script, lab_id: "default", tier: "free", env: { kind: "sandbox", project: env } }),
    );
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.99')`);
    const r = await runCli(
      ["run", script, "--runs-root", join(root, "runs"), "--spec", join(root, "free.json"), "--julia", julia],
      cliEnv({ AMICO_AUTHORING_FILE: join(root, "authoring.json"), AMICO_VERIFY_RUNNER: harness }),
    );
    expectGolden("verify-disagree", normalize(r.stdout, root), r.code);
  }, 30000);
});

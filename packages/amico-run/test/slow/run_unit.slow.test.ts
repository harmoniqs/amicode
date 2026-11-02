// #2045 — the REAL systemd placer, end to end, and the restart drill.
//
// Needs a working user service manager AND lingering; otherwise the whole file is skipped
// LOUDLY (console.warn below + the skipped suite name says why).
//
// SAFETY: only transient units named `amico-run-test-*` are ever created, stopped or queried
// here (AMICO_RUN_UNIT_PREFIX=amico-run-test-). The "engine" being restarted is a throwaway
// `amico-run-test-engine-*` unit — never a hub unit. Every unit this file creates is stopped in
// afterAll and its absence is asserted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fakeJulia, readToml, tmpRoot } from "../helpers.js";
import { allowlistEnv, probeUserUnits } from "../../src/placement.js";
import { readRunLock } from "../../src/run_lock.js";
import {
  BUNDLE,
  buildBundle,
  cliEnv,
  killStragglers,
  letItFinish,
  normalize,
  onlyRunDir,
  runCli,
  runIdOf,
  sleep,
  spawnCli,
  waitUntil,
  waitingJuliaBody,
} from "../launch_harness.js";

const PREFIX = "amico-run-test-";
const env0 = { ...process.env, AMICO_RUN_UNIT_PREFIX: PREFIX };
const probe = probeUserUnits(env0);
if (!probe.ok) console.warn(`SKIPPED run_unit.slow tests — real systemd placement unavailable: ${probe.reason}`);

const created = new Set<string>();
const readdirSyncRuns = (runs: string): string[] =>
  readdirSync(runs).filter((e) => /^r\d{8}-/.test(e)).map((e) => join(runs, e));
const systemctl = (...args: string[]) =>
  spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", env: env0 });
const unitState = (unit: string): string => systemctl("is-active", unit).stdout.trim();

function placedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return cliEnv({ AMICO_RUN_PLACEMENT: "auto", AMICO_RUN_UNIT_PREFIX: PREFIX, AMICO_RUN_HEARTBEAT_MS: "200", ...extra });
}

beforeAll(buildBundle);
afterAll(() => {
  for (const u of created) systemctl("stop", u);
  const left = systemctl("list-units", `${PREFIX}*`, "--all", "--plain", "--no-legend").stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((u) => u && created.has(u));
  // collected units vanish from the list; anything still listed as active is a leak
  const active = left.filter((u) => unitState(u) === "active");
  expect(active).toEqual([]);
});

describe.skipIf(!probe.ok)("real systemd placement", () => {
  it("client output and exit code are byte-identical to the pre-change launcher (completed + failed goldens)", async () => {
    const golden = (name: string): string => readFileSync(join(__dirname, "..", "fixtures", "launch-golden", `${name}.stdout`), "utf8");
    const code = (name: string): number => Number(readFileSync(join(__dirname, "..", "fixtures", "launch-golden", `${name}.code`), "utf8"));
    const root = tmpRoot();
    const CLEAN = `
console.log('AMICODE_ITER iter=1 f=1.0e-2');
setTimeout(() => { console.error('warn: a stderr line'); }, 150);
setTimeout(() => { console.log('plain log line'); console.log('AMICODE_ITER iter=2 f=3.0e-4'); console.log('DONE fidelity=0.9999'); }, 350);
`;
    const ok = await runCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", fakeJulia(root, "j", CLEAN)],
      placedEnv(),
    );
    expect(normalize(ok.stdout, root)).toBe(golden("completed"));
    expect(ok.code).toBe(code("completed"));
    const bad = await runCli(
      [
        "run", fakeJulia(root, "s2.jl", ""), "--runs-root", join(root, "runs"), "--julia",
        fakeJulia(root, "j2", `console.log('AMICODE_ITER iter=1 f=0.5'); setTimeout(() => process.exit(7), 150)`),
      ],
      placedEnv(),
    );
    expect(normalize(bad.stdout, root)).toBe(golden("failed"));
    expect(bad.code).toBe(code("failed"));
    const units = readdirSyncRuns(join(root, "runs")).map((d) => readRunLock(d)?.unit);
    expect(units.every((u) => u?.startsWith(PREFIX))).toBe(true);
    for (const u of units) if (u) created.add(u);
  }, 90000);

  it("runs the solve in its own unit outside this cgroup, with an allowlisted environment; client detach leaves it running; `stop` aborts it", async () => {
    const root = tmpRoot();
    const runs = join(root, "runs");
    const args = ["run", fakeJulia(root, "s.jl", ""), "--runs-root", runs, "--julia", fakeJulia(root, "j", waitingJuliaBody(root))];
    const secret = `SLOW_TEST_SECRET_${randomBytes(3).toString("hex")}`;
    const client = spawnCli(args, placedEnv({ [secret]: "must-not-leak", AMICO_RUN_PASS_ENV: "SLOW_TEST_PASSED", SLOW_TEST_PASSED: "yes" }));
    try {
      await client.waitFor("READY");
      const dir = await onlyRunDir(runs);
      await waitUntil("lock", () => readRunLock(dir) !== undefined);
      const lock = readRunLock(dir)!;
      expect(lock.protection).toBe("unit");
      expect(lock.unit).toBe(`${PREFIX}${runIdOf(dir)}.service`);
      created.add(lock.unit!);
      expect(unitState(lock.unit!)).toBe("active");

      // outside the invoking process's cgroup (and so outside any engine unit's)
      const mine = readFileSync("/proc/self/cgroup", "utf8").trim().split(":").at(-1)!;
      const theirs = systemctl("show", "-p", "ControlGroup", "--value", lock.unit!).stdout.trim();
      expect(theirs).not.toBe("");
      expect(theirs.startsWith(mine)).toBe(false);
      expect(theirs).not.toContain("co.harmoniqs.amicode-server");

      // environment allowlist, as the manager recorded it
      const environment = systemctl("show", "-p", "Environment", "--value", lock.unit!).stdout;
      expect(environment).toContain("PATH=");
      expect(environment).toContain("SLOW_TEST_PASSED=yes");
      expect(environment).not.toContain(secret);
      expect(environment).not.toContain("BUN_INSPECT");

      // detach: the unit keeps the solve
      client.child.kill("SIGTERM");
      expect((await client.result).code).toBe(143);
      await sleep(500);
      expect(unitState(lock.unit!)).toBe("active");
      expect(existsSync(join(dir, "FINISHED"))).toBe(false);

      // explicit stop ends it, aborted, FINISHED written, unit gone
      const stop = await runCli(["run", "stop", runIdOf(dir), "--runs-root", runs], placedEnv());
      expect(stop.code).toBe(0);
      expect(readToml(join(dir, "FINISHED")).status).toBe("aborted");
      await waitUntil("unit gone", () => unitState(lock.unit!) !== "active", 40000);
    } finally {
      letItFinish(root);
      killStragglers(root);
    }
  }, 120000);

  it("restart drill: the engine's unit is stopped mid-solve; the solve unit survives, finishes, and a fresh client reports it finished WITH its verification", async () => {
    const root = tmpRoot();
    const runs = join(root, "runs");
    const projectEnv = join(root, "env");
    mkdirSync(projectEnv, { recursive: true });
    writeFileSync(join(projectEnv, "Project.toml"), `[deps]\n`);
    writeFileSync(join(projectEnv, "Manifest.toml"), `julia_version = "1.11.0"\n`);
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
    writeFileSync(
      join(root, "free.json"),
      JSON.stringify({ schema_version: "2", script_path: script, lab_id: "default", tier: "free", env: { kind: "sandbox", project: projectEnv } }),
    );
    const julia = fakeJulia(root, "j", waitingJuliaBody(root));
    const authEnv = { AMICO_AUTHORING_FILE: join(root, "authoring.json"), AMICO_VERIFY_RUNNER: harness };

    // the throwaway "engine": a unit whose cgroup holds the invoking client, like a hub unit would
    const engine = `${PREFIX}engine-${randomBytes(3).toString("hex")}.service`;
    created.add(engine);
    const clientEnv = { ...allowlistEnv(placedEnv(authEnv)), AMICO_RUN_PLACEMENT: "auto", AMICO_RUN_UNIT_PREFIX: PREFIX };
    const started = spawnSync(
      "systemd-run",
      [
        "--user", "--quiet", "--collect", `--unit=${engine}`, "--property=KillMode=control-group",
        ...Object.entries(clientEnv).map(([k, v]) => `--setenv=${k}=${v}`),
        process.execPath, BUNDLE, "run", script, "--runs-root", runs, "--julia", julia, "--spec", join(root, "free.json"),
      ],
      { encoding: "utf8", env: env0 },
    );
    expect(started.status, started.stderr).toBe(0);

    let dir = "";
    try {
      dir = await onlyRunDir(runs);
      await waitUntil("lock", () => readRunLock(dir) !== undefined, 40000);
      const lock = readRunLock(dir)!;
      expect(lock.protection).toBe("unit");
      created.add(lock.unit!);
      await waitUntil("julia up", () => existsSync(join(root, "julia.pid")));

      // restart the engine: its whole cgroup dies, including the thin client
      expect(systemctl("stop", engine).status).toBe(0);
      expect(unitState(engine)).not.toBe("active");

      // the solve unit and its julia are untouched
      await sleep(600);
      expect(unitState(lock.unit!)).toBe("active");
      expect(() => process.kill(Number(readFileSync(join(root, "julia.pid"), "utf8")), 0)).not.toThrow();
      expect(existsSync(join(dir, "FINISHED"))).toBe(false);

      letItFinish(root);
      await waitUntil("FINISHED", () => existsSync(join(dir, "FINISHED")), 40000);
      expect(readToml(join(dir, "FINISHED"))).toEqual({ status: "completed", exit_code: 0 });

      // a NEW engine's client attaches: finished, with its verification
      const attach = await runCli(["run", "attach", runIdOf(dir), "--runs-root", runs], placedEnv(authEnv));
      expect(attach.code).toBe(0);
      expect(attach.stdout).toContain("AMICODE_VERIFIED agree=true");
      expect(attach.stdout).toMatch(/AMICODE_FINISHED status=completed exitCode=0 /);
      const v = readToml(join(dir, "verification.toml"));
      expect(v.agree).toBe(true);
      expect(v.pending).toBeUndefined();
      await waitUntil("solve unit gone", () => unitState(lock.unit!) !== "active", 40000);
    } finally {
      letItFinish(root);
      killStragglers(root, dir || undefined);
    }
  }, 180000);
});

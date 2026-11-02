// #2045 E/F/G — placement, the thin client, stop/attach, the duplicate-spec guard.
// Real processes throughout: the bundled CLI, a real detached adopt orchestrator
// (AMICO_RUN_PLACEMENT=setsid-test — the same adopt command a unit would run, same env
// allowlist, no user service manager), real fake-julia children. The real systemd placer
// is covered by test/slow/run_unit.slow.test.ts.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fakeJulia, readToml, tmpRoot } from "./helpers.js";
import {
  buildBundle,
  cliEnv,
  fileHas,
  killStragglers,
  letItFinish,
  normalize,
  onlyRunDir,
  runCli,
  runIdOf,
  sleep,
  spawnCli,
  waitingJuliaBody,
  waitUntil,
} from "./launch_harness.js";
import { allowlistEnv, UNPROTECTED_WARNING } from "../src/placement.js";
import { readRunLock } from "../src/run_lock.js";

beforeAll(buildBundle);

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const PLACED = { AMICO_RUN_PLACEMENT: "setsid-test", AMICO_RUN_HEARTBEAT_MS: "100", AMICO_RUN_STALE_MS: "1500" };

/** root with a runs dir and a julia that waits for `go`; registers cleanup of its processes. */
function world() {
  const root = tmpRoot();
  const runs = join(root, "runs");
  const julia = fakeJulia(root, "j", waitingJuliaBody(root));
  const script = fakeJulia(root, "s.jl", "");
  const args = ["run", script, "--runs-root", runs, "--julia", julia];
  cleanups.push(() => {
    letItFinish(root);
    killStragglers(root, existsSync(runs) ? safeOnly(runs) : undefined);
  });
  return { root, runs, julia, script, args };
}
function safeOnly(runs: string): string | undefined {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(runs)
      .filter((e) => /^r\d{8}-/.test(e))
      .map((e) => join(runs, e))[0];
  } catch {
    return undefined;
  }
}

describe("env allowlist (#2045 E.3)", () => {
  it("passes the documented names and prefixes, nothing credential-shaped, never BUN_INSPECT", () => {
    const out = allowlistEnv({
      PATH: "/bin",
      HOME: "/h",
      USER: "u",
      LANG: "C",
      JULIA_DEPOT_PATH: "/d",
      AMICO_LAB: "x",
      AMICODE_OPS_DIR: "/o",
      XDG_RUNTIME_DIR: "/r",
      SSL_CERT_FILE: "/c",
      LD_LIBRARY_PATH: "/l",
      AMICODE_ENGINE_INSPECT: "9229",
      BUN_INSPECT: "127.0.0.1:9230",
      AMICO_CLOUD_TOKEN: "t",
      ANTHROPIC_API_KEY: "k",
      GITHUB_TOKEN: "g",
      SECRET_THING: "s",
      MY_EXTRA: "keep",
      MULTI: "a\nb",
      AMICO_RUN_PASS_ENV: "MY_EXTRA, GITHUB_TOKEN",
    });
    expect(Object.keys(out).sort()).toEqual(
      [
        "AMICODE_OPS_DIR",
        "AMICO_LAB",
        "AMICO_RUN_PASS_ENV",
        "GITHUB_TOKEN", // named explicitly in AMICO_RUN_PASS_ENV
        "HOME",
        "JULIA_DEPOT_PATH",
        "LANG",
        "LD_LIBRARY_PATH",
        "MY_EXTRA",
        "PATH",
        "SSL_CERT_FILE",
        "USER",
        "XDG_RUNTIME_DIR",
      ].sort(),
    );
  });

  it("end to end: a secret in the client env never reaches the placed orchestrator's julia", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", `console.log('ENV ' + JSON.stringify(Object.keys(process.env)))`);
    const r = await runCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", julia],
      cliEnv({ ...PLACED, TOTALLY_PRIVATE_SECRET: "hunter2", AMICO_FAKE_TOKEN: "t0k", MY_PASSED: "yes", AMICO_RUN_PASS_ENV: "MY_PASSED", BUN_INSPECT: "127.0.0.1:1" }),
    );
    expect(r.code).toBe(0);
    const keys = JSON.parse(/^ENV (.*)$/m.exec(r.stdout)![1]) as string[];
    expect(keys).toContain("PATH");
    expect(keys).toContain("MY_PASSED");
    expect(keys).not.toContain("TOTALLY_PRIVATE_SECRET");
    expect(keys).not.toContain("AMICO_FAKE_TOKEN");
    expect(keys).not.toContain("BUN_INSPECT");
  }, 30000);
});

describe("placement ladder (#2045 E.1/E.2)", () => {
  it("AMICO_RUN_PLACEMENT=none runs in-process, silently, with protection none in the lock", async () => {
    const root = tmpRoot();
    const r = await runCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", fakeJulia(root, "j", "process.exit(0)")],
      cliEnv({ AMICO_RUN_PLACEMENT: "none" }),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const dir = await onlyRunDir(join(root, "runs"));
    expect(readRunLock(dir)).toMatchObject({ protection: "none", unit: null, ended: true });
  }, 30000);

  it("no user service manager → protection none and the NOT-protected line on stderr, stdout unchanged", async () => {
    const root = tmpRoot();
    const nodeDir = dirname(process.execPath);
    // a PATH with node but without systemd-run/loginctl: the probe cannot succeed
    const env = cliEnv({ AMICO_RUN_PLACEMENT: "auto", PATH: nodeDir, AMICO_RUN_UNIT_PREFIX: "amico-run-test-" });
    const r = await runCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", fakeJulia(root, "j", `console.log('DONE f=0.5')`)],
      env,
    );
    // only meaningful if this node dir really has no systemd-run
    if (existsSync(join(nodeDir, "systemd-run"))) return;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(UNPROTECTED_WARNING);
    expect(normalize(r.stdout, root)).toBe("DONE f=0.5\nAMICODE_FINISHED status=completed exitCode=0 runDir=<ROOT>/runs/<RUNID>\n");
    const dir = await onlyRunDir(join(root, "runs"));
    expect(readRunLock(dir)).toMatchObject({ protection: "none", unit: null });
  }, 30000);
});

describe("thin client signals (#2045 E.6)", () => {
  it("SIGTERM to the client DETACHES: exit 143, message names the stop command, the run keeps going and finishes", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    p.child.kill("SIGTERM");
    const r = await p.result;
    expect(r.code).toBe(143);
    expect(r.stderr).toContain(`detached; run ${runIdOf(dir)} continues — stop it with: amico run stop ${runIdOf(dir)}`);
    expect(r.stdout).not.toContain("AMICODE_FINISHED");
    // the solve is alive and unfinished…
    expect(existsSync(join(dir, "FINISHED"))).toBe(false);
    expect(readRunLock(dir)!.ended).toBe(false);
    // …and finishes when told to, with nobody attached
    letItFinish(w.root);
    await waitUntil("FINISHED", () => existsSync(join(dir, "FINISHED")));
    expect(readToml(join(dir, "FINISHED"))).toEqual({ status: "completed", exit_code: 0 });
    expect(fileHas(join(dir, "run.log"), "DONE f=0.99")).toBe(true);
  }, 40000);

  it("SIGHUP to the client detaches too: exit 129", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    p.child.kill("SIGHUP");
    const r = await p.result;
    expect(r.code).toBe(129);
    expect(r.stderr).toContain("detached");
    expect(existsSync(join(dir, "FINISHED"))).toBe(false);
    letItFinish(w.root);
    await waitUntil("FINISHED", () => existsSync(join(dir, "FINISHED")));
  }, 40000);

  it("SIGINT stops the run (old Ctrl-C semantics): aborted, exit 130, protocol lines printed", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    p.child.kill("SIGINT");
    const r = await p.result;
    expect(r.code).toBe(130);
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=aborted exitCode=143 /);
    expect(readToml(join(dir, "FINISHED")).status).toBe("aborted");
  }, 40000);

  it("a client killed with SIGKILL leaves the run alone (survival)", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    p.child.kill("SIGKILL");
    await p.result;
    await sleep(500);
    expect(existsSync(join(dir, "FINISHED"))).toBe(false);
    letItFinish(w.root);
    await waitUntil("FINISHED", () => existsSync(join(dir, "FINISHED")));
    expect(readToml(join(dir, "FINISHED")).status).toBe("completed");
  }, 40000);

  it("kill -9 the orchestrator: the lock goes stale, no FINISHED, and a client reports DEAD (exit 69)", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    const lock = readRunLock(dir)!;
    process.kill(lock.pid, "SIGKILL");
    const r = await p.result;
    expect(r.code).toBe(69);
    expect(r.stderr).toMatch(/is DEAD/);
    expect(existsSync(join(dir, "FINISHED"))).toBe(false);
    const after = readRunLock(dir)!;
    expect(after.ended).toBe(false);
    // the heartbeat has stopped: it does not advance any more
    const beat = after.heartbeat_at;
    await sleep(400);
    expect(readRunLock(dir)!.heartbeat_at).toBe(beat);
  }, 40000);
});

describe("stop / attach (#2045 F)", () => {
  it("`stop <id>` ends the run: aborted, FINISHED written; a second stop is idempotent (exit 0)", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    const id = runIdOf(dir);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    const stop = await runCli(["run", "stop", id, "--runs-root", w.runs], cliEnv(PLACED));
    expect(stop.code).toBe(0);
    expect(readToml(join(dir, "FINISHED")).status).toBe("aborted");
    const r = await p.result; // the attached client sees the abort
    expect(r.code).toBe(130);
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=aborted/);
    const again = await runCli(["run", "stop", id, "--runs-root", w.runs], cliEnv(PLACED));
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/already finished/);
  }, 40000);

  it("the flag form --stop <id> works the same", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv(PLACED));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    const stop = await runCli(["run", "--stop", dir, "--runs-root", w.runs], cliEnv(PLACED));
    expect(stop.code).toBe(0);
    expect(readToml(join(dir, "FINISHED")).status).toBe("aborted");
    await p.result;
  }, 40000);

  it("stops an in-process (protection none) run by signalling its verified orchestrator", async () => {
    const w = world();
    const p = spawnCli(w.args, cliEnv({ AMICO_RUN_PLACEMENT: "none" }));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    const stop = await runCli(["run", "stop", runIdOf(dir), "--runs-root", w.runs], cliEnv({ AMICO_RUN_PLACEMENT: "none" }));
    expect(stop.code).toBe(0);
    const r = await p.result;
    expect(r.code).toBe(130);
    expect(readToml(join(dir, "FINISHED")).status).toBe("aborted");
  }, 40000);

  it("refuses to signal a pid that is not the run's orchestrator", async () => {
    const w = world();
    const bystander = spawn("sleep", ["60"], { stdio: "ignore" });
    cleanups.push(() => bystander.kill("SIGKILL"));
    const p = spawnCli(w.args, cliEnv({ AMICO_RUN_PLACEMENT: "none" }));
    await p.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    // forge the lock so it points at the bystander (a recycled pid, as far as stop can tell)
    const lock = readRunLock(dir)!;
    const orchestratorPid = lock.pid;
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ ...lock, pid: bystander.pid }));
    const stop = await runCli(["run", "stop", runIdOf(dir), "--runs-root", w.runs], cliEnv());
    expect(stop.code).toBe(1);
    expect(stop.stderr).toMatch(/not the orchestrator/);
    expect(() => process.kill(bystander.pid!, 0)).not.toThrow();
    // un-forge so the real orchestrator can be stopped cleanly
    process.kill(orchestratorPid, "SIGTERM");
    await p.result;
  }, 40000);

  it("a script literally named `stop` still launches (subcommand form needs a run id as the next arg)", async () => {
    const root = tmpRoot();
    const cwd = join(root, "cwd");
    mkdirSync(cwd);
    writeFileSync(join(cwd, "stop"), "");
    const julia = fakeJulia(root, "j", `console.log('DONE f=0.5')`);
    const r = await new Promise<{ code: number; stdout: string }>((res) => {
      let stdout = "";
      const c = spawn("node", [join(__dirname, "..", "dist", "amico.js"), "run", "stop", "--runs-root", join(root, "runs"), "--julia", julia], {
        cwd,
        env: cliEnv(),
      });
      c.stdout.on("data", (d) => (stdout += d));
      c.on("close", (code) => res({ code: code ?? -1, stdout }));
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/AMICODE_FINISHED status=completed/);
  }, 30000);

  it("`attach <id>` tails the log from the beginning and finishes like the launcher", async () => {
    const w = world();
    const first = spawnCli(w.args, cliEnv(PLACED));
    await first.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    first.child.kill("SIGTERM"); // detach
    await first.result;
    const att = spawnCli(["run", "attach", runIdOf(dir), "--runs-root", w.runs], cliEnv(PLACED));
    await att.waitFor("READY"); // replayed from the beginning
    letItFinish(w.root);
    const r = await att.result;
    expect(r.code).toBe(0);
    expect(normalize(r.stdout, w.root)).toBe("READY\nDONE f=0.99\nAMICODE_FINISHED status=completed exitCode=0 runDir=<ROOT>/runs/<RUNID>\n");
  }, 40000);

  it("stop of an unknown run is a clean 64", async () => {
    const root = tmpRoot();
    const r = await runCli(["run", "--stop", "r20260101-000000Z-abcd", "--runs-root", join(root, "runs")], cliEnv());
    expect(r.code).toBe(64);
  });
});

describe("duplicate-spec guard (#2045 G)", () => {
  function specWorld(extra: Record<string, unknown> = {}) {
    const w = world();
    const spec = { schema_version: "2", script_path: w.script, lab_id: "default", tier: "vetted", ...extra };
    const specFile = join(w.root, `spec-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(specFile, JSON.stringify(spec));
    return { ...w, specFile, specArgs: [...w.args, "--spec", specFile] };
  }

  it("a second launch of an identical spec while the first is live is refused (64) and creates no run dir", async () => {
    const w = specWorld();
    const first = spawnCli(w.specArgs, cliEnv(PLACED));
    await first.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    const second = await runCli(w.specArgs, cliEnv(PLACED));
    expect(second.code).toBe(64);
    expect(second.stderr).toContain(`run ${runIdOf(dir)} is already live for this exact spec`);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(w.runs).filter((e) => /^r\d/.test(e))).toHaveLength(1);
    first.child.kill("SIGTERM");
    await first.result;
    letItFinish(w.root);
    await waitUntil("FINISHED", () => existsSync(join(dir, "FINISHED")));
  }, 40000);

  it("a deliberate re-run is allowed once no live lock holds the spec", async () => {
    const w = specWorld();
    letItFinish(w.root); // runs finish immediately
    const a = await runCli(w.specArgs, cliEnv(PLACED));
    expect(a.code).toBe(0);
    const b = await runCli(w.specArgs, cliEnv(PLACED));
    expect(b.code).toBe(0);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(w.runs).filter((e) => /^r\d/.test(e))).toHaveLength(2);
  }, 40000);

  it("a DEAD run's stale lock does not block a re-run", async () => {
    const w = specWorld();
    const first = spawnCli(w.specArgs, cliEnv(PLACED));
    await first.waitFor("READY");
    const dir = await onlyRunDir(w.runs);
    await waitUntil("lock", () => readRunLock(dir) !== undefined);
    process.kill(readRunLock(dir)!.pid, "SIGKILL");
    await first.result; // DEAD
    // make the heartbeat unambiguously older than the guard's 90 s window
    const lock = readRunLock(dir)!;
    writeFileSync(join(dir, "run.lock"), JSON.stringify({ ...lock, heartbeat_at: new Date(Date.now() - 300_000).toISOString() }));
    letItFinish(w.root);
    const again = await runCli(w.specArgs, cliEnv(PLACED));
    expect(again.code).toBe(0);
  }, 40000);

  it("a different spec runs concurrently; bare runs are never refused", async () => {
    const w = specWorld();
    const other = join(w.root, "other.json");
    writeFileSync(other, JSON.stringify({ schema_version: "2", script_path: w.script, lab_id: "default", tier: "vetted", hashes: { system_hash: "sha256:other" } }));
    const first = spawnCli(w.specArgs, cliEnv(PLACED));
    await first.waitFor("READY");
    letItFinish(w.root);
    // (go exists now, so these finish immediately; the point is they are not refused)
    const diff = await runCli([...w.args, "--spec", other], cliEnv(PLACED));
    expect(diff.code).toBe(0);
    const bare = await runCli(w.args, cliEnv(PLACED));
    expect(bare.code).toBe(0);
    await first.result;
  }, 40000);
});

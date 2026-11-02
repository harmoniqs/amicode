// #2045 H — a launch that stays in the engine's cgroup holds slice A0's per-unit restart lock
// SHARED from "decide placement" until the child exists, so ops/hub/solve-guard.sh's exclusive
// check→recheck→restart can never interleave with it.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeJulia, tmpRoot } from "./helpers.js";
import { buildBundle, cliEnv, sleep, spawnCli } from "./launch_harness.js";
import { holdRestartLock, hubUnitFromCgroup } from "../src/restart_lock.js";

beforeAll(buildBundle);
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const HUB_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-co.harmoniqs.amicode\\x2dserver.slice/co.harmoniqs.amicode-server@2.service\n";
const HUB_CGROUP_CHILD = HUB_CGROUP.trimEnd() + "/tool-call-17.scope\n";
const EXCLUSIVE_HELD = (lock: string): boolean => spawnSync("flock", ["-x", "-n", lock, "true"]).status !== 0;

describe("hubUnitFromCgroup", () => {
  it("finds the hub unit from its own cgroup and from a child scope below it", () => {
    expect(hubUnitFromCgroup(HUB_CGROUP)).toBe("co.harmoniqs.amicode-server@2.service");
    expect(hubUnitFromCgroup(HUB_CGROUP_CHILD)).toBe("co.harmoniqs.amicode-server@2.service");
    expect(hubUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/co.harmoniqs.amicode-server.service\n")).toBe(
      "co.harmoniqs.amicode-server.service",
    );
  });
  it("is undefined outside a hub unit", () => {
    expect(hubUnitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeUndefined();
    expect(hubUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/amico-run-r1.service\n")).toBeUndefined();
    expect(hubUnitFromCgroup("")).toBeUndefined();
  });
});

describe("holdRestartLock", () => {
  it("is a no-op outside a hub unit (no lock file created)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-"));
    const lock = await holdRestartLock({ env: { SOLVE_GUARD_LOCK_DIR: dir }, cgroup: "0::/user.slice/session-1.scope\n" });
    lock.release();
    expect(existsSync(join(dir, "co.harmoniqs.amicode-server@2.service.lock"))).toBe(false);
  });

  it("holds the per-unit lock SHARED: a restart's exclusive lock is refused while held, granted after release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-"));
    const file = join(dir, "co.harmoniqs.amicode-server@2.service.lock");
    const lock = await holdRestartLock({ env: { SOLVE_GUARD_LOCK_DIR: dir }, cgroup: HUB_CGROUP_CHILD });
    expect(existsSync(file)).toBe(true);
    expect(EXCLUSIVE_HELD(file)).toBe(true);
    // another shared holder (a second concurrent launch) is not blocked
    const other = await holdRestartLock({ env: { SOLVE_GUARD_LOCK_DIR: dir }, cgroup: HUB_CGROUP });
    lock.release();
    expect(EXCLUSIVE_HELD(file)).toBe(true); // still held by `other`
    other.release();
    await sleep(150);
    expect(EXCLUSIVE_HELD(file)).toBe(false);
  });

  it("waits while a restart holds the lock exclusive, then proceeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rl-"));
    const file = join(dir, "co.harmoniqs.amicode-server@2.service.lock");
    const restart = spawn("flock", ["-x", file, "sleep", "1.5"], { stdio: "ignore" });
    cleanups.push(() => restart.kill("SIGKILL"));
    await sleep(300); // let it take the lock
    const t0 = Date.now();
    const lock = await holdRestartLock({ env: { SOLVE_GUARD_LOCK_DIR: dir }, cgroup: HUB_CGROUP });
    const waited = Date.now() - t0;
    lock.release();
    expect(waited).toBeGreaterThan(900);
  }, 15000);
});

// The launcher takes the lock for real when it runs inside a hub unit (as the hub's own agents
// do). Elsewhere there is nothing to hold — say so loudly instead of passing silently.
const inHubUnit = (() => {
  try {
    return hubUnitFromCgroup(readFileSync("/proc/self/cgroup", "utf8")) !== undefined;
  } catch {
    return false;
  }
})();
if (!inHubUnit) console.warn("SKIPPED launch-takes-the-restart-lock test: this process is not inside a hub unit's cgroup");

describe.skipIf(!inHubUnit)("launcher integration", () => {
  it("a none-placement launch waits for an in-flight exclusive restart check before it spawns julia", async () => {
    const lockDir = mkdtempSync(join(tmpdir(), "rl-"));
    const unit = hubUnitFromCgroup(readFileSync("/proc/self/cgroup", "utf8"))!;
    const file = join(lockDir, `${unit}.lock`);
    const restart = spawn("flock", ["-x", file, "sleep", "1.5"], { stdio: "ignore" });
    cleanups.push(() => restart.kill("SIGKILL"));
    await sleep(300);

    const root = tmpRoot();
    const t0 = Date.now();
    const p = spawnCli(
      ["run", fakeJulia(root, "s.jl", ""), "--runs-root", join(root, "runs"), "--julia", fakeJulia(root, "j", `console.log('SPAWNED ' + Date.now())`)],
      cliEnv({ AMICO_RUN_PLACEMENT: "none", SOLVE_GUARD_LOCK_DIR: lockDir }),
    );
    const r = await p.result;
    expect(r.code).toBe(0);
    const spawnedAt = Number(/SPAWNED (\d+)/.exec(r.stdout)![1]);
    // julia only appeared after the restart's exclusive hold ended (~1.2 s after t0)
    expect(spawnedAt - t0).toBeGreaterThan(900);
    // …and the lock is released once the child exists
    expect(EXCLUSIVE_HELD(file)).toBe(false);
  }, 30000);
});

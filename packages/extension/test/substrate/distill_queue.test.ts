import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  enqueueJob,
  listJobs,
  queueIsEmpty,
  claimLock,
  releaseLock,
  reclaimIfStale,
  drainOnce,
  runDrainLoop,
} from "../../opencode-plugin/distill_queue";

function mkOps(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amicode-ops-"));
}

describe("queue basics", () => {
  it("enqueueJob writes a json file the drain can list in order", () => {
    const ops = mkOps();
    const p1 = enqueueJob(ops, { kind: "run", run_id: "r1" });
    const p2 = enqueueJob(ops, { kind: "sweep" });
    expect(fs.existsSync(p1)).toBe(true);
    const jobs = listJobs(ops);
    expect(jobs.length).toBe(2);
    expect(JSON.parse(fs.readFileSync(jobs[0], "utf8")).kind).toBe("run");
    expect(queueIsEmpty(ops)).toBe(false);
    expect(p1).not.toBe(p2); // same-ms enqueues must not collide
  });
  it("empty/missing queue dir → empty", () => {
    expect(listJobs(mkOps())).toEqual([]);
    expect(queueIsEmpty(mkOps())).toBe(true);
  });
});

describe("global lock (spec §4.1: mkdir primitive)", () => {
  it("first claim wins, second fails EEXIST-style", () => {
    const ops = mkOps();
    expect(claimLock(ops, 111)).toBe(true);
    expect(claimLock(ops, 222)).toBe(false);
    releaseLock(ops);
    expect(claimLock(ops, 222)).toBe(true);
  });
  it("owner file records pid + timestamp", () => {
    const ops = mkOps();
    claimLock(ops, 4242);
    const owner = JSON.parse(fs.readFileSync(path.join(ops, "distiller.lock", "owner"), "utf8"));
    expect(owner.pid).toBe(4242);
    expect(typeof owner.ts).toBe("number");
  });
});

describe("stale reclaim (spec §4.1: rename-aside, never remove-then-mkdir)", () => {
  const MIN15 = 15 * 60 * 1000;
  it("fresh lock or live pid → no reclaim", () => {
    const ops = mkOps();
    claimLock(ops, 111);
    expect(reclaimIfStale(ops, 999, { now: Date.now(), isPidAlive: () => true })).toBe(false);
    expect(reclaimIfStale(ops, 999, { now: Date.now() + MIN15 + 1, isPidAlive: () => true })).toBe(false);
  });
  it("stale + dead pid → rename aside, then fresh claim succeeds", () => {
    const ops = mkOps();
    claimLock(ops, 111);
    const later = Date.now() + MIN15 + 1000;
    expect(reclaimIfStale(ops, 999, { now: later, isPidAlive: () => false })).toBe(true);
    const owner = JSON.parse(fs.readFileSync(path.join(ops, "distiller.lock", "owner"), "utf8"));
    expect(owner.pid).toBe(999);
    // the stale dir was renamed aside, not destroyed
    const aside = fs.readdirSync(ops).filter((f) => f.startsWith("distiller.lock.stale-"));
    expect(aside.length).toBe(1);
  });
  it("second reclaimer loses: rename source vanished → false, and it must NOT destroy the winner's fresh lock", () => {
    const ops = mkOps();
    claimLock(ops, 111);
    const later = Date.now() + MIN15 + 1000;
    expect(reclaimIfStale(ops, 888, { now: later, isPidAlive: () => false })).toBe(true);
    // loser arrives with the same (stale) observation; the original dir is gone
    expect(reclaimIfStale(ops, 999, { now: later, isPidAlive: () => true })).toBe(false);
    const owner = JSON.parse(fs.readFileSync(path.join(ops, "distiller.lock", "owner"), "utf8"));
    expect(owner.pid).toBe(888); // winner's lock intact
  });
});

describe("drain (spec §4.1: sequential, keep-on-failure, post-release re-check)", () => {
  it("drainOnce processes jobs in order and removes them only after the handler resolves", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "a" });
    enqueueJob(ops, { kind: "run", run_id: "b" });
    const seen: string[] = [];
    const n = await drainOnce(ops, async (job) => {
      seen.push(job.run_id);
    });
    expect(n).toBe(2);
    expect(seen).toEqual(["a", "b"]);
    expect(queueIsEmpty(ops)).toBe(true);
  });
  it("a failing job is set aside as .failed, not retried forever, and does not stop the drain", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "bad" });
    enqueueJob(ops, { kind: "run", run_id: "good" });
    const seen: string[] = [];
    await drainOnce(ops, async (job) => {
      if (job.run_id === "bad") throw new Error("boom");
      seen.push(job.run_id);
    });
    expect(seen).toEqual(["good"]);
    expect(queueIsEmpty(ops)).toBe(true);
    const failed = fs.readdirSync(path.join(ops, "distill-queue")).filter((f) => f.includes(".failed-"));
    expect(failed.length).toBe(1);
  });
  it("runDrainLoop: a job enqueued mid-drain is picked up via the post-release re-check", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "first" });
    const seen: string[] = [];
    let injected = false;
    await runDrainLoop(
      ops,
      async (job) => {
        seen.push(job.run_id);
        if (!injected) {
          injected = true;
          enqueueJob(ops, { kind: "run", run_id: "late" }); // lands during the drain
        }
      },
      { pid: 42, now: () => Date.now(), isPidAlive: () => true },
    );
    expect(seen).toEqual(["first", "late"]);
    expect(queueIsEmpty(ops)).toBe(true);
    expect(claimLock(ops, 7)).toBe(true); // lock was released at the end
  });
  it("runDrainLoop exits immediately as a loser when the lock is held", async () => {
    const ops = mkOps();
    claimLock(ops, 111);
    enqueueJob(ops, { kind: "run", run_id: "x" });
    const seen: string[] = [];
    const ran = await runDrainLoop(ops, async (j) => void seen.push(j.run_id), {
      pid: 42,
      now: () => Date.now(),
      isPidAlive: () => true,
    });
    expect(ran).toBe(false);
    expect(seen).toEqual([]);
    expect(queueIsEmpty(ops)).toBe(false); // job left for the holder
  });
});

describe("distiller spawn transport (config file + headless child)", () => {
  function fakeBinary(dir: string): string {
    const bin = path.join(dir, "fake-opencode");
    fs.writeFileSync(
      bin,
      `#!/bin/sh\nprintf '%s\\n' "$4" > "${dir}/captured-job"\nprintf '%s\\n' "$OPENCODE_CONFIG_CONTENT" > "${dir}/captured-env"\necho done\n`,
    );
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  it("write/read round-trip; missing/garbage → null", async () => {
    const ops = mkOps();
    const { writeDistillerConfig, readDistillerConfig } = await import("../../opencode-plugin/distill_queue");
    expect(readDistillerConfig(ops)).toBeNull();
    writeDistillerConfig(ops, { binary: "/x/opencode", config: { agent: {} } });
    expect(readDistillerConfig(ops)!.binary).toBe("/x/opencode");
  });
  it("runDistillerJob spawns `run --agent distiller <job>` with the config env", async () => {
    const ops = mkOps();
    const { runDistillerJob } = await import("../../opencode-plugin/distill_queue");
    const bin = fakeBinary(ops);
    const res = await runDistillerJob({ binary: bin, config: { marker: 42 } }, { kind: "run", run_id: "rX" });
    expect(res.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(ops, "captured-job"), "utf8")).run_id).toBe("rX");
    expect(JSON.parse(fs.readFileSync(path.join(ops, "captured-env"), "utf8")).marker).toBe(42);
  });
  it("enqueueAndDrain without a transport config leaves the job queued (no throw)", async () => {
    const ops = mkOps();
    const { enqueueAndDrain, defaultClock } = await import("../../opencode-plugin/distill_queue");
    const ran = await enqueueAndDrain(ops, { kind: "sweep" }, defaultClock());
    expect(ran).toBe(false);
    expect(queueIsEmpty(ops)).toBe(false);
  });
  it("enqueueAndDrain with a transport config drains through the child", async () => {
    const ops = mkOps();
    const { enqueueAndDrain, defaultClock, writeDistillerConfig } = await import("../../opencode-plugin/distill_queue");
    writeDistillerConfig(ops, { binary: fakeBinary(ops), config: { m: 1 } });
    const ran = await enqueueAndDrain(ops, { kind: "run", run_id: "rZ" }, defaultClock());
    expect(ran).toBe(true);
    expect(queueIsEmpty(ops)).toBe(true);
  });
});

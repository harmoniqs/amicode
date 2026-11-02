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

describe("drain-time path rebase (#2097): a job's machine paths resolve against THIS machine's drain config", () => {
  /** A fake machine: `home` stands in for os.homedir() (injected), with a real
   *  vault/ops/runs_root and one run dir under it. Foreign paths never exist. */
  function mkMachine() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "amicode-home-")));
    const vault = path.join(home, "vaults", "vault-new");
    const ops = path.join(home, ".amico", "ops");
    const runsRoot = path.join(home, ".amico", "runs");
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(ops, { recursive: true });
    fs.mkdirSync(path.join(runsRoot, "r42"), { recursive: true });
    return { home, vault, ops, runsRoot, env: { home, exists: fs.existsSync } };
  }
  const foreign = { vault: "/Users/aaron/.amico/vaults/vault-old", ops: "/Users/aaron/.amico/ops", runs_root: "/Users/aaron/.amico/runs" };
  function recorder() {
    const seen: Array<Record<string, unknown>> = [];
    const spawn = async (_cfg: unknown, job: Record<string, unknown>) => {
      seen.push(job);
      return { code: 0, output: "" };
    };
    return { seen, spawn };
  }
  const cfgFor = (m: ReturnType<typeof mkMachine>, defaults?: Record<string, unknown>) => ({
    binary: "/unused",
    config: {},
    job_defaults: defaults ?? { vault: m.vault, ops: m.ops, runs_root: m.runsRoot },
  });

  it("AC1: foreign vault/ops/runs_root are drained against this machine's configured values", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    await makeDistillHandler(cfgFor(m), r.spawn, m.env)({ kind: "run", run_id: "r42", ...foreign });
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({ vault: m.vault, ops: m.ops, runs_root: m.runsRoot });
  });

  it("AC1 end-to-end: enqueueAndDrain hands the headless child the rebased job", async () => {
    const { enqueueAndDrain, defaultClock, writeDistillerConfig } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const bin = path.join(m.ops, "fake-opencode");
    fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$4" > "${m.ops}/captured-job"\n`);
    fs.chmodSync(bin, 0o755);
    writeDistillerConfig(m.ops, { binary: bin, config: {}, job_defaults: { vault: m.vault, ops: m.ops, runs_root: m.runsRoot } });
    expect(await enqueueAndDrain(m.ops, { kind: "run", run_id: "r42", ...foreign }, defaultClock())).toBe(true);
    const got = JSON.parse(fs.readFileSync(path.join(m.ops, "captured-job"), "utf8"));
    expect(got).toMatchObject({ kind: "run", run_id: "r42", vault: m.vault, ops: m.ops, runs_root: m.runsRoot });
    expect(queueIsEmpty(m.ops)).toBe(true);
  });

  it("only the unusable field is rebased; usable ones are left alone", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const otherVault = path.join(m.home, "vaults", "another-existing");
    fs.mkdirSync(otherVault);
    const r = recorder();
    await makeDistillHandler(cfgFor(m), r.spawn, m.env)({ kind: "run", run_id: "r42", vault: otherVault, ops: foreign.ops, runs_root: m.runsRoot });
    expect(r.seen[0]).toMatchObject({ vault: otherVault, ops: m.ops, runs_root: m.runsRoot });
    expect(r.seen[0].rebased_from).toEqual({ ops: foreign.ops });
  });

  it("a recorded path that exists but lies outside this machine's home is unusable too", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-outside-")); // exists, not under m.home
    const r = recorder();
    await makeDistillHandler(cfgFor(m), r.spawn, m.env)({ kind: "sweep", vault: outside, ops: m.ops });
    expect(r.seen[0]).toMatchObject({ vault: m.vault, ops: m.ops });
    expect(r.seen[0].rebased_from).toEqual({ vault: outside });
  });

  it("AC2: a healthy job (paths exist, under home) reaches the handler byte-identical", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const job = { kind: "run" as const, run_id: "r42", vault: m.vault, ops: m.ops, runs_root: m.runsRoot };
    const before = JSON.stringify(job);
    await makeDistillHandler(cfgFor(m, { vault: "/somewhere/else" }), r.spawn, m.env)(job);
    expect(JSON.stringify(r.seen[0])).toBe(before);
    expect(r.seen[0]).not.toHaveProperty("rebased_from");
  });

  it("AC2: a job carrying no machine paths at all is passed through untouched (even with no job_defaults)", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const job = { kind: "run" as const, run_id: "rZ" };
    await makeDistillHandler({ binary: "/unused", config: {} }, r.spawn, m.env)(job);
    expect(JSON.stringify(r.seen[0])).toBe(JSON.stringify(job));
  });

  it("AC3: identity and unrelated fields survive a rebase unchanged", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const job = { kind: "sweep" as const, run_id: "r42", session_ids: ["s1", "s2"], note: { a: 1 }, ...foreign };
    await makeDistillHandler(cfgFor(m), r.spawn, m.env)(job);
    expect(r.seen[0]).toMatchObject({ kind: "sweep", run_id: "r42", session_ids: ["s1", "s2"], note: { a: 1 } });
  });

  it("AC4: a rebased job records the original values; the queue file is never rewritten", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const job = { kind: "run" as const, run_id: "r42", ...foreign };
    const file = enqueueJob(m.ops, job);
    const original = fs.readFileSync(file, "utf8");
    const handler = makeDistillHandler(cfgFor(m), r.spawn, m.env);
    await handler(job);
    expect(r.seen[0].rebased_from).toEqual(foreign);
    expect(job).toEqual({ kind: "run", run_id: "r42", ...foreign }); // input not mutated
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    // and when the job then fails, the set-aside file is still the original bytes
    await drainOnce(m.ops, async (j) => {
      await handler(j);
      throw new Error("boom");
    });
    const aside = fs.readdirSync(path.join(m.ops, "distill-queue")).find((f) => f.includes(".failed-"))!;
    expect(fs.readFileSync(path.join(m.ops, "distill-queue", aside), "utf8")).toBe(original);
  });

  it("AC5: no value in the drain config for an unusable field → named failure, distiller not invoked", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const handler = makeDistillHandler(cfgFor(m, { vault: m.vault, ops: m.ops }), r.spawn, m.env); // no runs_root
    await expect(handler({ kind: "run", run_id: "r42", ...foreign })).rejects.toThrow(/runs_root/);
    expect(r.seen).toHaveLength(0);
  });

  it("AC5: config with no job_defaults at all → named failure, never a guessed path", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const handler = makeDistillHandler({ binary: "/unused", config: {} }, r.spawn, m.env);
    await expect(handler({ kind: "sweep", vault: foreign.vault, ops: m.ops })).rejects.toThrow(/vault/);
    expect(r.seen).toHaveLength(0);
  });

  it("AC5: a blank configured value counts as missing", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const handler = makeDistillHandler(cfgFor(m, { vault: "" }), r.spawn, m.env);
    await expect(handler({ kind: "sweep", vault: foreign.vault })).rejects.toThrow(/vault/);
    expect(r.seen).toHaveLength(0);
  });

  it("AC5 end-to-end: unrebasable job is set aside .failed, child never spawned", async () => {
    const { enqueueAndDrain, defaultClock, writeDistillerConfig } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const bin = path.join(m.ops, "fake-opencode");
    fs.writeFileSync(bin, `#!/bin/sh\ntouch "${m.ops}/invoked"\n`);
    fs.chmodSync(bin, 0o755);
    writeDistillerConfig(m.ops, { binary: bin, config: {} }); // no job_defaults
    await enqueueAndDrain(m.ops, { kind: "sweep", ...foreign }, defaultClock());
    expect(fs.existsSync(path.join(m.ops, "invoked"))).toBe(false);
    expect(queueIsEmpty(m.ops)).toBe(true);
    expect(fs.readdirSync(path.join(m.ops, "distill-queue")).some((f) => f.includes(".failed-"))).toBe(true);
  });

  it("AC6: a run job whose run dir is missing after rebasing fails naming the directory; distiller not invoked", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const handler = makeDistillHandler(cfgFor(m), r.spawn, m.env);
    await expect(handler({ kind: "run", run_id: "r-gone", ...foreign })).rejects.toThrow(path.join(m.runsRoot, "r-gone"));
    expect(r.seen).toHaveLength(0);
  });

  it("AC6: the run-dir check also holds for a job that needed no rebasing", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const r = recorder();
    const handler = makeDistillHandler(cfgFor(m), r.spawn, m.env);
    await expect(
      handler({ kind: "run", run_id: "r-gone", vault: m.vault, ops: m.ops, runs_root: m.runsRoot }),
    ).rejects.toThrow(path.join(m.runsRoot, "r-gone"));
    expect(r.seen).toHaveLength(0);
  });

  it("demo_dir is path-shaped but has no configured default: existing is untouched, missing fails by name", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const demo = path.join(m.home, "demos", "bell");
    fs.mkdirSync(demo, { recursive: true });
    const r = recorder();
    const handler = makeDistillHandler(cfgFor(m), r.spawn, m.env);
    await handler({ kind: "demo" as never, demo_dir: demo, vault: m.vault, ops: m.ops });
    expect(r.seen[0].demo_dir).toBe(demo);
    await expect(
      handler({ kind: "demo" as never, demo_dir: "/Users/aaron/demos/bell", vault: m.vault, ops: m.ops }),
    ).rejects.toThrow(/demo_dir/);
    expect(r.seen).toHaveLength(1);
  });
});

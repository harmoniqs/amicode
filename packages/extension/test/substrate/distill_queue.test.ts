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
  runDrainLoopResult,
  drainPass,
  resetDistillHalt,
  readDistillHalt,
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
  /** A fake machine: `home` is a temp dir holding a real
   *  vault/ops/runs_root and one run dir under it. Foreign paths never exist. */
  function mkMachine() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "amicode-home-")));
    const vault = path.join(home, "vaults", "vault-new");
    const ops = path.join(home, ".amico", "ops");
    const runsRoot = path.join(home, ".amico", "runs");
    fs.mkdirSync(vault, { recursive: true });
    fs.mkdirSync(ops, { recursive: true });
    fs.mkdirSync(path.join(runsRoot, "r42"), { recursive: true });
    return { home, vault, ops, runsRoot, env: { exists: fs.existsSync } };
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

  it("an existing path outside this machine's home (another volume) is NOT rebased: the job passes through unchanged", async () => {
    const { makeDistillHandler } = await import("../../opencode-plugin/distill_queue");
    const m = mkMachine();
    const volume = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "amicode-volume-"))); // exists, not under m.home
    const outside = { vault: path.join(volume, "vaults"), ops: path.join(volume, "ops"), runs_root: path.join(volume, "runs") };
    fs.mkdirSync(outside.vault);
    fs.mkdirSync(outside.ops);
    fs.mkdirSync(path.join(outside.runs_root, "r42"), { recursive: true });
    const r = recorder();
    const job = { kind: "run" as const, run_id: "r42", ...outside };
    const before = JSON.stringify(job);
    await makeDistillHandler(cfgFor(m), r.spawn, m.env)(job); // job_defaults point at a DIFFERENT vault
    expect(r.seen[0]).toBe(job);
    expect(JSON.stringify(r.seen[0])).toBe(before);
    expect(r.seen[0]).not.toHaveProperty("rebased_from");
    expect(r.seen[0].vault).toBe(outside.vault);
  });

  it("AC2: a healthy job (paths exist) reaches the handler byte-identical", async () => {
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

describe("bounded retry, parking and halt (#2098) — temp ops dirs + injected clock only", () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  const queue = (ops: string) => path.join(ops, "distill-queue");
  const files = (ops: string) => fs.readdirSync(queue(ops)).sort();
  const failing = async () => {
    throw new Error("boom: timeout");
  };
  /** A drain against a fake clock; returns the pass result. */
  const pass = (ops: string, at: number, handler: (j: { kind: string; [k: string]: unknown }) => Promise<void> = failing) =>
    drainPass(ops, handler as never, { now: () => at });
  const ledgerOf = (ops: string, ready: string) =>
    JSON.parse(fs.readFileSync(path.join(queue(ops), `${ready}.attempts`), "utf8"));

  it("AC1: a failed job records attempt, last error and time, and is withheld until its backoff has passed", async () => {
    const ops = mkOps();
    const file = path.basename(enqueueJob(ops, { kind: "run", run_id: "a" }));
    const seen: string[] = [];
    const ok = async (j: { run_id?: unknown }) => void seen.push(String(j.run_id));

    await pass(ops, T0);
    expect(ledgerOf(ops, file)).toMatchObject({ attempt: 1, last_error: "boom: timeout", last_at: T0 });
    expect(files(ops).some((f) => f.startsWith(`${file}.failed-`))).toBe(true);

    expect((await pass(ops, T0 + 10 * MIN - 1, ok)).attempted).toBe(0); // not yet
    expect(seen).toEqual([]);
    expect((await pass(ops, T0 + 10 * MIN, ok)).succeeded).toBe(1); // due
    expect(seen).toEqual(["a"]);
    expect(fs.readdirSync(queue(ops))).toEqual([]); // job AND ledger gone after success
  });

  it("AC1: delays grow with each attempt (10 min, then 40, then 160)", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "a" });
    let t = T0;
    for (const delay of [10, 40, 160]) {
      expect((await pass(ops, t)).failed).toBe(1);
      expect((await pass(ops, t + delay * MIN - 1)).attempted).toBe(0);
      t += delay * MIN;
    }
    expect((await pass(ops, t)).attempted).toBe(1); // the 4th and last attempt
  });

  it("AC1: the error message is persisted truncated to 500 chars", async () => {
    const ops = mkOps();
    const file = path.basename(enqueueJob(ops, { kind: "run" }));
    await pass(ops, T0, async () => {
      throw new Error("x".repeat(900));
    });
    expect(ledgerOf(ops, file).last_error).toBe("x".repeat(500));
  });

  it("AC2: the 4th failed attempt parks the job — kept byte-identical, never re-offered", async () => {
    const ops = mkOps();
    const file = path.basename(enqueueJob(ops, { kind: "run", run_id: "a" }));
    const original = fs.readFileSync(path.join(queue(ops), file), "utf8");
    let t = T0;
    for (const delay of [10, 40, 160, 0]) {
      expect((await pass(ops, t)).failed).toBe(1);
      t += delay * MIN;
    }
    const parked = files(ops).find((f) => f.startsWith(`${file}.parked-`))!;
    expect(parked).toBeDefined();
    expect(files(ops).some((f) => f.includes(".failed-") || f === file)).toBe(false);
    expect(fs.readFileSync(path.join(queue(ops), parked), "utf8")).toBe(original);
    expect(ledgerOf(ops, file).attempt).toBe(4);
    const seen: string[] = [];
    const r = await pass(ops, t + 365 * 24 * 60 * MIN, async (j) => void seen.push(String(j.run_id)));
    expect(r.attempted).toBe(0);
    expect(seen).toEqual([]);
    expect(files(ops)).toContain(parked); // never deleted
    expect(queueIsEmpty(ops)).toBe(true);
  });

  it("AC3: five consecutive failures across different jobs halt the drain, leaving the rest untouched", async () => {
    const ops = mkOps();
    for (let i = 0; i < 7; i++) enqueueJob(ops, { kind: "run", run_id: `j${i}` });
    const called: string[] = [];
    const r = await pass(ops, T0, async (j) => {
      called.push(String(j.run_id));
      throw new Error("no model access");
    });
    expect(called).toEqual(["j0", "j1", "j2", "j3", "j4"]);
    expect(r.halted?.reason).toMatch(/halted/);
    expect(r.halted?.reason).toMatch(/5 consecutive failures across different jobs/);
    expect(files(ops).filter((f) => f.endsWith(".json")).length).toBe(2); // j5, j6 untouched
    expect(readDistillHalt(ops)).toMatchObject({ consecutive: 5 });
    expect(fs.existsSync(path.join(ops, "distill-halt.json"))).toBe(true);
    // while halted no drain runs and nothing is spent
    const again: string[] = [];
    const r2 = await pass(ops, T0 + 1000 * MIN, async (j) => void again.push(String(j.run_id)));
    expect(again).toEqual([]);
    expect(r2.attempted).toBe(0);
    expect(r2.halted?.reason).toMatch(/halted/);
    // manual reset clears it
    resetDistillHalt(ops);
    expect(readDistillHalt(ops)).toBeNull();
    const r3 = await pass(ops, T0 + 1000 * MIN, async (j) => void again.push(String(j.run_id)));
    expect(r3.halted).toBeUndefined();
    // after the reset the untouched jobs run, and the five backed-off ones are due again by then
    expect(again).toEqual(["j0", "j1", "j2", "j3", "j4", "j5", "j6"]);
  });

  it("AC3: one job failing repeatedly does not count as five", async () => {
    const ops = mkOps();
    for (let i = 0; i < 4; i++) enqueueJob(ops, { kind: "run", run_id: `j${i}` });
    let t = T0;
    for (const delay of [10, 40, 160, 0]) {
      // four distinct jobs fail on every pass, each job failing again and again
      expect((await pass(ops, t)).halted).toBeUndefined();
      t += delay * MIN;
    }
    expect(readDistillHalt(ops)).toBeNull();
    expect(files(ops).filter((f) => f.includes(".parked-")).length).toBe(4);
  });

  it("AC4: a success resets the consecutive-failure count", async () => {
    const ops = mkOps();
    ["f0", "f1", "f2", "f3", "ok", "g0", "g1", "g2", "g3"].forEach((id) => enqueueJob(ops, { kind: "run", run_id: id }));
    const r = await pass(ops, T0, async (j) => {
      if (j.run_id !== "ok") throw new Error("boom");
    });
    expect(r.halted).toBeUndefined(); // 4 + success + 4, never 5 in a row
    expect(r.failed).toBe(8);
    expect(r.succeeded).toBe(1);
  });

  it("AC5: legacy .failed-<ms> files are one prior attempt, retry-eligible, and left byte-identical until retried", async () => {
    const ops = mkOps();
    fs.mkdirSync(queue(ops), { recursive: true });
    const legacy = "1690000000000-0000-run.json";
    const legacyFile = path.join(queue(ops), `${legacy}.failed-1690000600000`);
    fs.writeFileSync(legacyFile, JSON.stringify({ kind: "run", run_id: "old" }) + "\n");
    const before = fs.readFileSync(legacyFile, "utf8");
    expect(queueIsEmpty(ops)).toBe(true); // not "ready"
    expect(listJobs(ops)).toEqual([]);

    // a standing halt means no drain runs: the legacy file is neither moved nor rewritten
    fs.writeFileSync(path.join(ops, "distill-halt.json"), JSON.stringify({ reason: "halted: test", at: T0, consecutive: 5, job_ids: [] }));
    await pass(ops, T0);
    expect(fs.readFileSync(legacyFile, "utf8")).toBe(before);
    expect(files(ops)).toEqual([`${legacy}.failed-1690000600000`]);
    resetDistillHalt(ops);

    // retried immediately (long overdue); the retry fails → it is now attempt 2 (40 min backoff)
    expect((await pass(ops, T0)).failed).toBe(1);
    expect(ledgerOf(ops, legacy).attempt).toBe(2);
    expect((await pass(ops, T0 + 40 * MIN - 1)).attempted).toBe(0);
    const seen: string[] = [];
    expect((await pass(ops, T0 + 40 * MIN, async (j) => void seen.push(String(j.run_id)))).succeeded).toBe(1);
    expect(seen).toEqual(["old"]);
    expect(fs.readdirSync(queue(ops))).toEqual([]);
  });

  it("an unparseable job is attempted and set aside like any failure, but is no evidence of a systemic fault", async () => {
    const ops = mkOps();
    fs.mkdirSync(queue(ops), { recursive: true });
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(queue(ops), `170000000000${i}-0000-run.json`), "{not json");
    const r = await pass(ops, T0, async () => {
      throw new Error("handler must not run");
    });
    expect(r.failed).toBe(6);
    expect(r.halted).toBeUndefined();
    expect(files(ops).filter((f) => f.includes(".failed-")).length).toBe(6);
  });

  it("runDrainLoop: a backing-off job is not work — the handler runs once, the loop ends, the lock is released", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "a" });
    let calls = 0;
    const out = await runDrainLoopResult(
      ops,
      async () => {
        calls++;
        throw new Error("boom");
      },
      { pid: 42, now: () => T0, isPidAlive: () => true },
    );
    expect(out).toEqual({ ran: true });
    expect(calls).toBe(1);
    expect(claimLock(ops, 7)).toBe(true);
  });

  it("runDrainLoop: a clock that jumps past the backoff does not re-offer the job inside the same loop", async () => {
    const ops = mkOps();
    enqueueJob(ops, { kind: "run", run_id: "a" });
    let t = T0;
    let calls = 0;
    await runDrainLoopResult(
      ops,
      async () => {
        calls++;
        t += 1000 * MIN;
        throw new Error("boom");
      },
      { pid: 42, now: () => t, isPidAlive: () => true },
    );
    expect(calls).toBe(1);
  });

  it("runDrainLoop: a halted drain exits the loop with the reason, releases the lock and spends nothing more", async () => {
    const ops = mkOps();
    for (let i = 0; i < 8; i++) enqueueJob(ops, { kind: "run", run_id: `j${i}` });
    let calls = 0;
    const clock = { pid: 42, now: () => T0, isPidAlive: () => true };
    const handler = async () => {
      calls++;
      throw new Error("wrong binary");
    };
    const out = await runDrainLoopResult(ops, handler, clock);
    expect(out.ran).toBe(true);
    expect(out.halted?.reason).toMatch(/halted/);
    expect(calls).toBe(5);
    expect(claimLock(ops, 7)).toBe(true);
    releaseLock(ops);
    // a later trigger finds the halt and spends nothing
    expect((await runDrainLoopResult(ops, handler, clock)).halted?.reason).toMatch(/halted/);
    expect(calls).toBe(5);
    expect(await runDrainLoop(ops, handler, clock)).toBe(true);
    expect(calls).toBe(5);
  });
});

// #2045 C — run.lock + heartbeat written by the orchestrator, and the pending-verification
// marker that precedes FINISHED for free-tier local runs.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fakeJulia, readToml, tmpRoot } from "./helpers.js";
import { LocalExecutor } from "../src/local_executor.js";
import { runVerification } from "../src/verify.js";
import { LOCK_STALE_MS, lockIsDead, lockIsLive, readRunLock, type RunLock } from "../src/run_lock.js";
import type { SpecStamp } from "../src/types.js";

const SLEEPY = `console.log('AMICODE_ITER iter=1 f=0.5'); setTimeout(() => console.log('DONE f=0.9'), 700)`;

function freeSpec(root: string): SpecStamp {
  return {
    canonical: "{}",
    tier: "free",
    hashes: { spec_hash: "sha256:feedface" },
    julia_binary: join(root, "j"),
  };
}

describe("run.lock (#2045 C)", () => {
  it("a run writes a lock at start: pid, host, spec hash, protection none, unit null", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", SLEEPY) },
      spec: { canonical: "{}", tier: "vetted", hashes: { spec_hash: "sha256:abc" } },
    });
    const lock = readRunLock(h.runDir)!;
    expect(lock).toMatchObject({
      schema: 1,
      run_id: h.runId,
      unit: null,
      pid: process.pid,
      host: hostname(),
      spec_hash: "sha256:abc",
      protection: "none",
      cloud_run_id: null,
      ended: false,
    });
    expect(Number.isNaN(Date.parse(lock.started_at))).toBe(false);
    await h.finished;
  });

  it("bare runs record spec_hash null; caller-supplied protection/unit are recorded", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", "process.exit(0)") },
      lock: { protection: "unit", unit: "amico-run-test-xyz.service" },
    });
    expect(readRunLock(h.runDir)).toMatchObject({ spec_hash: null, protection: "unit", unit: "amico-run-test-xyz.service" });
    await h.finished;
  });

  it("heartbeat refreshes heartbeat_at while the run lives", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", SLEEPY) },
      heartbeatMs: 50,
    });
    const first = readRunLock(h.runDir)!.heartbeat_at;
    await new Promise((r) => setTimeout(r, 300));
    const second = readRunLock(h.runDir)!.heartbeat_at;
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first));
    await h.finished;
  });

  it("the final write is ended:true and lands BEFORE FINISHED", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", SLEEPY) },
    });
    // at the moment FINISHED first appears, the lock on disk must already say ended:true
    const endedAtFinished = await new Promise<boolean>((resolveP) => {
      const w = watch(h.runDir, (_ev, name) => {
        if (name === "FINISHED" && existsSync(join(h.runDir, "FINISHED"))) {
          w.close();
          resolveP(readRunLock(h.runDir)!.ended);
        }
      });
    });
    expect(endedAtFinished).toBe(true);
    await h.finished;
    expect(readRunLock(h.runDir)!.ended).toBe(true);
    // the lock stops beating after the run: heartbeat_at no longer changes
    const a = readRunLock(h.runDir)!.heartbeat_at;
    await new Promise((r) => setTimeout(r, 120));
    expect(readRunLock(h.runDir)!.heartbeat_at).toBe(a);
  });

  it("is written atomically with mode 0644 and leaves no temp file", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", "process.exit(0)") },
    });
    await h.finished;
    const { statSync, readdirSync } = await import("node:fs");
    expect(statSync(join(h.runDir, "run.lock")).mode & 0o777).toBe(0o644);
    expect(readdirSync(h.runDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("liveness rule (contract)", () => {
  const base: RunLock = {
    schema: 1,
    run_id: "r1",
    unit: null,
    pid: 1,
    host: "h",
    spec_hash: null,
    protection: "none",
    cloud_run_id: null,
    started_at: new Date(0).toISOString(),
    heartbeat_at: new Date(0).toISOString(),
    ended: false,
  };
  const dir = (finished: boolean): string => {
    const d = tmpRoot();
    if (finished) writeFileSync(join(d, "FINISHED"), 'status = "completed"\nexit_code = 0\n');
    return d;
  };
  const at = (ms: number): string => new Date(ms).toISOString();

  it("dead iff lock, no FINISHED, not ended, heartbeat older than 90 s", () => {
    const now = 1_000_000_000_000;
    const stale = { ...base, heartbeat_at: at(now - LOCK_STALE_MS - 1) };
    expect(lockIsDead(dir(false), stale, now)).toBe(true);
    expect(lockIsLive(dir(false), stale, now)).toBe(false);
    const fresh = { ...base, heartbeat_at: at(now - LOCK_STALE_MS + 1000) };
    expect(lockIsDead(dir(false), fresh, now)).toBe(false);
    expect(lockIsLive(dir(false), fresh, now)).toBe(true);
    expect(lockIsDead(dir(true), stale, now)).toBe(false); // FINISHED wins
    expect(lockIsDead(dir(false), { ...stale, ended: true }, now)).toBe(false);
    expect(lockIsLive(dir(false), { ...fresh, ended: true }, now)).toBe(false);
  });
});

describe("pending verification marker (#2045 C)", () => {
  it("free-tier local run: a pending marker exists before FINISHED, then verification replaces it", async () => {
    const root = tmpRoot();
    const julia = fakeJulia(root, "j", SLEEPY);
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia },
      spec: freeSpec(root),
    });
    const markerAtFinished = await new Promise<Record<string, unknown> | undefined>((resolveP) => {
      const w = watch(h.runDir, (_ev, name) => {
        if (name === "FINISHED" && existsSync(join(h.runDir, "FINISHED"))) {
          w.close();
          resolveP(existsSync(join(h.runDir, "verification.toml")) ? readToml(join(h.runDir, "verification.toml")) : undefined);
        }
      });
    });
    expect(markerAtFinished).toMatchObject({ agree: false, pending: true, reason: "pending" });
    await h.finished;

    // a harness that writes the final verdict overwrites the marker (no `pending`)
    const harness = fakeJulia(
      root,
      "h.js",
      `const fs=require('fs'),p=require('path');fs.writeFileSync(p.join(process.argv[process.argv.length-2],'verification.toml'),'schema_version = "1"\\nagree = true\\n')`,
    );
    writeFileSync(join(root, "auth.json"), "{}");
    await runVerification(h.runDir, { ...freeSpec(root), julia_binary: harness }, {
      allowlist: [],
      support_set: [],
      verify_harness: harness,
      verify_tolerance: 0.01,
    } as never);
    const final = readToml(join(h.runDir, "verification.toml"));
    expect(final.agree).toBe(true);
    expect(final.pending).toBeUndefined();
  });

  it("a harness that dies without writing replaces the marker with the fallback (never left pending)", async () => {
    const root = tmpRoot();
    const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
      runsRoot: join(root, "runs"),
      julia: { julia: fakeJulia(root, "j", "process.exit(0)") },
      spec: freeSpec(root),
    });
    await h.finished;
    expect(readToml(join(h.runDir, "verification.toml")).pending).toBe(true);
    const dead = fakeJulia(root, "dead.js", "process.exit(3)");
    await runVerification(h.runDir, { ...freeSpec(root), julia_binary: dead }, {
      allowlist: [],
      support_set: [],
      verify_harness: dead,
      verify_tolerance: 0.01,
    } as never);
    const v = readToml(join(h.runDir, "verification.toml"));
    expect(v.pending).toBeUndefined();
    expect(v.agree).toBe(false);
    expect(String(v.error)).toMatch(/without writing/);
  });

  it("vetted and bare runs get no marker", async () => {
    const root = tmpRoot();
    for (const spec of [undefined, { canonical: "{}", tier: "vetted", hashes: { spec_hash: "sha256:1" } }]) {
      const h = await new LocalExecutor().submit(fakeJulia(root, "s.jl", ""), {
        runsRoot: join(root, "runs"),
        julia: { julia: fakeJulia(root, "j", "process.exit(0)") },
        spec,
      });
      await h.finished;
      expect(existsSync(join(h.runDir, "verification.toml"))).toBe(false);
    }
  });
});

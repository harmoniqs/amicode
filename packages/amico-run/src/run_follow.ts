// The thin client of a placed run (#2045 E.5) and the verbs that act on one: tail run.log from
// the beginning printing every line exactly as the in-process event loop would have, wait for
// FINISHED (and, on free-tier local runs, for the final verification), and decide what to say
// when the orchestrator vanishes. Also `stop` and `attach`.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { defaultRunsRoot, deriveLabId } from "./run_dir.js";
import { LOCK_STALE_MS, lockIsDead, readRunLock, type RunLock } from "./run_lock.js";
import { exitCodeFor } from "./run_finish.js";
import { runQuiet } from "./placement.js";
import type { Finished, RunStatus } from "./types.js";
import { studioPathsOrLegacy } from "@amicode/schema";

/** Exit codes of the client (documented in docs/amico-run-placement.md). */
export const EXIT_DEAD = 69; // the orchestrator vanished (stale heartbeat, no FINISHED)
export const EXIT_DETACH_TERM = 143;
export const EXIT_DETACH_HUP = 129;

export const RUN_ID_RE = /^r\d{8}-\d{6}Z-[0-9a-f]{4}$/;

export type FollowResult =
  | { kind: "finished"; f: Finished; agree?: boolean }
  | { kind: "detached" }
  | { kind: "dead"; reason: string };

export interface FollowOpts {
  runDir: string;
  /** free-tier local run: wait for the final (non-pending) verification.toml */
  awaitVerification: boolean;
  /** every complete run.log line, in order */
  onLine: (line: string) => void;
  /** orchestrator liveness independent of run.lock (accelerates dead detection) */
  alive?: () => boolean;
  pollMs?: number;
  staleMs?: number;
  verifyWaitMs?: number;
}

export interface Follower {
  done: Promise<FollowResult>;
  /** stop tailing; the run is untouched */
  detach(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readFinished(runDir: string): Finished | undefined {
  try {
    const t = parseToml(readFileSync(join(runDir, "FINISHED"), "utf8")) as { status?: string; exit_code?: number };
    if (typeof t.status !== "string" || typeof t.exit_code !== "number") return undefined;
    return { status: t.status as RunStatus, exitCode: t.exit_code };
  } catch {
    return undefined;
  }
}

function verificationState(runDir: string): { pending: boolean; agree: boolean } {
  try {
    const v = parseToml(readFileSync(join(runDir, "verification.toml"), "utf8")) as Record<string, unknown>;
    return { pending: v.pending === true, agree: v.agree === true };
  } catch {
    return { pending: true, agree: false };
  }
}

export function followRun(opts: FollowOpts): Follower {
  let detached = false;
  const pollMs = opts.pollMs ?? 50;
  const staleMs = opts.staleMs ?? (Number(process.env.AMICO_RUN_STALE_MS) || LOCK_STALE_MS);
  const verifyWaitMs = opts.verifyWaitMs ?? (Number(process.env.AMICO_RUN_VERIFY_WAIT_MS) || 30 * 60 * 1000);
  const logPath = join(opts.runDir, "run.log");
  let offset = 0;
  let carry: Buffer = Buffer.alloc(0);

  const drain = (flushPartial: boolean): void => {
    let fd: number;
    try {
      fd = openSync(logPath, "r");
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size > offset) {
        const buf = Buffer.alloc(size - offset);
        const n = readSync(fd, buf, 0, buf.length, offset);
        offset += n;
        carry = Buffer.concat([carry, buf.subarray(0, n)]);
      }
    } finally {
      closeSync(fd);
    }
    for (;;) {
      const nl = carry.indexOf(0x0a);
      if (nl < 0) break;
      opts.onLine(carry.subarray(0, nl).toString("utf8"));
      carry = carry.subarray(nl + 1);
    }
    if (flushPartial && carry.length > 0) {
      opts.onLine(carry.toString("utf8"));
      carry = Buffer.alloc(0);
    }
  };

  const done = (async (): Promise<FollowResult> => {
    const startedAt = Date.now();
    let lastAliveCheck = 0;
    let deadSince = 0;
    for (;;) {
      if (detached) return { kind: "detached" };
      drain(false);
      const f = readFinished(opts.runDir);
      if (f) {
        // run.log is flushed BEFORE FINISHED is written (local_executor settle), so one more
        // drain is complete.
        drain(true);
        return await afterFinished(f);
      }
      const now = Date.now();
      const lock = readRunLock(opts.runDir);
      if (lock ? lockIsDead(opts.runDir, lock, now, staleMs) : now - startedAt > staleMs)
        return { kind: "dead", reason: lock ? `heartbeat stale since ${lock.heartbeat_at}` : "the orchestrator never started" };
      if (opts.alive && now - lastAliveCheck > 1500) {
        lastAliveCheck = now;
        if (!opts.alive()) {
          // give a just-exited orchestrator one more cycle to have its FINISHED visible
          if (deadSince === 0) deadSince = now;
          else if (now - deadSince > 1000 && !existsSync(join(opts.runDir, "FINISHED")))
            return { kind: "dead", reason: "the orchestrator exited without writing FINISHED" };
        } else deadSince = 0;
      }
      await sleep(pollMs);
    }
  })();

  async function afterFinished(f: Finished): Promise<FollowResult> {
    if (!opts.awaitVerification) return { kind: "finished", f };
    const t0 = Date.now();
    let lastAliveCheck = 0;
    for (;;) {
      if (detached) return { kind: "detached" };
      const v = verificationState(opts.runDir);
      if (!v.pending) return { kind: "finished", f, agree: v.agree };
      const now = Date.now();
      if (now - t0 > verifyWaitMs) {
        process.stderr.write(`amico-run: verification still pending after ${Math.round(verifyWaitMs / 1000)}s — reporting agree=false\n`);
        return { kind: "finished", f, agree: false };
      }
      if (opts.alive && now - lastAliveCheck > 1500) {
        lastAliveCheck = now;
        if (!opts.alive()) {
          const again = verificationState(opts.runDir);
          if (!again.pending) return { kind: "finished", f, agree: again.agree };
          process.stderr.write(`amico-run: the orchestrator exited before the verification finished — reporting agree=false\n`);
          return { kind: "finished", f, agree: false };
        }
      }
      await sleep(pollMs);
    }
  }

  return {
    done,
    detach() {
      detached = true;
    },
  };
}

// ── locating a run ──────────────────────────────────────────────────────────

export interface RunRef {
  runDir: string;
  runId: string;
}

/** A path to a run dir, or a run id looked up under --runs-root, the --lab's runs root, or every
 *  lab under the studio runs root. */
export function locateRun(target: string, o: { runsRoot?: string; lab?: string } = {}): RunRef | undefined {
  if (target.includes("/") || !RUN_ID_RE.test(target)) {
    const dir = resolve(target);
    if (existsSync(join(dir, "run.toml"))) return { runDir: dir, runId: dir.split("/").at(-1)! };
    return undefined;
  }
  const roots: string[] = [];
  if (o.runsRoot) roots.push(o.runsRoot);
  else if (o.lab) roots.push(defaultRunsRoot(deriveLabId(o.lab)));
  else {
    const all = studioPathsOrLegacy().runs;
    try {
      for (const e of readdirSync(all)) if (statSync(join(all, e)).isDirectory()) roots.push(join(all, e));
    } catch {
      /* no runs root */
    }
  }
  for (const root of roots) {
    const dir = join(root, target);
    if (existsSync(join(dir, "run.toml"))) return { runDir: dir, runId: target };
  }
  return undefined;
}

// ── stop ────────────────────────────────────────────────────────────────────

/** Is `pid` plausibly THE orchestrator for this run (not a recycled pid)? Same host, process
 *  exists, and its command line is an amico process for this run. */
export function pidIsOrchestrator(lock: RunLock, runDir: string): boolean {
  if (lock.host !== hostname()) return false;
  try {
    process.kill(lock.pid, 0);
  } catch {
    return false;
  }
  let cmd: string;
  try {
    cmd = readFileSync(`/proc/${lock.pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return false; // no /proc: refuse rather than signal a stranger
  }
  return cmd.includes("--adopt") || cmd.includes(runDir) || /amico/.test(cmd);
}

export type StopOutcome = "stopped" | "already-finished" | "gone" | "refused" | "not-found" | "no-lock";

/** Idempotent. exit 0 for stopped / already finished / gone; nonzero otherwise. */
export async function stopRun(
  target: string,
  o: { runsRoot?: string; lab?: string; waitMs?: number } = {},
): Promise<{ outcome: StopOutcome; message: string }> {
  const ref = locateRun(target, o);
  if (!ref) return { outcome: "not-found", message: `no such run: ${target}` };
  const finished = (): boolean => existsSync(join(ref.runDir, "FINISHED"));
  if (finished()) return { outcome: "already-finished", message: `run ${ref.runId} already finished` };
  const lock = readRunLock(ref.runDir);
  if (!lock)
    return {
      outcome: "no-lock",
      message: `run ${ref.runId} has no run.lock (started before placement existed) — stop its launcher process instead`,
    };

  if (lock.protection === "unit" && lock.unit) {
    const env = { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` };
    await runQuiet("systemctl", ["--user", "stop", lock.unit], env);
  } else {
    if (!pidIsOrchestrator(lock, ref.runDir)) {
      if (lockIsDead(ref.runDir, lock))
        return { outcome: "gone", message: `run ${ref.runId} is dead (orchestrator gone, no FINISHED); nothing to stop` };
      return {
        outcome: "refused",
        message: `pid ${lock.pid} on ${lock.host} is not the orchestrator of run ${ref.runId} — refusing to signal it`,
      };
    }
    try {
      process.kill(lock.pid, "SIGTERM");
    } catch {
      /* raced with its exit */
    }
  }
  // `systemctl stop` returns once the unit is down; a SIGTERMed pid needs polling. FINISHED is
  // written before the orchestrator exits, so "orchestrator gone" + no FINISHED means it is dead.
  const deadline = Date.now() + (o.waitMs ?? 45000);
  const pidUp = (): boolean => {
    try {
      process.kill(lock.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline && !finished() && lock.protection !== "unit" && pidUp()) await sleep(100);
  if (finished()) return { outcome: "stopped", message: `run ${ref.runId} stopped` };
  return { outcome: "gone", message: `run ${ref.runId}: orchestrator stopped but no FINISHED was written (run is dead)` };
}

export function exitForStop(outcome: StopOutcome): number {
  switch (outcome) {
    case "stopped":
    case "already-finished":
    case "gone":
      return 0;
    case "not-found":
    case "no-lock":
      return 64;
    case "refused":
      return 1;
  }
}

export { exitCodeFor };

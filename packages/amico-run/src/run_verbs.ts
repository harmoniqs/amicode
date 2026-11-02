// Client-side verbs of a placed run: the follow-and-report loop shared by the launcher's thin
// client and `attach`, plus the `stop` / `attach` CLI front-ends (#2045 E, F).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { exitCodeFor } from "./run_finish.js";
import { readRunLock } from "./run_lock.js";
import {
  EXIT_DEAD,
  EXIT_DETACH_HUP,
  EXIT_DETACH_TERM,
  exitForStop,
  followRun,
  locateRun,
  pidIsOrchestrator,
  stopRun,
} from "./run_follow.js";

export interface ReportOpts {
  runDir: string;
  runId: string;
  awaitVerification: boolean;
  alive?: () => boolean;
  /** what Ctrl-C does: the launcher's client stops the run (the old abort semantics);
   *  an `attach` is only an observer and detaches */
  onSigint: { stop: () => Promise<void> } | "detach";
}

/** Tail the run, print exactly what the in-process launcher printed, and return its exit code. */
export async function followAndReport(o: ReportOpts): Promise<number> {
  const follower = followRun({
    runDir: o.runDir,
    awaitVerification: o.awaitVerification,
    onLine: (line) => console.log(line),
    alive: o.alive,
  });
  let detachedBy: "SIGTERM" | "SIGHUP" | "SIGINT" | undefined;
  const detach = (sig: "SIGTERM" | "SIGHUP" | "SIGINT") => (): void => {
    detachedBy = sig;
    follower.detach();
  };
  const onTerm = detach("SIGTERM");
  const onHup = detach("SIGHUP");
  const onInt = o.onSigint === "detach" ? detach("SIGINT") : (): void => void (o.onSigint as { stop: () => Promise<void> }).stop();
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  process.on("SIGINT", onInt);
  let res;
  try {
    res = await follower.done;
  } finally {
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
    process.off("SIGINT", onInt);
  }

  if (res.kind === "detached") {
    console.error(`amico-run: detached; run ${o.runId} continues — stop it with: amico run stop ${o.runId}`);
    return detachedBy === "SIGHUP" ? EXIT_DETACH_HUP : detachedBy === "SIGINT" ? 130 : EXIT_DETACH_TERM;
  }
  if (res.kind === "dead") {
    console.error(
      `amico-run: run ${o.runId} is DEAD — ${res.reason}; no FINISHED was written, its orchestrator is gone. Inspect ${o.runDir}`,
    );
    return EXIT_DEAD;
  }
  if (o.awaitVerification) console.log(`AMICODE_VERIFIED agree=${res.agree === true}`);
  console.log(`AMICODE_FINISHED status=${res.f.status} exitCode=${res.f.exitCode} runDir=${o.runDir}`);
  return exitCodeFor(res.f);
}

/** Liveness of a run's orchestrator from its lock alone (for `attach`). */
export function aliveFromLock(runDir: string): () => boolean {
  return () => {
    const lock = readRunLock(runDir);
    if (!lock) return true; // unknown: do not accelerate
    if (lock.protection === "unit" && lock.unit) {
      const s = spawnSync("systemctl", ["--user", "is-active", lock.unit], {
        env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}` },
        encoding: "utf8",
        timeout: 10000,
      });
      return ["active", "activating", "deactivating"].includes(s.stdout.trim());
    }
    return pidIsOrchestrator(lock, runDir);
  };
}

export interface RunVerbOpts {
  runsRoot?: string;
  lab?: string;
}

export async function stopVerb(target: string, o: RunVerbOpts): Promise<number> {
  const r = await stopRun(target, o);
  const out = r.outcome === "stopped" || r.outcome === "already-finished" ? console.log : console.error;
  out(`amico-run: ${r.message}`);
  return exitForStop(r.outcome);
}

export async function attachVerb(target: string, o: RunVerbOpts): Promise<number> {
  const ref = locateRun(target, o);
  if (!ref) {
    console.error(`amico-run: no such run: ${target}`);
    return 64;
  }
  let tier: string | undefined;
  try {
    const m = parseToml(readFileSync(join(ref.runDir, "run.toml"), "utf8")) as Record<string, unknown>;
    tier = typeof m.tier === "string" ? m.tier : undefined;
  } catch {
    /* bare run */
  }
  return followAndReport({
    runDir: ref.runDir,
    runId: ref.runId,
    // runs from before run.lock existed have no pending marker: never wait for a verification that may never come
    awaitVerification: tier === "free" && readRunLock(ref.runDir) !== undefined,
    alive: aliveFromLock(ref.runDir),
    onSigint: "detach",
  });
}

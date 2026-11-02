// The shared half of slice A0's restart guard (#2045 H).
//
// ops/hub/solve-guard.sh takes an EXCLUSIVE flock on $SOLVE_GUARD_LOCK_DIR/<unit>.lock while it
// checks the engine unit's cgroup for compute, rechecks, and restarts. A launch that decides to
// run Julia IN the engine's cgroup (placement `none`) must not interleave between the guard's
// last look and the restart: it holds the SAME lock SHARED from "decide placement" until the
// child is visible in the cgroup. If the guard holds it exclusive we wait; once we hold it
// shared the guard's check→recheck→restart cannot start, and when it does start it sees the child.
//
// No native flock binding exists in this repo and we add no dependencies, so the shared lock is
// held by a tiny `flock -s <file> sh -c 'echo held; exec cat'` child: the lock lives exactly as
// long as its stdin pipe is open (closing it ends `cat`, which releases the lock).
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The hub unit this process runs under, from its cgroup, or undefined outside a hub unit. */
export function hubUnitFromCgroup(cgroupText: string): string | undefined {
  for (const line of cgroupText.split("\n")) {
    const path = line.slice(line.indexOf(":", line.indexOf(":") + 1) + 1);
    // match the hub service anywhere in the path: a bash tool call runs in a child scope below it
    for (const seg of path.split("/"))
      if (/^co\.harmoniqs\.amicode-server(@[A-Za-z0-9_.-]+)?\.service$/.test(seg)) return seg;
  }
  return undefined;
}

export function restartLockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SOLVE_GUARD_LOCK_DIR || join(homedir(), ".amico", "server", "restart-locks");
}

export interface RestartLock {
  release(): void;
}

const NOOP: RestartLock = { release() {} };

/** Take the shared restart lock for this process's hub unit. A no-op outside a hub unit, off
 *  Linux, without `flock`, or if the lock cannot be taken in `timeoutS` (the launch must not
 *  hang for a stuck restart — it warns and proceeds; the restart is then the unguarded case
 *  A0 already documents). */
export async function holdRestartLock(
  opts: { env?: NodeJS.ProcessEnv; cgroup?: string; timeoutS?: number } = {},
): Promise<RestartLock> {
  const env = opts.env ?? process.env;
  if (process.platform !== "linux") return NOOP;
  let cgroup = opts.cgroup;
  if (cgroup === undefined) {
    try {
      cgroup = readFileSync("/proc/self/cgroup", "utf8");
    } catch {
      return NOOP;
    }
  }
  const unit = hubUnitFromCgroup(cgroup);
  if (!unit) return NOOP;

  const dir = restartLockDir(env);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return NOOP;
  }
  const timeoutS = opts.timeoutS ?? 130;
  return new Promise<RestartLock>((resolveP) => {
    const child = spawn(
      "flock",
      ["-s", "-w", String(timeoutS), join(dir, `${unit}.lock`), "sh", "-c", "echo held; exec cat"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let settled = false;
    const finish = (lock: RestartLock): void => {
      if (settled) return;
      settled = true;
      resolveP(lock);
    };
    child.on("error", () => finish(NOOP)); // flock not installed
    child.on("close", () => {
      if (!settled) {
        process.stderr.write(`amico-run: could not take the restart lock for ${unit}; continuing without it\n`);
        finish(NOOP);
      }
    });
    child.stdout!.once("data", () =>
      finish({
        release() {
          child.stdin!.end();
        },
      }),
    );
  });
}

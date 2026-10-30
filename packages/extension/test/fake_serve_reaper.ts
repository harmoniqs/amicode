// fake_serve_reaper.ts — #1782: test helper that makes the server lifecycle
// tests clean up the detached `fake_serve.mjs` servers they spawn.
//
// The fake `opencode` shim records its OWN pid (it `exec`s node, so `$$` becomes
// the server's pid) into `<dir>/fake_serve.pid`. `reapFakeServes()` — run from an
// `afterEach` so it also fires when an assertion fails before a test's own
// cleanup line — SIGKILLs every recorded server of THIS worker, after checking
// that the pid still runs that dir's fake_serve.mjs (a recycled pid is never
// touched). Dirs are per-test mkdtemp dirs, so concurrent suites don't collide.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FAKE_SERVE_PID_FILE = "fake_serve.pid";

const registered = new Set<string>();

/** The `#!/bin/sh` shim body for a fake `opencode` binary: record the pid, then
 *  exec the fake server. Registers `dir` for reaping. */
export function fakeServeShim(dir: string, serverMjs: string): string {
  registered.add(dir);
  return `#!/bin/sh\necho $$ > "${join(dir, FAKE_SERVE_PID_FILE)}"\nexec "${process.execPath}" "${serverMjs}" "$@"\n`;
}

function commandOf(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill every fake server registered by this worker. Never throws. */
export async function reapFakeServes(): Promise<void> {
  const killed: number[] = [];
  for (const dir of registered) {
    try {
      const file = join(dir, FAKE_SERVE_PID_FILE);
      if (!existsSync(file)) continue;
      const pid = Number(readFileSync(file, "utf8").trim());
      if (!Number.isInteger(pid) || pid <= 1) continue;
      if (!commandOf(pid).includes(join(dir, "fake_serve.mjs"))) continue; // dead, or pid recycled
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      /* best effort */
    }
  }
  registered.clear();
  const end = Date.now() + 2000;
  while (killed.some(isAlive) && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

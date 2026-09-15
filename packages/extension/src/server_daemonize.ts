import * as cp from "node:child_process";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// ============================================================================
// server_daemonize (#1183, ADR 0020) — double-fork daemonizer.
//
// `detached: true` + `unref()` puts the server in its own process group but
// leaves it a DESCENDANT of the extension host: a VS Code window reload reaps
// it by PID-tree (confirmed live — setsid held, the server still died). This
// module removes the server from that subtree by spawning a short-lived Node
// LAUNCHER that spawns the server `detached` and exits immediately, so the
// server reparents to launchd/init (PPID 1) BEFORE any reload.
//
//   ServerManager ──spawn(pipe)──▶ launcher ──spawn(detached)──▶ opencode serve
//                    reads SERVERPID          exits at once
//                                              ▼
//                              server reparents to PPID 1 (escapes the subtree)
//
// The server PID is what the launcher REPORTS (its own child's pid) — the
// launcher's PID is never persisted. The launcher runs via `process.execPath`
// with ELECTRON_RUN_AS_NODE=1 (portable: macOS + linux-x64/arm64/WSL; no
// `setsid` binary).
// ============================================================================

export interface DaemonizeOpts {
  /** opencode binary name or absolute path (the server). */
  binary: string;
  /** args for the server, e.g. ["serve","--hostname","127.0.0.1","--port","N"]. */
  args: string[];
  /** cwd for the server. */
  cwd: string;
  /** extra env layered onto the launcher's inherited env for the SERVER. */
  env: Record<string, string>;
  /** the server's stdout/stderr sink (its fds are opened by the launcher). */
  logFile: string;
  /** node/electron-as-node runtime for the launcher. Default process.execPath. */
  execPath?: string;
  /** where the launcher script is written. Default dirname(logFile). */
  launcherDir?: string;
}

export interface DaemonizeResult {
  /** the reparented server's PID (the launcher's own child). */
  serverPid: number;
  /** the intermediate launcher's PID (exits immediately; never persisted). */
  launcherPid: number;
}

export interface LauncherInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Seams for freePortIfOurs — injected in tests, real implementations in prod. */
export interface FreePortDeps {
  /** which PID (if any) holds the port. */
  pidOnPort?: (port: number) => number | undefined;
  /** is that PID one of OUR opencode servers (never kill a foreign holder). */
  isOurs?: (pid: number) => boolean;
  /** send a signal to a pid. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** sleep between re-probes. */
  sleep?: (ms: number) => Promise<void>;
}

/** The ESM launcher: spawn the server detached, report its pid, exit at once. */
export const LAUNCHER_SOURCE = [
  `import { spawn } from "node:child_process";`,
  `import { mkdirSync, openSync } from "node:fs";`,
  `import { dirname } from "node:path";`,
  `const binary = process.env.AMICO_LAUNCH_BINARY;`,
  `const args = JSON.parse(process.env.AMICO_LAUNCH_ARGS || "[]");`,
  `const logFile = process.env.AMICO_LAUNCH_LOGFILE;`,
  `const cwd = process.env.AMICO_LAUNCH_CWD || process.cwd();`,
  `const extraEnv = JSON.parse(process.env.AMICO_LAUNCH_ENV || "{}");`,
  `const childEnv = { ...process.env, ...extraEnv };`,
  `for (const k of ["AMICO_LAUNCH_BINARY","AMICO_LAUNCH_ARGS","AMICO_LAUNCH_LOGFILE","AMICO_LAUNCH_CWD","AMICO_LAUNCH_ENV","ELECTRON_RUN_AS_NODE"]) delete childEnv[k];`,
  `mkdirSync(dirname(logFile), { recursive: true });`,
  `const fd = openSync(logFile, "a");`,
  `let errored = false;`,
  `const child = spawn(binary, args, { cwd, env: childEnv, stdio: ["ignore", fd, fd], detached: true });`,
  `child.once("error", (e) => { errored = true; try { process.stdout.write("SPAWNERROR=" + (e && e.message ? e.message : String(e)) + "\\n"); } catch {} process.exit(1); });`,
  `child.unref();`,
  `setTimeout(() => { if (errored) return; if (child.pid) process.stdout.write("SERVERPID=" + child.pid + "\\n"); process.exit(child.pid ? 0 : 1); }, 30);`,
].join("\n");

/** Build the launcher invocation (pure — the S5 smoke check pins this).
 *  The server params ride in env (not argv) so a large OPENCODE_CONFIG_CONTENT
 *  needs no escaping; the launcher-only keys are stripped before the server. */
export function buildLauncherInvocation(opts: DaemonizeOpts): LauncherInvocation {
  const launcherDir = opts.launcherDir ?? dirname(opts.logFile);
  const launcherPath = join(launcherDir, "server_launcher.mjs");
  return {
    command: opts.execPath ?? process.execPath,
    args: [launcherPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      AMICO_LAUNCH_BINARY: opts.binary,
      AMICO_LAUNCH_ARGS: JSON.stringify(opts.args),
      AMICO_LAUNCH_LOGFILE: opts.logFile,
      AMICO_LAUNCH_CWD: opts.cwd,
      AMICO_LAUNCH_ENV: JSON.stringify(opts.env),
    },
  };
}

/** Write the launcher, spawn it (piped so we read SERVERPID), and resolve the
 *  reported server pid. The launcher exits at once → the server reparents to
 *  launchd/init, escaping the extension-host subtree. */
export async function daemonizeSpawn(opts: DaemonizeOpts): Promise<DaemonizeResult> {
  const launcherDir = opts.launcherDir ?? dirname(opts.logFile);
  mkdirSync(launcherDir, { recursive: true });
  const launcherPath = join(launcherDir, "server_launcher.mjs");
  writeFileSync(launcherPath, LAUNCHER_SOURCE);
  const inv = buildLauncherInvocation({ ...opts, launcherDir });
  return await new Promise<DaemonizeResult>((resolve, reject) => {
    const launcher = cp.spawn(inv.command, inv.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...inv.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    launcher.stdout?.on("data", (b: Buffer) => { out += b.toString(); });
    launcher.stderr?.on("data", (b: Buffer) => { err += b.toString(); });
    launcher.once("error", (e) => reject(e));
    launcher.once("exit", () => {
      const m = out.match(/SERVERPID=(\d+)/);
      if (m) {
        resolve({ serverPid: Number(m[1]), launcherPid: launcher.pid ?? -1 });
        return;
      }
      const se = out.match(/SPAWNERROR=(.*)/);
      reject(new Error(
        "daemonize: launcher did not report a server pid" +
        (se ? `: ${se[1].trim()}` : err ? `: ${err.trim()}` : ""),
      ));
    });
  });
}

/** Free the port IFF our opencode server holds it — never a foreign process.
 *  Returns true when the port ends up free (or was already free). The #1178
 *  ours-only kill discipline, applied to stop()'s by-port fallback (D6). */
export async function freePortIfOurs(port: number, deps: FreePortDeps = {}): Promise<boolean> {
  const pidOnPort = deps.pidOnPort ?? defaultPidOnPort;
  const isOurs = deps.isOurs ?? defaultIsOurs;
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const pid = pidOnPort(port);
  if (pid === undefined) return true;   // nothing on the port — already free
  if (!isOurs(pid)) return false;       // foreign holder — NEVER kill

  try { kill(pid, "SIGTERM"); } catch { /* re-probe decides */ }
  for (let i = 0; i < 6; i++) {
    if (pidOnPort(port) === undefined) return true;
    await sleep(250);
  }
  try { kill(pid, "SIGKILL"); } catch { /* re-probe decides */ }
  await sleep(500);
  return pidOnPort(port) === undefined;
}

// ── Production seams (used when FreePortDeps are not injected) ───────────────

/** Which PID (if any) holds the port, via lsof. */
export function defaultPidOnPort(port: number): number | undefined {
  try {
    const out = execSync(`lsof -ti :${port}`, { timeout: 5000 }).toString().trim();
    const first = out.split("\n")[0]?.trim();
    return first && /^\d+$/.test(first) ? parseInt(first, 10) : undefined;
  } catch {
    return undefined;
  }
}

/** Is this PID one of OUR opencode servers? Reads its command line. */
export function defaultIsOurs(pid: number): boolean {
  try {
    const cmd = execSync(`ps -o command= -p ${pid}`, { timeout: 5000 }).toString().trim();
    return /opencode/.test(cmd) && /serve/.test(cmd);
  } catch {
    return false;
  }
}

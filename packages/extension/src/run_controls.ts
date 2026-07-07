import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

// ============================================================================
// Run controls — file-op helpers behind the Run Inspector's Stop / Save pulse
// buttons. Pure enough to unit-test; VSCode wiring lives in extension.ts.
// ============================================================================

/** Request a cooperative stop: the solve template's per-iter callback polls for
 *  this file (in its cwd == the run dir) and returns false to halt Ipopt. */
export function writeStopFile(runDir: string): void {
  fs.writeFileSync(path.join(runDir, "STOP"), "");
}

// ----------------------------------------------------------------------------
// Stop escalation — cooperative stop only works while a solver is alive to poll
// the STOP file. A wedged run (OOM-killed Julia, dead orchestrator) never
// consumes it and never writes FINISHED, so it sits "stalled" forever with a
// Stop button that does nothing. These helpers make Stop always terminate:
// plan → (kill any live solver) → force-write the terminal FINISHED sentinel.
// ----------------------------------------------------------------------------

/** Same threshold as the stalled displays (runs_manager.liveStatus, the fork's
 *  isStalled): a FINISHED-less run whose log has been silent this long is dead. */
export const STALL_AFTER_MS = 10 * 60 * 1000;

/** run.log mtime, or undefined before the log exists. */
export function runLogMtime(runDir: string): number | undefined {
  try { return fs.statSync(path.join(runDir, "run.log")).mtimeMs; } catch { return undefined; }
}

/** What stopping this run requires right now: nothing (already terminal), the
 *  cooperative STOP file, or the hard kill-and-finalize path. A run with no
 *  run.log yet is judged by run-dir age (never-started zombie vs. warming up). */
export function stopPlan(runDir: string, now = Date.now()): "already-finished" | "cooperative" | "force" {
  if (fs.existsSync(path.join(runDir, "FINISHED"))) return "already-finished";
  const logMtime = runLogMtime(runDir);
  if (logMtime !== undefined) return now - logMtime > STALL_AFTER_MS ? "force" : "cooperative";
  try {
    return now - fs.statSync(runDir).mtimeMs > STALL_AFTER_MS ? "force" : "cooperative";
  } catch {
    return "force"; // run dir itself gone-ish — nothing to cooperate with
  }
}

/** The run's solve script from run.toml (regex, not a TOML parse — one known
 *  key on its own line, written by amico-run). Undefined if unreadable. */
export function runScriptPath(runDir: string): string | undefined {
  try {
    const m = /^script_path\s*=\s*"(.+)"\s*$/m.exec(fs.readFileSync(path.join(runDir, "run.toml"), "utf8"));
    return m?.[1];
  } catch {
    return undefined;
  }
}

/** PIDs belonging to THIS run: command line references the run's solve script
 *  (or the run dir itself) AND the process cwd is the run dir. The two-key
 *  match is the safety property — sibling runs of the same problem share the
 *  script path but never the cwd, and nothing unrelated lives in a run dir.
 *  NEVER kill on a bare pattern match (a broad pkill once took out the user's
 *  main editor). Exec is injectable for tests. */
export function findRunPids(
  runDir: string,
  scriptPath: string | undefined,
  exec: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }),
): number[] {
  let psOut = "";
  try { psOut = exec("/bin/ps", ["-A", "-o", "pid=,args="]); } catch { return []; }
  const candidates: number[] = [];
  for (const line of psOut.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const args = m[2];
    if ((scriptPath && args.includes(scriptPath)) || args.includes(runDir)) candidates.push(Number(m[1]));
  }
  return candidates.filter((pid) => {
    if (pid === process.pid) return false;
    try {
      // lsof -Fn prints the cwd as a line starting with "n"
      const out = exec("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
      return out.split("\n").some((l) => l.startsWith("n") && path.resolve(l.slice(1)) === path.resolve(runDir));
    } catch {
      return false; // can't prove it's ours → don't kill it
    }
  });
}

/** Force-write the terminal FINISHED sentinel (run-dir contract sub-shape:
 *  status + exit_code only, additionalProperties false). Atomic via rename so
 *  no reader ever sees a torn FINISHED. A breadcrumb goes to run.log for
 *  humans; FINISHED itself must stay schema-clean. */
export function forceFinalize(runDir: string): void {
  const tmp = path.join(runDir, ".FINISHED.tmp");
  fs.writeFileSync(tmp, 'status = "aborted"\nexit_code = -1\n');
  fs.renameSync(tmp, path.join(runDir, "FINISHED"));
  try {
    fs.appendFileSync(path.join(runDir, "run.log"), "\nAMICODE_ABORTED force-stopped by user (solver not responding)\n");
  } catch { /* log breadcrumb is best-effort */ }
}

/** The hard path: TERM any live solver process provably tied to this run dir,
 *  give it a beat, KILL survivors, then finalize the run dir as aborted so
 *  every contract reader (extension + fork endpoints) converges. Safe on a
 *  fully dead run — the pid scan just comes back empty. */
export async function forceStop(runDir: string): Promise<void> {
  const pids = findRunPids(runDir, runScriptPath(runDir));
  for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  if (pids.length > 0) {
    await new Promise((r) => setTimeout(r, 1500));
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* exited on TERM */ } }
  }
  forceFinalize(runDir);
}

/** Copy the run's pulse.jld2 to an absolute destination path. */
export function savePulseTo(runDir: string, dest: string): void {
  const src = path.join(runDir, "pulse.jld2");
  if (!fs.existsSync(src)) throw new Error("no pulse.jld2 in the run dir yet");
  fs.copyFileSync(src, dest);
}

/** The team-vault catalog pulses dir if the mount is present, else undefined
 *  (so the Save-pulse quick-pick hides the catalog option when unmounted). */
export function catalogPulsesDir(home = process.env.HOME ?? ""): string | undefined {
  const d = path.join(home, ".amico", "vaults", "armonissima", "catalog", "pulses");
  return fs.existsSync(d) ? d : undefined;
}

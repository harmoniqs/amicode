// Healthcheck (the real `amicode.healthcheck` command). Verifies the four
// things a working install needs — the managed Julia toolchain (Piccolo loads),
// the opencode TUI binary (symlink at ~/.local/bin/opencode), the opencode
// server, and an LLM provider — and reports a summary. Ported from the
// dev-only scripts/healthcheck.mjs (which isn't shipped in the vsix), so an
// installed user has an actual "did my setup work?" button. Pure formatting +
// an async command probe (no execFileSync — a `using Piccolo` precompile can
// take minutes and must never block the extension host).
import { spawn } from "node:child_process";
import { lstatSync, readlinkSync, accessSync, constants } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface HealthResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Elapsed probe time, ms (optional; appended to the log line). */
  ms?: number;
  /** Captured probe output (stdout+stderr tail). Logged on failure (#19) so a
   *  failed check is diagnosable — not just "exit N". */
  log?: string;
}

const OUTPUT_CAP = 4000; // bytes of probe output retained (enough to see the error, bounded so a runaway can't flood the channel)

/** Run a command to completion with a timeout. Resolves ok=exit-0; never throws
 *  (spawn errors + timeouts resolve to ok:false). Captures stdout+stderr (capped)
 *  so callers can log WHY a probe failed. Injectable spawn for tests. */
export function probeCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn,
): Promise<{ ok: boolean; code: number | null; err?: string; output: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let stderr = "";
    const append = (buf: Buffer | string) => {
      if (output.length >= OUTPUT_CAP) return;
      output += buf.toString();
      if (output.length > OUTPUT_CAP) output = `${output.slice(0, OUTPUT_CAP)}\n…(truncated)`;
    };
    const finish = (r: { ok: boolean; code: number | null; err?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...r, output: output.trim() });
    };
    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ ok: false, code: null, err: (e as Error).message, output: "" });
      return;
    }
    child.stdout?.on("data", append);
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, err: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      append(chunk);
      if (stderr.length < 8192) stderr += chunk.slice(0, 8192 - stderr.length);
    });
    child.on("error", (e: Error) => finish({ ok: false, code: null, err: e.message }));
    // `close` (not `exit`): fires after the piped stdout/stderr have drained, so
    // `output` is fully captured before we resolve.
    child.on("close", (code: number | null) => {
      const firstErrorLine = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      finish({ ok: code === 0, code, err: code === 0 ? undefined : firstErrorLine });
    });
  });
}

/** Format results into a one-line summary + per-check log lines. A failed check
 *  that carries captured output gets it appended (indented `|`), so the log is
 *  actionable rather than just "exit N". */
export function formatHealthReport(results: HealthResult[]): { allOk: boolean; summary: string; lines: string[] } {
  const allOk = results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines: string[] = [];
  for (const r of results) {
    const timing = r.ms != null ? `  (${r.ms}ms)` : "";
    lines.push(`${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.detail}${timing}`);
    if (!r.ok && r.log) {
      for (const l of r.log.split("\n")) {
        if (l.trim() !== "") lines.push(`  | ${l}`);
      }
    }
  }
  const summary = allOk
    ? "Amicode healthcheck: all systems go."
    : `Amicode healthcheck: ${failed.length} issue(s) — ${failed.map((r) => r.name).join(", ")}.`;
  return { allOk, summary, lines };
}

// ---------------------------------------------------------------------------
// opencode TUI probe (#565): verify ~/.local/bin/opencode symlink is healthy.
// Synchronous, never throws — all FS errors caught and reported as FAIL.
// ---------------------------------------------------------------------------

const FIX_HINT = "Run the install script or re-activate the extension";

/** Injectable FS subset for testability. */
export interface TuiProbeFs {
  lstatSync: (p: string) => { isSymbolicLink?: () => boolean };
  readlinkSync: (p: string) => string;
  accessSync: (p: string, mode?: number) => void;
}

const defaultFs: TuiProbeFs = {
  lstatSync: (p) => lstatSync(p),
  readlinkSync: (p) => readlinkSync(p),
  accessSync: (p, mode) => accessSync(p, mode),
};

/** The symlink path this probe validates. */
function tuiSymlinkPath(): string {
  return path.join(os.homedir(), ".local", "bin", "opencode");
}

/**
 * Probe the `~/.local/bin/opencode` symlink. Returns a HealthResult:
 * - OK + resolved target path when the symlink exists, resolves, and the target is executable.
 * - FAIL + actionable fix hint otherwise.
 *
 * Synchronous and never throws.
 */
export function probeOpencodeTui(fsImpl: TuiProbeFs = defaultFs): HealthResult {
  const name = "opencode TUI";
  const link = tuiSymlinkPath();

  try {
    // Step 1: does the symlink itself exist?
    try {
      fsImpl.lstatSync(link);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        return { name, ok: false, detail: `symlink not found at ${link} — ${FIX_HINT}` };
      }
      return { name, ok: false, detail: `cannot stat ${link}: ${e?.message ?? e} — ${FIX_HINT}` };
    }

    // Step 2: read the symlink target
    let target: string;
    try {
      target = fsImpl.readlinkSync(link);
    } catch (e: any) {
      return { name, ok: false, detail: `cannot read symlink at ${link}: ${e?.message ?? e} — ${FIX_HINT}` };
    }

    // Step 3: is the target accessible and executable?
    try {
      fsImpl.accessSync(target, constants.X_OK);
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        return { name, ok: false, detail: `dangling symlink — target does not exist: ${target} — ${FIX_HINT}` };
      }
      if (e?.code === "EACCES") {
        return { name, ok: false, detail: `target not executable: ${target} — ${FIX_HINT}` };
      }
      return { name, ok: false, detail: `cannot verify target ${target}: ${e?.message ?? e} — ${FIX_HINT}` };
    }

    // All checks passed
    return { name, ok: true, detail: target };
  } catch (e: any) {
    // Outer safety net — should never reach here, but the contract is "never throws"
    return { name, ok: false, detail: `unexpected error: ${e?.message ?? e} — ${FIX_HINT}` };
  }
}

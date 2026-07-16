// Healthcheck (the real `amicode.healthcheck` command). Verifies the three
// things a working install needs — the managed Julia toolchain (Piccolo loads),
// the opencode server, and an LLM provider — and reports a summary. Ported from
// the dev-only scripts/healthcheck.mjs (which isn't shipped in the vsix), so an
// installed user has an actual "did my setup work?" button. Pure formatting +
// an async command probe (no execFileSync — a `using Piccolo` precompile can
// take minutes and must never block the extension host).
import { spawn } from "node:child_process";

export interface HealthResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Run a command to completion with a timeout. Resolves ok=exit-0; never throws
 *  (spawn errors + timeouts resolve to ok:false). Injectable spawn for tests. */
export function probeCommand(
  cmd: string,
  args: string[],
  timeoutMs: number,
  spawnImpl: typeof spawn = spawn,
): Promise<{ ok: boolean; code: number | null; err?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { ok: boolean; code: number | null; err?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawnImpl>;
    try {
      child = spawnImpl(cmd, args, { stdio: "ignore" });
    } catch (e) {
      resolve({ ok: false, code: null, err: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish({ ok: false, code: null, err: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e: Error) => finish({ ok: false, code: null, err: e.message }));
    child.on("exit", (code: number | null) => finish({ ok: code === 0, code }));
  });
}

/** Format results into a one-line summary + per-check lines. */
export function formatHealthReport(results: HealthResult[]): { allOk: boolean; summary: string; lines: string[] } {
  const allOk = results.every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = results.map((r) => `${r.ok ? "OK  " : "FAIL"} ${r.name}: ${r.detail}`);
  const summary = allOk
    ? "Amicode healthcheck: all systems go."
    : `Amicode healthcheck: ${failed.length} issue(s) — ${failed.map((r) => r.name).join(", ")}.`;
  return { allOk, summary, lines };
}

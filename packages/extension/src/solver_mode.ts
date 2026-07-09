import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { amicodeOpsDir } from "./substrate/vault_store";

// ============================================================================
// Solver mode — the extension half of the solver-mode.json contract (the fork
// half is packages/opencode/src/server/amicode/solver-mode.ts; change both in
// one change-set). The app's toggle POSTs {mode, status:"switching"}; WE do
// the real switch — grant/revoke the `issimo` entitlement, re-prep the session
// config, restart the opencode server — and only then write status:"ready".
// The entitlement path is deliberate: it exercises the SAME machinery a paid
// subscription will use (packageAllowlist → agent + amico-run import scan).
// ============================================================================

export type SolverMode = "piccolo" | "hp";
export interface SolverModeState {
  mode: SolverMode;
  status: "ready" | "switching";
}

export function solverModeFile(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "solver-mode.json");
}

export function readSolverModeState(file: string = solverModeFile()): SolverModeState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { mode?: unknown; status?: unknown };
    return {
      mode: parsed.mode === "hp" ? "hp" : "piccolo",
      status: parsed.status === "switching" ? "switching" : "ready",
    };
  } catch {
    return { mode: "piccolo", status: "ready" };
  }
}

export function writeSolverModeReady(mode: SolverMode, file: string = solverModeFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mode, status: "ready", switched_at: new Date().toISOString() }));
}

/** Grant (hp) or revoke (piccolo) the `issimo` entitlement, PRESERVING any
 *  other codes in entitlements.toml (a real license file may carry more). */
export function applyEntitlementForMode(mode: SolverMode, entitlementsDir: string): { codes: string[] } {
  const file = path.join(entitlementsDir, "entitlements.toml");
  let codes: string[] = [];
  let expired: string[] = [];
  try {
    const parsed = parseToml(fs.readFileSync(file, "utf8")) as { codes?: string[]; expired?: string[] };
    codes = Array.isArray(parsed.codes) ? parsed.codes.filter((c) => typeof c === "string") : [];
    expired = Array.isArray(parsed.expired) ? parsed.expired.filter((c) => typeof c === "string") : [];
  } catch {
    /* absent/corrupt → start empty */
  }
  codes = codes.filter((c) => c !== "issimo");
  if (mode === "hp") codes.push("issimo");
  fs.mkdirSync(entitlementsDir, { recursive: true });
  const lines = [`codes = [${codes.map((c) => JSON.stringify(c)).join(", ")}]`];
  if (expired.length > 0) lines.push(`expired = [${expired.map((c) => JSON.stringify(c)).join(", ")}]`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return { codes };
}

/** Poll-based watcher (fs.watch is unreliable for rewrite-in-place): fires
 *  onSwitch once per switching-request. The busy latch guarantees a slow
 *  switch is never re-entered by the next tick. */
export function watchSolverMode(
  onSwitch: (mode: SolverMode) => Promise<void>,
  file: string = solverModeFile(),
  intervalMs = 1000,
): { dispose(): void } {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const state = readSolverModeState(file);
    if (state.status !== "switching") return;
    busy = true;
    void onSwitch(state.mode)
      .then(() => writeSolverModeReady(state.mode, file))
      .catch(() => {
        // Failed switch: report ready-at-PREVIOUS-mode is a lie we can't tell
        // (we don't know it), so settle at the requested mode anyway — config
        // may be partially applied; the toast in extension.ts says what failed.
        writeSolverModeReady(state.mode, file);
      })
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  return {
    dispose() {
      clearInterval(timer);
    },
  };
}

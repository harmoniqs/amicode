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

/** Is the `issimo` entitlement granted — i.e. is the Piccolissimo + Altissimo
 *  tier actually active?
 *
 *  This is the DURABLE record of the tier, and a self-cleaning one: the only
 *  writer is applyEntitlementForMode, which grants on hp and REVOKES on piccolo.
 *  solver-mode.json, by contrast, only changes when someone posts a
 *  `status:"switching"` request, so it can sit stale while the entitlement is
 *  right — observed on 2026-08-05, where the file read `piccolo` (dated Jul 28)
 *  with issimo granted, a live cloud.json, and a connected Harmoniqs Cloud. Every
 *  cloud decision keys off that file, so the whole tier silently reverted to
 *  local: no HP guidance, a template staged for IPOPT, and no cloud promotion. */
export function issimoGranted(entitlementsDir: string = amicodeOpsDir()): boolean {
  try {
    const parsed = parseToml(fs.readFileSync(path.join(entitlementsDir, "entitlements.toml"), "utf8")) as {
      codes?: unknown;
    };
    return Array.isArray(parsed.codes) && parsed.codes.includes("issimo");
  } catch {
    return false; // absent/corrupt → not entitled, so we fail toward the free local tier
  }
}

/** The mode the rest of the extension must act on: hp if EITHER signal says so.
 *
 *  OR, not AND, and deliberately: the two signals disagree only when the switch
 *  handshake half-landed, and of the two failure directions, "the user paid for
 *  the cloud tier and silently got a local IPOPT solve" is far worse than "a
 *  revoked user is told to connect". A user who genuinely wants local switches to
 *  Piccolo, which revokes the entitlement, so both signals agree again. */
export function effectiveSolverMode(
  file: string = solverModeFile(),
  entitlementsDir: string = amicodeOpsDir(),
): SolverMode {
  return readSolverModeState(file).mode === "hp" || issimoGranted(entitlementsDir) ? "hp" : "piccolo";
}

/** Bring solver-mode.json back in line with the entitlement at activation.
 *
 *  effectiveSolverMode() keeps the EXTENSION correct on its own, but the file is
 *  a shared contract: the app's solver toggle renders from it (so a stale file
 *  shows "Piccolo" selected while the user is on the paid tier), and amico-run
 *  reads it directly. Healing it once at boot fixes every reader at the source
 *  instead of teaching each one the same OR. Returns what it did, for the log —
 *  a heal means the switch handshake dropped a write, which is worth knowing. */
export function reconcileSolverMode(
  file: string = solverModeFile(),
  entitlementsDir: string = amicodeOpsDir(),
): { healed: boolean; mode: SolverMode } {
  const onDisk = readSolverModeState(file);
  const mode = effectiveSolverMode(file, entitlementsDir);
  // Never touch a switch in flight — the watcher owns that write.
  if (onDisk.status === "switching" || onDisk.mode === mode) return { healed: false, mode };
  writeSolverModeReady(mode, file);
  return { healed: true, mode };
}

// NOTE: there is deliberately NO extension-side "write {status:switching}"
// helper anymore. Switch requests come from the fork server (the app's toggle
// POST, and the connections credential route's HP flip — #167); the extension
// only WATCHES for them (watchSolverMode) and answers with writeSolverModeReady.
// amicode.setCloudKey used to own such a helper — it re-pointed onto the
// connections seam (#171), so a second client-side flip writer would be the
// exact duplicate-flip bug ADR 0001 forbids.

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

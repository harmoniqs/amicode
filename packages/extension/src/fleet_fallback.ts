// Fleet Local fallback — deliberate, user-invoked escape hatch per CONTEXT.md.
// A fleet client whose canonical is unreachable (mini offline / tunnel down) can
// enter fallback: the guard is bypassed, the panel spawns a local opencode
// server (standalone) and continues working. Sessions made during fallback are
// local-only; Rejoin (on reconnect) ships the shard to the canonical for the
// single-writer merge (ADR 0005). Fallback is machine-scoped, never synced, and
// always visible.
//
// Marker: ~/.amico/ops/fleet/fallback.json
//   { active: true, since: ISO, reason?: string, previousBinary?: string, previousPort?: number }
// The guard checks for this file before its `exit 1` — if present, it falls
// through to exec (frozen/VSIX/dev). The extension's fleet_health skips
// guard/settings/tunnel drift while fallback is active and reports fallback
// state instead (so healthcheck doesn't red on intentional drift).

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export const FALLBACK_DIR = path.join(homedir(), ".amico", "ops", "fleet");
export const FALLBACK_PATH = path.join(FALLBACK_DIR, "fallback.json");

export interface FallbackState {
  active: true;
  since: string; // ISO
  reason?: string;
  previousBinary?: string;
  previousPort?: number;
}

export function fallbackPath(customDir?: string): string {
  return customDir ? path.join(customDir, "fallback.json") : FALLBACK_PATH;
}

export function isFallbackActive(p: string = FALLBACK_PATH, read: (path: string) => string = (pp) => fs.readFileSync(pp, "utf8")): boolean {
  try {
    const raw = read(p);
    const j = JSON.parse(raw) as FallbackState;
    return j.active === true;
  } catch {
    return false;
  }
}

export function readFallback(p: string = FALLBACK_PATH): FallbackState | null {
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8")) as FallbackState;
    if (j.active === true && typeof j.since === "string") return j;
    return null;
  } catch {
    return null;
  }
}

export function enterFallback(opts: { reason?: string; previousBinary?: string; previousPort?: number; path?: string } = {}): FallbackState {
  const p = opts.path ?? FALLBACK_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const state: FallbackState = {
    active: true,
    since: new Date().toISOString(),
    reason: opts.reason,
    previousBinary: opts.previousBinary,
    previousPort: opts.previousPort,
  };
  // atomic write: tmp + rename
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, p);
  return state;
}

export function exitFallback(p: string = FALLBACK_PATH): FallbackState | null {
  const prev = readFallback(p);
  try {
    fs.unlinkSync(p);
  } catch {
    // already gone
  }
  // clean empty dir (best-effort)
  try {
    if (fs.existsSync(FALLBACK_DIR) && fs.readdirSync(FALLBACK_DIR).length === 0) fs.rmdirSync(FALLBACK_DIR);
  } catch {}
  return prev;
}

export function fallbackStatusLabel(state: FallbackState | null): string {
  if (!state) return "Fleet: canonical (tunnel)";
  const age = (() => {
    try {
      const ms = Date.now() - new Date(state.since).getTime();
      const m = Math.round(ms / 60000);
      if (m < 1) return "just now";
      if (m === 1) return "1m";
      if (m < 60) return `${m}m`;
      const h = Math.round(m / 60);
      return `${h}h`;
    } catch { return ""; }
  })();
  return `Fleet: LOCAL FALLBACK${age ? ` (${age})` : ""} — sessions local, rejoin on reconnect`;
}

import * as fs from "node:fs";
import * as path from "node:path";
import { amicodeOpsDir } from "./substrate/vault_store";
import type { HarnessMenu } from "./harness";

// ============================================================================
// Harness switch — the extension half of the harness.json contract (the fork
// half is the engine's server/amicode/harness.ts; change both in one
// change-set). The app's composer control POSTs {harness} to
// /amicode/harness; the engine route writes {harness, status:"switching"} to
// the ops dir; WE do the real switch — the registry gate (decideHarnessSwitch),
// the `amicode.harness` setting persist, the server restart — and only then
// settle status:"ready", at the harness that ACTUALLY took effect. Mirrors
// solver_mode.ts's watcher discipline (poll + busy latch); the difference is
// honest refusal: a blocked switch settles ready at the harness that is still
// current, never at the one that was refused.
// ============================================================================

export interface HarnessSwitchState {
  harness: string;
  status: "ready" | "switching";
}

export function harnessSwitchFile(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "harness.json");
}

export function harnessOptionsFile(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "harness-options.json");
}

/** Tolerant {harness, status} read — the solver-mode reader's semantics:
 *  anything absent/off-shape collapses to opencode/ready. */
export function readHarnessSwitchState(file: string = harnessSwitchFile()): HarnessSwitchState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { harness?: unknown; status?: unknown };
    return {
      harness: typeof parsed.harness === "string" && parsed.harness !== "" ? parsed.harness : "opencode",
      status: parsed.status === "switching" ? "switching" : "ready",
    };
  } catch {
    return { harness: "opencode", status: "ready" };
  }
}

/** Settle the handshake: status:"ready" at the harness that ACTUALLY took
 *  effect. On a refused or failed switch the caller passes the still-current
 *  harness — a ready file claiming a switch that didn't happen is the lie we
 *  don't tell. */
export function writeHarnessReady(harness: string, file: string = harnessSwitchFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ harness, status: "ready", switched_at: new Date().toISOString() }));
}

/** Publish the registry menu for the engine's GET /amicode/harness — the ONE
 *  serialization (harnessMenu) the composer control renders. Written at boot
 *  and after every successful switch; the engine only ever SERVES it, never
 *  computes it (the registry lives here). */
export function writeHarnessOptionsFile(menu: HarnessMenu, file: string = harnessOptionsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(menu));
}

/** Poll-based watcher (the watchSolverMode idiom): fires onSwitch once per
 *  switching-request; the busy latch guarantees a slow switch is never
 *  re-entered by the next tick. onSwitch RETURNS the harness to settle ready
 *  at — the requested one on success, the still-current one on a refusal or
 *  failure. */
export function watchHarnessSwitch(
  onSwitch: (harness: string) => Promise<string>,
  file: string = harnessSwitchFile(),
  intervalMs = 1000,
): { dispose(): void } {
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    const state = readHarnessSwitchState(file);
    if (state.status !== "switching") return;
    busy = true;
    void onSwitch(state.harness)
      .then((settled) => writeHarnessReady(settled, file))
      .catch(() => {
        // A throwing switch leaves the setting unchanged, so the honest
        // settle is the default the file would read anyway.
        writeHarnessReady("opencode", file);
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

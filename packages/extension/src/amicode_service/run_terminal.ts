// AMICODE SERVICE (#451): terminal-state semantics for the run-dir contract.
// Ported VERBATIM from the fork's run-terminal.ts @ v1.18.10-amicode.11 — a
// documented MIRROR of amicode's canonical reader
// (packages/extension/src/run_dir_reader.ts, readTerminalState). ONE-SPINE
// RULE (amicode #84): the run-dir contract has a single terminal semantic,
// and every consumer — the extension's RunsManager AND the service's
// run-status/run-series routes — must agree on it:
//
//   * FINISHED (written by the amico CLI, the orchestrator) is the ONLY terminal
//     authority. Script output (e.g. the DONE line) never decides status.
//   * FINISHED's `status` field decides the outcome; a missing/torn/mid-write
//     FINISHED is NOT terminal — callers keep polling (never latch "failed"
//     off a read race).
//   * A cooperative user-stop exits 0 → FINISHED says "completed"; the
//     AMICODE_STOPPED marker relabels it "stopped" so no surface reads a
//     user-stop as a genuine convergence (and nothing promotes it).
//   * Fidelity comes only from result.toml, and only when status is completed.
//
// If you change semantics here, change readTerminalState in amicode too.
// (This copy carries `iterations`, which the canonical reader omits — parity
// with the fork's route payloads is the contract here; consolidating the two
// readers is a deliberate follow-up, never a silent behavior change.)

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

export interface TerminalState {
  status: "completed" | "stopped" | "failed" | "aborted"
  fidelity: number | null
  iterations: number | null
}

function tomlScalar(text: string, key: string): number | null {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*([0-9eE+.\\-]+)\\s*$`, "m"))
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

function tomlString(text: string, key: string): string | null {
  const m = text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"))
  return m ? m[1] : null
}

/** undefined = not terminal yet (no FINISHED, or torn/invalid mid-write) —
 *  keep polling; never report failed off a read race. */
export function readTerminalState(dir: string, log?: string): TerminalState | undefined {
  const fp = path.join(dir, "FINISHED")
  if (!existsSync(fp)) return undefined
  let finished: string
  try {
    finished = readFileSync(fp, "utf8")
  } catch {
    return undefined
  }
  const raw = tomlString(finished, "status")
  // MIRROR (amicode finished.schema.json): the FINISHED enum is exactly
  // completed|failed|aborted — "stopped" only ever arises via the
  // AMICODE_STOPPED relabel below, never as a raw FINISHED value. Accepting a
  // raw "stopped" here was drift: the canonical reader treats it as torn.
  if (raw !== "completed" && raw !== "failed" && raw !== "aborted") return undefined
  let status: TerminalState["status"] = raw
  if (status === "completed") {
    const body =
      log ??
      (() => {
        try {
          return readFileSync(path.join(dir, "run.log"), "utf8")
        } catch {
          return ""
        }
      })()
    if (body.includes("AMICODE_STOPPED")) status = "stopped"
  }
  let fidelity: number | null = null
  let iterations: number | null = null
  if (status === "completed") {
    try {
      const result = readFileSync(path.join(dir, "result.toml"), "utf8")
      fidelity = tomlScalar(result, "fidelity")
      // MIRROR (amicode result.schema.json): fidelity is bounded 0..1.0001 —
      // an out-of-range scrape must not surface an F the extension refuses.
      if (fidelity !== null && (fidelity < 0 || fidelity > 1.0001)) fidelity = null
      iterations = tomlScalar(result, "iterations")
    } catch {
      /* result.toml absent: completed with no recorded fidelity */
    }
  }
  return { status, fidelity, iterations }
}

/** Contract status → the run window's display vocabulary ("finished" et al). */
export function displayStatus(s: TerminalState["status"]): string {
  return s === "completed" ? "finished" : s
}

// BEGIN run.lock liveness (amicode#2055) — IDENTICAL in both run-terminal files;
// test/run_liveness_lockstep.test.ts fails if the two copies drift.
//
// <runDir>/run.lock is written by the orchestrator (slice A, #2045): JSON with
// `heartbeat_at` (ISO 8601, refreshed every 30 s) and `ended` (true in the same
// atomic write that precedes FINISHED). A run is DEAD iff the lock exists AND
// FINISHED does not (callers check readTerminalState first — FINISHED always
// wins) AND ended !== true AND the heartbeat is older than 90 s (3 missed
// beats). No lock, or an unreadable/torn lock ⇒ NOT dead: legacy behaviour
// (stalled after 10 min of cold run.log) applies byte-for-byte.
export const DEAD_AFTER_MS = 90 * 1000

export function isDead(dir: string, now: number = Date.now()): boolean {
  const fp = path.join(dir, "run.lock")
  if (!existsSync(fp)) return false
  let lock: { heartbeat_at?: unknown; ended?: unknown }
  try {
    lock = JSON.parse(readFileSync(fp, "utf8"))
  } catch {
    return false
  }
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) return false
  if (lock.ended === true) return false
  if (typeof lock.heartbeat_at !== "string") return false
  const beat = Date.parse(lock.heartbeat_at)
  if (!Number.isFinite(beat)) return false
  return now - beat > DEAD_AFTER_MS
}
// END run.lock liveness

// BEGIN verification pending (amicode#2056) — IDENTICAL in both run-terminal files;
// test/run_liveness_lockstep.test.ts fails if the two copies drift.
//
// Slice A (#2045) writes <runDir>/verification.toml as a pending marker
// (`agree = false`, `pending = true`, `reason = "pending"`) BEFORE FINISHED on
// free-tier local runs; the real verification replaces it WITHOUT `pending`.
// The marker is NOT a disagreement: it reads as `pending_verification`
// (never "suppressed"), and only a bare boolean `pending = true` is the marker
// (a string, `false`, or a missing key is a final verification, read as before).
// Liveness is independent: a pending run that is also dead still reports status "dead".
export function isVerificationPending(dir: string): boolean {
  try {
    return /^pending\s*=\s*true\s*(?:#.*)?$/m.test(readFileSync(path.join(dir, "verification.toml"), "utf8"))
  } catch {
    return false
  }
}
// END verification pending

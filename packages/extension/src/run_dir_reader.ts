import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { validateManifest, validateFinished, validateResult } from "@amicode/amico-run";
import type { RunStatus } from "./types";

// ============================================================================
// Pure (vscode-free) reader for the β.1 run-dir contract. Unit-testable in
// isolation; the vscode-coupled RunsManager (runs_manager.ts) consumes it.
// ============================================================================

// Float group accepts Julia's @printf %e output incl. Inf/-Inf/NaN, so stagnation
// and blow-up iters aren't silently dropped (they're what a researcher most wants
// to see) — matching amico-run's own classifier, which keeps them.
const NUM = String.raw`-?(?:Inf|NaN|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)`;
export const AMICODE_ITER_RE = new RegExp(
  String.raw`^AMICODE_ITER\s+iter=(\d+)\s+f=(${NUM})\s+inf_pr=(${NUM})\s+inf_du=(${NUM})\s*$`,
);
/** Parse an AMICODE_ITER numeric field, mapping Julia's Inf/NaN to JS values. */
export function parseAmicoNum(s: string): number {
  if (s === "Inf") return Infinity;
  if (s === "-Inf") return -Infinity;
  if (s === "NaN" || s === "-NaN") return NaN;
  return Number(s);
}

// ---------------------------------------------------------------------------
// Pulse-line grammar (#66) — additive lines in the run.log stdout tee feeding
// client-side pulse rendering. Labels are double-quoted strings excluding
// quotes and commas; bounds are lo:hi pairs, one per drive.
// ---------------------------------------------------------------------------

export const AMICODE_PULSE_META_RE = new RegExp(
  String.raw`^AMICODE_PULSE_META\s+drives=(\d+)\s+knots=(\d+)\s+labels=((?:"[^",]*")(?:,"[^",]*")*)\s+bounds=(${NUM}:${NUM}(?:,${NUM}:${NUM})*)\s*$`,
);

export interface PulseMeta { drives: number; knots: number; labels: string[]; bounds: [number, number][] }

/** Parse an AMICODE_PULSE_META line. Returns undefined for anything malformed. */
export function parsePulseMetaLine(line: string): PulseMeta | undefined {
  const m = AMICODE_PULSE_META_RE.exec(line);
  if (!m) return undefined;
  const labels = [...m[3].matchAll(/"([^",]*)"/g)].map((x) => x[1]);
  const bounds = m[4].split(",").map((pair) => {
    const [lo, hi] = pair.split(":");
    return [parseAmicoNum(lo), parseAmicoNum(hi)] as [number, number];
  });
  return { drives: parseInt(m[1], 10), knots: parseInt(m[2], 10), labels, bounds };
}

export const AMICODE_PULSE_RE = new RegExp(
  String.raw`^AMICODE_PULSE\s+iter=(\d+)\s+dt=(${NUM})\s+a=(${NUM}(?:,${NUM})*(?:;${NUM}(?:,${NUM})*)*)\s*$`,
);

export interface PulseRecord { iter: number; dt: number; values: number[][] }

/** Parse an AMICODE_PULSE record line. Returns undefined for anything malformed. */
export function parsePulseRecordLine(line: string): PulseRecord | undefined {
  const m = AMICODE_PULSE_RE.exec(line);
  if (!m) return undefined;
  const values = m[3].split(";").map((drive) => drive.split(",").map(parseAmicoNum));
  return { iter: parseInt(m[1], 10), dt: parseAmicoNum(m[2]), values };
}

export type PulseEvent =
  | { type: "meta"; meta: PulseMeta }
  | { type: "record"; record: PulseRecord };

/** Cross-line policy for the pulse stream — the single gate BOTH delivery
 *  paths (replay ingest, live tail) feed lines through. Policy (#66 AC4):
 *  records before any meta are dropped (nothing to interpret them against);
 *  the LAST meta wins (duplicate metas are expected — the tailer re-reads from
 *  offset 0 on truncation) and its shape governs subsequent records; records
 *  whose drive/knot counts disagree with the governing meta are ignored; a
 *  meta whose own label/bounds counts disagree with drives= is malformed and
 *  changes nothing. */
export class PulseStream {
  private meta?: PulseMeta;

  /** Arm the stream with an externally-delivered meta (replay ingest runs its
   *  own stream; the live sink re-arms from the forwarded meta event so tailed
   *  records that follow a replayed meta still have a governing shape). */
  arm(meta: PulseMeta): void {
    this.meta = meta;
  }

  /** Feed one run.log line; returns a routable event or undefined (non-pulse
   *  lines, malformed lines, and policy-dropped records). */
  onLine(line: string): PulseEvent | undefined {
    const meta = parsePulseMetaLine(line);
    if (meta) {
      if (meta.labels.length !== meta.drives || meta.bounds.length !== meta.drives) return undefined;
      this.meta = meta;
      return { type: "meta", meta };
    }
    const record = parsePulseRecordLine(line);
    if (record) {
      if (!this.meta) return undefined;   // record before meta — nothing to interpret it against
      if (record.values.length !== this.meta.drives) return undefined;
      if (record.values.some((d) => d.length !== this.meta!.knots)) return undefined;
      return { type: "record", record };
    }
    return undefined;
  }
}

export interface IterRecord { iter: number; f_val: number; inf_pr: number; inf_du: number }
/** Terminal completion, built by readTerminalState and flowed WHOLE to every
 *  consumer (never exploded into positional args mid-pipe) — the #84 funnel.
 *  Additive contract fields join HERE + readTerminalState and reach all paths
 *  by construction: #81's `formulation?` next, then #64 hashing / #41 usage. */
export interface RunCompletion { runId: string; runDir: string; status: RunStatus; fidelity?: number }
export interface PromoteInfo { runId: string; runDir: string; fidelity: number }

/** Where ingestRunDir routes its findings. The live impl carries the
 *  newest-wins + promote-once guards; the test impl is plain spies. */
export interface RunSink {
  iter(rec: IterRecord): void;
  run(c: RunCompletion): void;
  promote(info: PromoteInfo): void;
  /** Pulse-stream events (#66): a meta or a policy-accepted record. Replay
   *  forwards meta + the NEWEST record only; the live tail forwards each. */
  pulse(e: PulseEvent): void;
}

/** Iteration high-water mark for the live sink — drives the status bar's
 *  "iter N" and the completion record. Pure + vscode-free (unit-testable). */
export class SinkDedup {
  private latestIter = -1;
  /** Record a log-line iter — advances the high-water mark. */
  noteIter(iter: number): void {
    if (iter > this.latestIter) this.latestIter = iter;
  }
  /** Highest iteration seen. */
  get high(): number { return this.latestIter; }
}

export function readTomlSafe(fp: string): Record<string, unknown> | undefined {
  try { return parse(fs.readFileSync(fp, "utf8")) as Record<string, unknown>; }
  catch { return undefined; }
}

/** spec C promote gate: rendering is tier-blind, PROMOTION is not. A `free`-tier
 *  run (solvespec.json tier === "free") can only be promoted once its re-rollout
 *  verification.toml records agree === true — the known optimizer-vs-rollout
 *  divergence must never be promoted on the optimizer's number. Non-free runs
 *  (or runs with no solvespec) are always eligible. "pending_verification" means
 *  the harness hasn't written verification.toml yet (the FINISHED-before-verify
 *  race) — the caller must NOT promote AND must re-check when it lands, never
 *  mark the run permanently un-promotable. */
export type PromoteEligibility = "eligible" | "pending_verification" | "suppressed";
export function promoteEligibility(runDir: string): PromoteEligibility {
  let spec: Record<string, unknown> | undefined;
  try { spec = JSON.parse(fs.readFileSync(path.join(runDir, "solvespec.json"), "utf8")); }
  catch { return "eligible"; }   // no/unreadable spec → a bare run, unchanged behavior
  if (spec?.tier !== "free") return "eligible";
  const verification = readTomlSafe(path.join(runDir, "verification.toml"));
  if (!verification) return "pending_verification";
  return verification.agree === true ? "eligible" : "suppressed";
}

/** True iff the solve halted via the cooperative stop-file. The solver prints
 *  AMICODE_STOPPED only when its Ipopt intermediate callback actually returned
 *  false, so key on the marker — NOT the STOP file's presence, which only proves
 *  the request was made and can race a genuine convergence. Shared by both
 *  completion paths (ingestRunDir here + file_watcher.onFinished). */
export function detectStopped(runDir: string): boolean {
  try {
    return fs.readFileSync(path.join(runDir, "run.log"), "utf8").includes("AMICODE_STOPPED");
  } catch {
    return false;
  }
}

/** Terminal state of a run dir, read + validated in ONE place (review #70 —
 *  the #84 funnel; RunsManager.readTerminal and ingestRunDir both delegate).
 *  Folds the cooperative-stop relabel in: a user-stop exits 0 → FINISHED says
 *  "completed"; relabel to "stopped" (AMICODE_STOPPED marker) so no consumer
 *  reads it as a genuine convergence and promote is skipped by construction.
 *
 *  Returns undefined while FINISHED is absent OR present-but-torn/invalid
 *  (mid-write) — callers retry on their next pass. A present-but-invalid
 *  result.toml is NAMED via `onInvalidResult` (S4). */
export function readTerminalState(
  runDir: string,
  onInvalidResult: (why: string) => void = (why) => console.warn(`[amico] ${why}`),
): { status: RunStatus; fidelity?: number } | undefined {
  const finished = readTomlSafe(path.join(runDir, "FINISHED"));
  if (!finished || !validateFinished(finished).ok) return undefined;
  const rawStatus = finished.status as RunStatus;
  const status: RunStatus = rawStatus === "completed" && detectStopped(runDir) ? "stopped" : rawStatus;
  let fidelity: number | undefined;
  if (status === "completed") {
    const result = readTomlSafe(path.join(runDir, "result.toml"));
    if (result) {
      const v = validateResult(result);
      if (v.ok) fidelity = result.fidelity as number;
      else onInvalidResult(`result.toml present but invalid (${runDir}): ${v.errors.join("; ")}`);
    }
  }
  return { status, fidelity };
}

/** Pure, stateless replay of a run dir against the β.1 contract. Calls each
 *  sink method at most once per relevant artifact. Safe to re-invoke (the live
 *  sink's guards make it idempotent). Returns the number of run.log bytes
 *  consumed, so the live tailer can attach exactly there — no gap (lines
 *  appended after the read are tailed) and no overlap (already-replayed lines). */
export function ingestRunDir(runDir: string, sink: RunSink, promoteThreshold = 0.99): number {
  const manifest = readTomlSafe(path.join(runDir, "run.toml"));
  if (!manifest || !validateManifest(manifest).ok) return 0;   // no valid manifest → not a run dir yet
  const runId = String(manifest.run_id);

  // run.log body → iter records (replay; the live tailer handles appended lines)
  let logBody: string | undefined;
  try { logBody = fs.readFileSync(path.join(runDir, "run.log"), "utf8"); } catch { /* none yet */ }
  let logBytes = 0;
  if (logBody) {
    logBytes = Buffer.byteLength(logBody, "utf8");
    // Pulse replay is newest-wins: a finished run's full history would burst
    // thousands of identical-end-state messages at the webview. Forward the
    // governing meta + the last policy-accepted record only.
    const pulses = new PulseStream();
    let pulseMeta: PulseEvent | undefined;
    let newestPulse: PulseEvent | undefined;
    for (const line of logBody.split("\n")) {
      const m = AMICODE_ITER_RE.exec(line);
      if (m) { sink.iter({ iter: +m[1], f_val: parseAmicoNum(m[2]), inf_pr: parseAmicoNum(m[3]), inf_du: parseAmicoNum(m[4]) }); continue; }
      const e = pulses.onLine(line);
      if (e?.type === "meta") { pulseMeta = e; newestPulse = undefined; }   // new meta governs; stale records don't cross it
      else if (e?.type === "record") newestPulse = e;
    }
    if (pulseMeta) sink.pulse(pulseMeta);
    if (newestPulse) sink.pulse(newestPulse);
  }

  // FINISHED is the authoritative terminal signal — single orchestration point
  // (readTerminalState: status incl. stopped-relabel + fidelity) shared with
  // the manager's finished-at-discovery path.
  const t = readTerminalState(runDir);
  if (!t) return logBytes;
  sink.run({ runId, runDir, ...t });
  if (t.status === "completed" && t.fidelity !== undefined && t.fidelity >= promoteThreshold) {
    const eligibility = promoteEligibility(runDir);   // tier-blind render, tier-aware promote (spec C)
    if (eligibility === "eligible") sink.promote({ runId, runDir, fidelity: t.fidelity });
    else console.warn(`[amico] promote skipped for ${runId}: free-tier verification ${eligibility}`);
  }
  return logBytes;
}

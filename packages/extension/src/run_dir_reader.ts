import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { validateManifest, validateFinished, validateResult, validateFormulation } from "@amicode/amico-run";
import type { RunStatus } from "./types";

// ============================================================================
// Pure (vscode-free) reader for the β.1 run-dir contract. Unit-testable in
// isolation; the vscode-coupled RunsRootWatcher (file_watcher.ts) consumes it.
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

/** The pre-solve problem definition, surfaced from formulation.toml when present
 *  and valid (additive to the run-dir contract). `[system]`/`[formulation]` are
 *  lenient leaf-field bags per family (see formulation.schema.json), so this is
 *  intentionally loose; the only guaranteed keys are system.family + formulation.gate. */
export interface Formulation { system: Record<string, unknown>; formulation: Record<string, unknown> }
export interface RunCompletion { runId: string; runDir: string; status: RunStatus; fidelity?: number; formulation?: Formulation }
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

  // formulation.toml (#64 counterpart) — the pre-solve problem definition. Written
  // by the template BEFORE solve!, so it can be present even mid-run; additive, so
  // its absence changes nothing (older runs have none). Same say-why-on-invalid
  // policy as result.toml: surface WHY rather than silently dropping identity.
  let formulation: Formulation | undefined;
  const formRaw = readTomlSafe(path.join(runDir, "formulation.toml"));
  if (formRaw) {
    const v = validateFormulation(formRaw);
    if (v.ok) formulation = { system: formRaw.system as Record<string, unknown>, formulation: formRaw.formulation as Record<string, unknown> };
    else console.warn(`[amico] formulation.toml present but invalid (${runDir}): ${v.errors.join("; ")}`);
  }

  // FINISHED is the authoritative terminal signal
  const finished = readTomlSafe(path.join(runDir, "FINISHED"));
  if (!finished || !validateFinished(finished).ok) return logBytes;
  const status = finished.status as RunStatus;

  let fidelity: number | undefined;
  if (status === "completed") {
    const result = readTomlSafe(path.join(runDir, "result.toml"));
    if (result) {
      const v = validateResult(result);
      if (v.ok) fidelity = result.fidelity as number;
      // Present-but-nonconforming result.toml: surface WHY rather than silently
      // dropping fidelity + skipping promote (S4). console.warn keeps this reader
      // vscode-free; the live watcher logs to its channel too.
      else console.warn(`[amico] result.toml present but invalid (${runDir}): ${v.errors.join("; ")}`);
    }
  }
  sink.run({ runId, runDir, status, fidelity, formulation });
  if (status === "completed" && fidelity !== undefined && fidelity >= promoteThreshold) {
    sink.promote({ runId, runDir, fidelity });
  }
  return logBytes;
}

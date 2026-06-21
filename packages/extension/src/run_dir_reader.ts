import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { validateManifest, validateFinished, validateResult } from "@amicode/amico-run";
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
export const ITER_PNG_RE = /^iter_(\d+)\.png$/;   // unbounded digits (β.1 contract)

/** Parse an AMICODE_ITER numeric field, mapping Julia's Inf/NaN to JS values. */
export function parseAmicoNum(s: string): number {
  if (s === "Inf") return Infinity;
  if (s === "-Inf") return -Infinity;
  if (s === "NaN" || s === "-NaN") return NaN;
  return Number(s);
}

export interface IterRecord { iter: number; f_val: number; inf_pr: number; inf_du: number }
export interface RunCompletion { runId: string; runDir: string; status: RunStatus; fidelity?: number }
export interface PromoteInfo { runId: string; runDir: string; fidelity: number }

/** Where ingestRunDir routes its findings. The live impl carries the
 *  newest-wins + promote-once guards; the test impl is plain spies. */
export interface RunSink {
  image(fsPath: string, iter: number): void;
  iter(rec: IterRecord): void;
  run(c: RunCompletion): void;
  promote(info: PromoteInfo): void;
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
  const manifest = readTomlSafe(path.join(runDir, "manifest.toml"));
  if (!manifest || !validateManifest(manifest).ok) return 0;   // no valid manifest → not a run dir yet
  const runId = String(manifest.run_id);

  // newest iter PNG
  let newest = -1; let newestPath: string | undefined;
  for (const f of fs.readdirSync(runDir)) {
    const m = ITER_PNG_RE.exec(f);
    if (m) { const k = parseInt(m[1], 10); if (k > newest) { newest = k; newestPath = path.join(runDir, f); } }
  }
  if (newestPath) sink.image(newestPath, newest);

  // run.log body → iter records (replay; the live tailer handles appended lines)
  let logBody: string | undefined;
  try { logBody = fs.readFileSync(path.join(runDir, "run.log"), "utf8"); } catch { /* none yet */ }
  let logBytes = 0;
  if (logBody) {
    logBytes = Buffer.byteLength(logBody, "utf8");
    for (const line of logBody.split("\n")) {
      const m = AMICODE_ITER_RE.exec(line);
      if (m) sink.iter({ iter: +m[1], f_val: parseAmicoNum(m[2]), inf_pr: parseAmicoNum(m[3]), inf_du: parseAmicoNum(m[4]) });
    }
  }

  // FINISHED is the authoritative terminal signal
  const finished = readTomlSafe(path.join(runDir, "FINISHED"));
  if (!finished || !validateFinished(finished).ok) return logBytes;
  const status = finished.status as RunStatus;

  let fidelity: number | undefined;
  if (status === "completed") {
    const result = readTomlSafe(path.join(runDir, "result.toml"));
    if (result && validateResult(result).ok) fidelity = result.fidelity as number;
  }
  sink.run({ runId, runDir, status, fidelity });
  if (status === "completed" && fidelity !== undefined && fidelity >= promoteThreshold) {
    sink.promote({ runId, runDir, fidelity });
  }
  return logBytes;
}

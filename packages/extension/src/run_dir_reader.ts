import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "smol-toml";
import { validateManifest, validateFinished, validateResult } from "@amicode/amico-run";
import type { RunStatus } from "./types";

// ============================================================================
// Pure (vscode-free) reader for the β.1 run-dir contract. Unit-testable in
// isolation; the vscode-coupled RunsRootWatcher (file_watcher.ts) consumes it.
// ============================================================================

export const AMICODE_ITER_RE = /^AMICODE_ITER\s+iter=(\d+)\s+f=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_pr=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s+inf_du=(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*$/;
export const ITER_PNG_RE = /^iter_(\d+)\.png$/;   // unbounded digits (β.1 contract)

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
 *  sink's guards make it idempotent). */
export function ingestRunDir(runDir: string, sink: RunSink, promoteThreshold = 0.99): void {
  const manifest = readTomlSafe(path.join(runDir, "manifest.toml"));
  if (!manifest || !validateManifest(manifest).ok) return;   // no valid manifest → not a run dir yet
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
  if (logBody) {
    for (const line of logBody.split("\n")) {
      const m = AMICODE_ITER_RE.exec(line);
      if (m) sink.iter({ iter: +m[1], f_val: +m[2], inf_pr: +m[3], inf_du: +m[4] });
    }
  }

  // FINISHED is the authoritative terminal signal
  const finished = readTomlSafe(path.join(runDir, "FINISHED"));
  if (!finished || !validateFinished(finished).ok) return;
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
}

// ============================================================================
// Score-guard for the amicode_* tool pack — stage-order + gate enforcement.
//
// SIBLING-MODULE RULES (same as ./entities): this file is imported by
// amicode_tools.ts inside opencode's Bun runtime via a relative `./score_guard`
// import — keep it dependency-free (node: builtins only). Its logic is pure and
// unit-tested from test/scores/guard.test.ts. Named exports here are fine; the
// single-export constraint applies only to the plugin entry (amicode_tools.ts).
//
// STATE CONTRACT (spec A — TWO dirs, split from the old single entitiesDir):
//   manifestDir (problems ROOT, session-scoped):
//     score_manifest.json   written by prepareOpencodeProject (extension side)
//   stateDir (the active problem's WORKSPACE, per-problem):
//     interview_state.json  same shape as src/scores/interview_state.ts (JSON, "" not null)
//     usage.jsonl           same line format as src/scores/usage.ts
// The FILE FORMATS are the contract between the extension process and this Bun
// process — the modules are deliberately parallel implementations because this
// side must not import from src/ (see amicode_tools.ts header). When the state's
// score_id/version disagree with the manifest (an old problem reopened under a
// different score), the state is reset to fresh for the manifest's score so
// completed-stage checks never cross scores.
//
// SEMANTICS: the guard protects ENTITY DEPENDENCIES, not conversation order.
// Blockers for entering a stage = prior non-optional stages that EMIT entities
// and are not completed. Conversational stages (no emits) never block, so the
// interview's mode/problem stages can be answered without tool calls. A stage
// with `gate:` additionally requires a pass/override record in state.gates.
// No manifest on disk → no gating (the tools stay pure bookkeeping — fallback).
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

export interface StageLite {
  id: string;
  emits?: string[];
  optional?: boolean;
  gate?: string;
}

export interface ManifestLite {
  id: string;
  version: number;
  stages: StageLite[];
}

export interface GateRecordLite {
  result: "pass" | "fail" | "override";
  ts: string;
  override_reason: string;
}

export interface ScoreStateLite {
  score_id: string;
  score_version: number;
  stage_cursor: string;
  completed_stages: string[];
  answers: Record<string, string>;
  entity_refs: string[];
  gates: Record<string, GateRecordLite>;
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: "stage_order"; required_stage: string; missing_entities: string[] }
  | { ok: false; code: "gate_required"; gate: string };

export function freshScoreState(scoreId: string, scoreVersion: number): ScoreStateLite {
  return {
    score_id: scoreId,
    score_version: scoreVersion,
    stage_cursor: "",
    completed_stages: [],
    answers: {},
    entity_refs: [],
    gates: {},
  };
}

export function checkStagePrereqs(stages: StageLite[], state: ScoreStateLite, requestedStageId: string): GuardVerdict {
  const idx = stages.findIndex((s) => s.id === requestedStageId);
  if (idx === -1) return { ok: true }; // unknown stage: fail-open (forward compatibility)
  const requested = stages[idx];
  const done = new Set(state.completed_stages);
  for (let k = 0; k < idx; k++) {
    const prior = stages[k];
    if (prior.optional || !prior.emits?.length || done.has(prior.id)) continue;
    return { ok: false, code: "stage_order", required_stage: prior.id, missing_entities: [...prior.emits] };
  }
  if (requested.gate && !done.has(requested.id)) {
    const rec = state.gates[requested.gate];
    if (!rec || rec.result === "fail") return { ok: false, code: "gate_required", gate: requested.gate };
  }
  return { ok: true };
}

const MANIFEST_FILE = "score_manifest.json";
const STATE_FILE = "interview_state.json";
const USAGE_FILE = "usage.jsonl";

export function loadManifest(dir: string): ManifestLite | undefined {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { manifest?: ManifestLite };
    return raw.manifest && Array.isArray(raw.manifest.stages) ? raw.manifest : undefined;
  } catch {
    return undefined;
  }
}

export function loadScoreState(dir: string): ScoreStateLite | undefined {
  const file = path.join(dir, STATE_FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ScoreStateLite;
  } catch {
    return undefined;
  }
}

export function saveScoreState(dir: string, state: ScoreStateLite): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, STATE_FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export function appendUsage(dir: string, event: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, USAGE_FILE), JSON.stringify(event) + "\n");
}

/** One-call guard for a tool execute(): returns an error string to hand back to
 *  the model when blocked (naming the missing prerequisite), else undefined —
 *  and on success records stage entry + usage events. No manifest → no gating.
 *  Reads the manifest from `manifestDir` (problems root) and state/usage from
 *  `stateDir` (the active problem workspace); resets state on a score mismatch. */
export function guardAndRecordStage(manifestDir: string, stateDir: string, stageId: string): string | undefined {
  const manifest = loadManifest(manifestDir);
  if (!manifest) return undefined; // fallback mode: pure bookkeeping, as before
  let state = loadScoreState(stateDir);
  if (state && (state.score_id !== manifest.id || state.score_version !== manifest.version)) {
    // Old problem reopened under a different score — reset to fresh (stderr only:
    // stdout is parsed by `opencode debug config`; see amicode_tools.ts header).
    console.error(
      `[amicode-tools] score changed (${state.score_id} v${state.score_version} → ` +
        `${manifest.id} v${manifest.version}); resetting interview state`,
    );
    state = undefined;
  }
  if (!state) {
    state = freshScoreState(manifest.id, manifest.version);
    appendUsage(stateDir, {
      kind: "session_started",
      ts: new Date().toISOString(),
      score_id: manifest.id,
      score_version: manifest.version,
    });
  }
  const verdict = checkStagePrereqs(manifest.stages, state, stageId);
  if (!verdict.ok) {
    return (
      `Blocked by the score's stage order: ${JSON.stringify(verdict)}. ` +
      (verdict.code === "stage_order"
        ? `Complete stage "${verdict.required_stage}" first (records: ${verdict.missing_entities.join(", ")}) — relay this to the user conversationally.`
        : `Gate "${verdict.gate}" has no passing record — its checks must pass (or be overridden with a recorded reason) first.`)
    );
  }
  if (!state.completed_stages.includes(stageId)) {
    appendUsage(stateDir, { kind: "stage_entered", ts: new Date().toISOString(), stage: stageId });
  }
  state.stage_cursor = stageId;
  saveScoreState(stateDir, state);
  return undefined;
}

/** Mark a stage completed after its tool succeeded (idempotent). */
export function completeStage(dir: string, stageId: string): void {
  const state = loadScoreState(dir);
  if (!state) return;
  if (!state.completed_stages.includes(stageId)) {
    state.completed_stages.push(stageId);
    appendUsage(dir, { kind: "stage_completed", ts: new Date().toISOString(), stage: stageId });
  }
  saveScoreState(dir, state);
}

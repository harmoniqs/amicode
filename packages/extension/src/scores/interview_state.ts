import * as fs from "node:fs";
import * as path from "node:path";

// Session-scoped interview state, [score] slice (spec §6; interview-UX §4 allows
// JSON or TOML — JSON here matches the plugin's established system.json sidecar
// pattern, since the opencode plugin deliberately carries no TOML parser).
// completed_stages + gates are the additive extension the stage guard reads.
// score_version pins the score version the session started on: revising a score
// never disturbs an in-flight session (spec §8 / success criterion 8).

export interface GateRecord {
  result: "pass" | "fail" | "override";
  ts: string;
  override_reason: string; // "" when not an override — never null (state-file house rule)
}

export interface ScoreState {
  score_id: string;
  score_version: number;
  stage_cursor: string;
  completed_stages: string[];
  answers: Record<string, string>;
  entity_refs: string[];
  gates: Record<string, GateRecord>;
}

const FILE = "interview_state.json";

export function newState(scoreId: string, scoreVersion: number): ScoreState {
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

export function loadState(dir: string): ScoreState | undefined {
  const file = path.join(dir, FILE);
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ScoreState;
  } catch {
    return undefined;
  }
}

export function saveState(dir: string, state: ScoreState): void {
  const file = path.join(dir, FILE);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadState, saveState, newState, ScoreState } from "../../src/scores/interview_state";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "istate-"));
}

describe("interview_state [score]", () => {
  it("fresh dir → undefined (caller starts a new session)", () => {
    expect(loadState(tmp())).toBeUndefined();
  });

  it("round-trips the full [score] shape", () => {
    const dir = tmp();
    const state: ScoreState = {
      score_id: "pulse-designer",
      score_version: 1,
      stage_cursor: "model",
      completed_stages: ["platform"],
      answers: { platform: "transmon" },
      entity_refs: ["_entities/system.toml"],
      gates: { light: { result: "pass", ts: "2026-07-03T04:00:00Z", override_reason: "" } },
    };
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  it("absent optionals serialize as empty, not null", () => {
    const dir = tmp();
    saveState(dir, newState("pulse-designer", 1));
    const raw = fs.readFileSync(path.join(dir, "interview_state.json"), "utf8");
    expect(raw).not.toContain("null");
    const loaded = loadState(dir)!;
    expect(loaded.completed_stages).toEqual([]);
    expect(loaded.answers).toEqual({});
    expect(loaded.gates).toEqual({});
  });

  it("version pinning: loadState never upgrades a pinned version", () => {
    const dir = tmp();
    saveState(dir, newState("pulse-designer", 1));
    // Repertoire moves to version 2; the in-flight session stays pinned.
    const loaded = loadState(dir)!;
    expect(loaded.score_version).toBe(1);
    saveState(dir, { ...loaded, stage_cursor: "solve" });
    expect(loadState(dir)!.score_version).toBe(1);
  });

  it("corrupt state file → undefined, not a crash", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "interview_state.json"), "{not json");
    expect(loadState(dir)).toBeUndefined();
  });
});

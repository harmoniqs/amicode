import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendUsage, readUsage, reconstructTraversal, UsageEvent } from "../../src/scores/usage";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
}

const T = "2026-07-03T04:00:00Z";

describe("usage capture", () => {
  it("appends one JSON line per event and reads them back", () => {
    const dir = tmp();
    appendUsage(dir, { kind: "session_started", ts: T, score_id: "pulse-designer", score_version: 1 });
    appendUsage(dir, { kind: "stage_entered", ts: T, stage: "platform" });
    const lines = fs.readFileSync(path.join(dir, "usage.jsonl"), "utf8").trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(readUsage(dir)).toHaveLength(2);
  });

  it("reader tolerates a trailing partial line", () => {
    const dir = tmp();
    appendUsage(dir, { kind: "stage_entered", ts: T, stage: "platform" });
    fs.appendFileSync(path.join(dir, "usage.jsonl"), '{"kind":"stage_ent'); // torn write
    expect(readUsage(dir)).toHaveLength(1);
  });

  it("empty/missing file → no events", () => {
    expect(readUsage(tmp())).toEqual([]);
  });

  it("reconstructs a traversal funnel exactly (spec success criterion 8)", () => {
    const events: UsageEvent[] = [
      { kind: "session_started", ts: T, score_id: "pulse-designer", score_version: 1 },
      { kind: "stage_entered", ts: T, stage: "platform" },
      { kind: "question_answered", ts: T, stage: "platform", question_id: "platform", default_taken: true },
      { kind: "stage_completed", ts: T, stage: "platform" },
      { kind: "stage_entered", ts: T, stage: "model" },
      { kind: "off_path", ts: T, from_stage: "model" },
      { kind: "stage_entered", ts: T, stage: "solve" },
      { kind: "gate", ts: T, gate: "light", result: "pass" },
      { kind: "stage_completed", ts: T, stage: "solve" },
    ];
    expect(reconstructTraversal(events)).toEqual({
      score_id: "pulse-designer",
      score_version: 1,
      funnel: [
        { stage: "platform", entered: true, completed: true },
        { stage: "model", entered: true, completed: false },
        { stage: "solve", entered: true, completed: true },
      ],
      off_path_count: 1,
      defaults_taken: 1,
      questions_answered: 1,
      gates: [{ gate: "light", result: "pass" }],
    });
  });
});

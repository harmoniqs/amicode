// jev_calibration — issue #1311: the calibration BATTERY (the curation spec's
// discipline: thresholds are evaluated on our data, never cookbook). The pure
// graders below reproduce the 2026-09-20 sweep numbers from the hand-labeled
// fixture (test/fixtures/jev/calibration-2026-09-20.json) and are what the
// live harness (test/slow/jev_calibration.test.ts — network, opt-in env, NOT
// part of the unit suite) replays the set through on demand.
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  gradeChoiceBattery,
  gradeNoulBattery,
  runCalibrationBattery,
  type CalibrationEntry,
} from "../src/jev_calibration.js";

const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "jev", "calibration-2026-09-20.json"), "utf8"),
) as { entries: CalibrationEntry[] };

/** The recorded answers as the battery saw them on 2026-09-20 (provenance in the fixture). */
function recordedAnswers(entries: CalibrationEntry[]): Record<string, { choice?: string; confidence?: number; noul?: number }> {
  const out: Record<string, { choice?: string; confidence?: number; noul?: number }> = {};
  for (const e of entries) {
    if (e.recorded?.choice !== undefined) out[e.session_id] = { choice: e.recorded.choice, confidence: e.recorded.confidence };
  }
  return out;
}

function recordedNouls(entries: CalibrationEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) {
    if (e.recorded?.noul !== undefined) out[e.session_id] = e.recorded.noul;
  }
  return out;
}

describe("the 2026-09-20 calibration battery — recorded answers graded against hand labels", () => {
  it("grades the six-session set: 5/6 bucket agreement, the single mismatch action-irrelevant", () => {
    const g = gradeChoiceBattery(FIXTURE.entries, recordedAnswers(FIXTURE.entries));
    expect(g.judged).toBe(6);
    expect(g.agree).toBe(5);
    expect(g.mismatches).toEqual([
      { session_id: "ses_smoke", hand: "junk-greeting", jev: "dead-cast", note: "action-irrelevant: both buckets archive" },
    ]);
    // the ACTION matrix agrees 6/6 — the mismatch never changes what would happen
    expect(g.action_agree).toBe(6);
  });

  it("grades the noul spread: junk low, substance high — min 0.05, max 0.91", () => {
    const g = gradeNoulBattery(FIXTURE.entries, recordedNouls(FIXTURE.entries));
    expect(g.judged).toBe(4); // the four nouls the spec recorded
    expect(g.spread.min).toBeCloseTo(0.05, 5);
    expect(g.spread.max).toBeCloseTo(0.91, 5);
    expect(g.brier).toBeCloseTo(0.0252750, 6);
  });

  it("computes multiclass choice Brier over the closed option set when probabilities are present", () => {
    const entries = FIXTURE.entries.slice(0, 1); // one junk-greeting session
    const brier = gradeChoiceBattery(entries, {
      ses_greet_1: { choice: "junk-greeting", confidence: 0.9, probabilities: { "junk-greeting": 0.9, substantive: 0.1 } },
    }).brier;
    // (0.9−1)² + (0.1−0)² across the two declared options; the rest are 0−0
    expect(brier).toBeCloseTo(0.02, 6);
  });

  it("reports choice Brier as null (with reason) when any judged answer lacks probabilities", () => {
    const g = gradeChoiceBattery(FIXTURE.entries, recordedAnswers(FIXTURE.entries));
    expect(g.brier).toBeNull();
    expect(g.brier_reason).toMatch(/probabilities/);
  });

  it("judges only sessions with an answer — a session the client missed is absent, never guessed", () => {
    const g = gradeChoiceBattery(FIXTURE.entries, { ses_greet_1: { choice: "junk-greeting", confidence: 1.0 } });
    expect(g.judged).toBe(1);
    expect(g.agree).toBe(1);
  });
});

// ── the battery RUNNER end-to-end (stub transport — the slow tier replays live) ──
describe("runCalibrationBattery — both loops + grading in one pass", () => {
  it("replays every entry through the choice and noul loops and grades (hermetic stub transport)", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "amico-jev-bat-"));
    try {
      const key = join(root, "key");
      writeFileSync(key, "k_test_bat", { mode: 0o600 });
      // answer by hand bucket: junk sessions read junk with 0.9, substance reads substantive with 0.9;
      // nouls follow the sweep shape (junk low, substance high)
      const transport = async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as { state: { title?: string }; questions: Record<string, { type: string }> };
        const [questionId, question] = Object.entries(body.questions)[0];
        const answer =
          question.type === "choice"
            ? { type: "choice", choice: body.state.title === "fleet-smoke" ? "dead-cast" : body.state.title!.match(/greeting/i) ? "junk-greeting" : "substantive", confidence: 0.9 }
            : { type: "noul", noul: body.state.title!.match(/greeting|smoke/i) ? 0.07 : 0.8 };
        return { status: 200, text: async () => JSON.stringify({ model: "jev-test", answers: { [questionId]: answer }, usage: { input_tokens: 500, output_tokens: 21 } }) };
      };

      const battery = await runCalibrationBattery(FIXTURE.entries, {
        env: { AMICO_TYPESAFE_KEY_FILE: key, AMICO_TYPESAFE_RECEIPTS: join(root, "receipts.jsonl") },
        transport,
      });

      expect(battery.status).toBe("ran");
      // 5/6 bucket agreement (fleet-smoke reads dead-cast, action-irrelevant), 6/6 action agreement
      expect(battery.choice.judged).toBe(6);
      expect(battery.choice.agree).toBe(5);
      expect(battery.choice.action_agree).toBe(6);
      // all six nouls answered: junk ~0.07, substance ~0.8
      expect(battery.noul.judged).toBe(6);
      expect(battery.noul.spread.min).toBeCloseTo(0.07, 5);
      expect(battery.noul.spread.max).toBeCloseTo(0.8, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("no key → status unavailable, nothing judged (the harness degrades honestly, never fabricates)", async () => {
    const battery = await runCalibrationBattery(FIXTURE.entries, { env: { AMICO_TYPESAFE_KEY_FILE: "/nonexistent/key", AMICO_TYPESAFE_RECEIPTS: "/nonexistent/r.jsonl" } });
    expect(battery.status).toBe("unavailable");
    expect(battery.choice.judged).toBe(0);
    expect(battery.noul.judged).toBe(0);
  });
});

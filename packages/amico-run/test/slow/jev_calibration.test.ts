// jev_calibration (LIVE) — issue #1311: the on-demand calibration harness.
// Replays the hand-labeled 2026-09-20 sweep set through the REAL Jev client
// (one choice + one noul per session) and grades today's answers: bucket
// agreement, action agreement, noul spread, Brier per primitive — ONE JSON
// object on stdout.
//
// RUN-ON-DEMAND (network + the server-side key; NEVER part of the unit suite
// — the fast suite excludes **/slow/** and this self-gates on the opt-in env):
//
//   AMICO_TEST_JEV_CALIBRATION=1 pnpm --filter @amicode/amico-run run test:slow
//
// The key resolves through the standard posture ($AMICO_TYPESAFE_KEY_FILE →
// ~/.amico/typesafe/key); receipts land in the shared curation journal.
// Re-run whenever the model version moves (the version rides every receipt).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { runCalibrationBattery, type CalibrationEntry } from "../../src/jev_calibration.js";

const entries = (
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "jev", "calibration-2026-09-20.json"), "utf8")) as {
    entries: CalibrationEntry[];
  }
).entries;

describe.skipIf(!process.env.AMICO_TEST_JEV_CALIBRATION)("slow: the LIVE jev calibration battery (network, opt-in)", () => {
  it("replays the 2026-09-20 sweep set live and prints the graded battery as JSON", async () => {
    const battery = await runCalibrationBattery(entries);

    // ONE JSON object out — the harness output contract
    console.log(JSON.stringify(battery));

    // the battery must grade something to be a battery
    expect(battery.status).toBe("ran");
    expect(battery.choice.judged).toBeGreaterThan(0);
    expect(battery.noul.judged).toBeGreaterThan(0);
  });
});

// jev_calibration.ts — issue #1311 (slice of #1301 session curation): the
// calibration BATTERY graders — the curation spec's discipline ("thresholds
// are evaluated on our data, never cookbook"; Brier + reliability per
// primitive, re-run on model-version changes). The hand-labeled set is the
// 2026-09-20 sweep (test/fixtures/jev/calibration-2026-09-20.json — six
// sessions, two junk / one borderline / three substantive, provenance in the
// curation spec §Calibration).
//
// PURE graders over (entries, answers) — the unit suite grades the RECORDED
// 2026-09-20 answers (reproducing the sweep numbers: 5/6 bucket agreement,
// noul spread 0.05→0.91); the LIVE battery (test/slow/jev_calibration.test.ts
// — network, opt-in env, never in the unit suite) replays the same set
// through the real client on demand and grades whatever the model answers
// TODAY, so a version change can be re-qualified mechanically.
import { JUNK_BUCKETS, jevJunkResidual, jevThreadNouls, type CurationDeps, type SessionFeaturesLite } from "./jev_curation.js";

/** One hand-labeled calibration session. */
export interface CalibrationEntry {
  session_id: string;
  features: SessionFeaturesLite;
  last_text: string;
  hand_bucket: string;
  hand_has_thread: boolean;
  recorded?: { choice?: string; confidence?: number; noul?: number };
}

/** The choice answer shape the graders consume (client answer or recorded). */
export interface ChoiceAnswer {
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

const actionOf = (bucket: string): "archive" | "keep" => ((JUNK_BUCKETS as readonly string[]).includes(bucket) ? "archive" : "keep");

/** Grade the Choice battery: bucket agreement, ACTION agreement (the honest
 * axis — the sweep's single mismatch was action-irrelevant: both buckets
 * archive), and multiclass Brier over the closed option set when every
 * judged answer carries probabilities. Judged = sessions with an answer;
 * a session the client missed is never guessed. */
export function gradeChoiceBattery(entries: CalibrationEntry[], answers: Record<string, ChoiceAnswer>) {
  const judged = entries.filter((e) => answers[e.session_id]?.choice !== undefined);
  const mismatches = judged
    .filter((e) => answers[e.session_id].choice !== e.hand_bucket)
    .map((e) => {
      const jev = answers[e.session_id].choice as string;
      const sameAction = actionOf(jev) === actionOf(e.hand_bucket);
      return {
        session_id: e.session_id,
        hand: e.hand_bucket,
        jev,
        ...(sameAction ? { note: "action-irrelevant: both buckets archive" } : {}),
      };
    });
  const allProbabilities = judged.every((e) => answers[e.session_id].probabilities !== undefined);
  let brier: number | null = null;
  if (judged.length > 0 && allProbabilities) {
    const options = new Set<string>(judged.flatMap((e) => Object.keys(answers[e.session_id].probabilities ?? {})));
    for (const e of judged) {
      options.add(e.hand_bucket);
      options.add(answers[e.session_id].choice as string);
    }
    brier =
      judged.reduce((sum, e) => {
        const probs = answers[e.session_id].probabilities ?? {};
        return sum + [...options].reduce((s, o) => s + ((probs[o] ?? 0) - (e.hand_bucket === o ? 1 : 0)) ** 2, 0);
      }, 0) / judged.length;
  }
  return {
    judged: judged.length,
    agree: judged.length - mismatches.length,
    action_agree: judged.filter((e) => actionOf(answers[e.session_id].choice as string) === actionOf(e.hand_bucket)).length,
    mismatches,
    brier,
    ...(brier === null && judged.length > 0 ? { brier_reason: "choice Brier needs full probabilities per judged answer" } : {}),
  };
}

/** Grade the Noul battery: spread (min/max over judged) + Brier
 * ((noul − y)², y = hand_has_thread). Judged = sessions with a noul. */
export function gradeNoulBattery(entries: CalibrationEntry[], nouls: Record<string, number>) {
  const judged = entries.filter((e) => nouls[e.session_id] !== undefined);
  const values = judged.map((e) => nouls[e.session_id]);
  return {
    judged: judged.length,
    spread: { min: Math.min(...values), max: Math.max(...values) },
    brier:
      judged.length === 0
        ? null
        : judged.reduce((sum, e) => sum + (nouls[e.session_id] - (e.hand_has_thread ? 1 : 0)) ** 2, 0) / judged.length,
  };
}

/** The full battery pass: replay every entry through BOTH loops (one choice +
 * one noul per session — exactly the production call sites' questions) and
 * grade. Hermetic under a stubbed transport; live under the real one. */
export async function runCalibrationBattery(
  entries: CalibrationEntry[],
  deps: CurationDeps = {},
  now: () => number = Date.now,
): Promise<{
  ts: string;
  status: "ran" | "unavailable" | "disabled";
  choice: ReturnType<typeof gradeChoiceBattery>;
  noul: ReturnType<typeof gradeNoulBattery>;
}> {
  const residual = await jevJunkResidual(
    entries.map((e) => ({ id: e.session_id, features: e.features, ageHours: 72 })),
    deps,
  );
  const nouls = await jevThreadNouls(
    entries.map((e) => ({ id: e.session_id, title: e.features.title, lastAssistantText: e.last_text, pendingTodos: e.features.todo_count })),
    deps,
  );
  const answers: Record<string, ChoiceAnswer> = {};
  for (const [id, verdict] of Object.entries(residual.verdicts)) {
    if (verdict.choice !== undefined) answers[id] = { choice: verdict.choice, confidence: verdict.confidence };
  }
  return {
    ts: new Date(now()).toISOString(),
    status: residual.status,
    choice: gradeChoiceBattery(entries, answers),
    noul: gradeNoulBattery(entries, nouls.nouls),
  };
}

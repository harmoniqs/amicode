// jev_curation.ts — issue #1311 (slice of #1301 session curation): the two
// confidence-gated call sites over the ONE thin Jev client (jev_client.ts):
//
//   (a) classifier residual — sessions the deterministic #1303 rules leave
//       unclassified get ONE Jev Choice over the closed junk-bucket set (with
//       an "unclassified" no-match option). Archive admission ONLY at
//       junk-bucket p ≥ 0.95 AND age ≥ 48 h — the curation spec's calibrated
//       pair ("never act on an ambiguous mid-confidence read"); everything
//       else — below threshold, no-match, any client failure — leaves the
//       session as-is (fail-open).
//
//   (b) onset thread-Noul — ONE Noul per digest candidate ("does this session
//       have an open thread?"). The ≥ 0.5 promotion + ranking live in the
//       onset digest module (the plugin); THIS module only produces the map.
//       Jev never derives a bucket label anywhere.
//
// PURITY: the gates and question builders are pure functions of their
// arguments (the #1303 classifier discipline); the loops take injectable
// deps (transport, receipts, clock, env) so the suite runs hermetically —
// no test touches network or the real key.
import { askJev, type JevAnswer, type JevDeps, type JevQuestion } from "./jev_client.js";

/** The deps both loops take — injectable for hermetic tests (jev_client's JevDeps). */
export type CurationDeps = JevDeps;

/** Archive admission floor — the curation spec's calibrated Choice gate. */
export const JEV_ARCHIVE_CONFIDENCE_MIN = 0.95;

/** The Jev residual's FIXED age gate — independent of (never narrower than)
 * the archiver's scan cutoff: a tab opened 5 minutes ago must never vanish
 * on a model's word even if the scan runs --hours 1. */
export const JEV_ARCHIVE_MIN_AGE_HOURS = 48;

/** The buckets that archive (the #1303 closed set's junk half). */
export const JUNK_BUCKETS = ["junk-greeting", "dead-cast", "probe"] as const;

/** The classifier-residual choice: ONE question over the closed bucket set,
 * the no-match option being one of OUR options ("unclassified"). */
export const JUNK_BUCKET_RUBRIC: Record<string, string> = {
  "junk-greeting": "a greeting/test/smoke-titled session with minimal user text and at most a few assistant turns",
  "dead-cast": "a spawned session that never got a single assistant reply (at most one user message)",
  probe: "a session that was opened but never used — no user and no assistant messages",
  substantive: "a session carrying real work — substantive user text, many assistant turns, or pending todos",
  unclassified: "none of the above fits this session",
};

/** The deterministic fold the classifier residual feeds Jev — counts and the
 * title, never message text (the state-budget doctrine: digests, not spines). */
export interface SessionFeaturesLite {
  title: string;
  user_message_count: number;
  user_text_chars: number;
  assistant_message_count: number;
  todo_count: number;
}

/** The residual question: state fold + choice question over the closed set. */
export function junkResidualQuestion(f: SessionFeaturesLite): { question: JevQuestion; state: SessionFeaturesLite } {
  return {
    question: {
      type: "choice",
      instructions: "Classify this chat session into exactly one bucket. The session is NOT in any deterministic junk bucket — judge which bucket it truly belongs to.",
      criteria: JUNK_BUCKET_RUBRIC,
    },
    state: {
      title: f.title,
      user_message_count: f.user_message_count,
      user_text_chars: f.user_text_chars,
      assistant_message_count: f.assistant_message_count,
      todo_count: f.todo_count,
    },
  };
}

/** The calibrated admission gate (pure): a junk-bucket Choice at p ≥ 0.95
 * AND age ≥ 48 h — nothing else admits. `choice` undefined (call failed,
 * no answer) admits nothing: the fail-open path. */
export function jevArchiveAdmits(choice: string | undefined, confidence: number, ageHours: number): boolean {
  if (choice === undefined) return false;
  if (!(JUNK_BUCKETS as readonly string[]).includes(choice)) return false;
  return confidence >= JEV_ARCHIVE_CONFIDENCE_MIN && ageHours >= JEV_ARCHIVE_MIN_AGE_HOURS;
}

// ── the loops (one call per session, fail-open per session) ──────────────────

/** Status of a loop pass: ran | unavailable (no key — the fail-open config)
 * | disabled (the off-switch). The first call's failure mode decides; no
 * call is ever made after unavailability is known. */
export type JevPassStatus = "ran" | "unavailable" | "disabled";

/** One rule-unclassified session the residual loop judges. `ageHours` is the
 * FIXED 48 h gate input (now − time_updated), never the scan cutoff. */
export interface ResidualSession {
  id: string;
  features: SessionFeaturesLite;
  ageHours: number;
}

/** Per-session residual verdict: the Choice read, or the honest error that
 * failed it (never both, never neither). */
export interface ResidualVerdict {
  choice?: string;
  confidence?: number;
  error?: string;
}

/** ONE Jev Choice per rule-unclassified session (the classifier residual).
 * Sessions already in a deterministic junk bucket never reach this loop —
 * the caller passes the residual only (residual-only wiring). */
export async function jevJunkResidual(
  sessions: ResidualSession[],
  deps: CurationDeps = {},
): Promise<{ status: JevPassStatus; verdicts: Record<string, ResidualVerdict> }> {
  const verdicts: Record<string, ResidualVerdict> = {};
  for (const s of sessions) {
    const { question, state } = junkResidualQuestion(s.features);
    const res = await askJev({ junk_bucket: question }, state, { sessionId: s.id, deps });
    if (!res.ok) {
      if (res.reason === "disabled" || res.reason === "key-missing") return { status: res.reason === "disabled" ? "disabled" : "unavailable", verdicts };
      verdicts[s.id] = { error: res.error };
      continue;
    }
    const answer = res.answers.junk_bucket;
    if (answer === undefined || answer.type !== "choice") {
      verdicts[s.id] = { error: "no choice answer for junk_bucket" };
      continue;
    }
    verdicts[s.id] = { choice: answer.choice, confidence: answer.confidence };
  }
  return { status: "ran", verdicts };
}

/** The last-text excerpt cap — the noul fold stays digest-sized. */
const NOUL_STATE_TEXT_CHARS = 400;

/** One digest candidate for the onset thread-Noul pass. */
export interface NoulCandidate {
  id: string;
  title: string;
  lastAssistantText: string;
  pendingTodos: number;
}

/** The thread-Noul question: "does this session still have an open thread?" */
export function threadNoulQuestion(c: NoulCandidate): { question: JevQuestion; state: Record<string, unknown> } {
  return {
    question: {
      type: "noul",
      instructions: "Does this chat session still have an open thread — an unfinished step, a decision the user owes, or documented pending work?",
      criteria: {
        true: "the session awaits a user decision, ended mid-action, or carries pending documented work",
        false: "the session wrapped up — verdict delivered, nothing owed",
      },
    },
    state: {
      title: c.title,
      last_text: c.lastAssistantText.slice(0, NOUL_STATE_TEXT_CHARS),
      pending_todos: c.pendingTodos,
    },
  };
}

/** ONE thread-Noul per digest candidate → the promotion map the onset digest
 * consumes. A failed candidate is absent from the map (never a guessed 0);
 * unavailable/disabled yields the EMPTY map — the digest degrades to today. */
export async function jevThreadNouls(
  candidates: NoulCandidate[],
  deps: CurationDeps = {},
): Promise<{ status: JevPassStatus; nouls: Record<string, number> }> {
  const nouls: Record<string, number> = {};
  for (const c of candidates) {
    const { question, state } = threadNoulQuestion(c);
    const res = await askJev({ has_open_thread: question }, state, { sessionId: c.id, deps });
    if (!res.ok) {
      if (res.reason === "disabled" || res.reason === "key-missing") return { status: res.reason === "disabled" ? "disabled" : "unavailable", nouls };
      continue;
    }
    const answer = res.answers.has_open_thread;
    if (answer !== undefined && answer.type === "noul") nouls[c.id] = answer.noul;
  }
  return { status: "ran", nouls };
}

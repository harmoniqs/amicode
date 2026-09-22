// session_junk.ts — issue #1303 (slice of #1301 session curation): the ONE
// deterministic junk classifier for top-level chat sessions.
//
// A pure function of a session-features object — no DB access, no I/O, no
// network, no LLM. The caller (the nightly archiver, a future `amico sessions`
// verb) maps DB rows into `SessionFeatures` OUTSIDE this module; that keeps the
// classifier testable without a database and the classification reproducible.
//
// Bucket set is CLOSED: junk-greeting | dead-cast | probe | substantive.
// Anything not covered by a junk rule defaults `substantive` — curation never
// loses work by default, and a session we lack sufficient features to judge is
// never junk (invariant from the issue).
//
// Thresholds are calibrated on the 2026-09-20 manual sweep (63 junk
// classifications, zero false positives on boundary review — evidence on
// issue #1301). They are named exports: the nightly archiver reads them; no
// magic numbers. The greeting vocabulary unifies the scattered noise-title
// lists (session_recap.ts, the open-threads skill) rather than diverging from
// them: hello/hi/howdy/test/smoke per the issue, plus "greeting" and
// "new session" from the open-threads noise-title filter.

/** The features the classifier consumes — mapped from DB rows by the caller. */
export interface SessionFeatures {
  title: string;
  user_message_count: number;
  user_text_chars: number;
  assistant_message_count: number;
  todo_count: number;
}

export type SessionJunkClass = "junk-greeting" | "dead-cast" | "probe" | "substantive";

/** User-text ceiling below which a greeting-titled session is junk. */
export const JUNK_GREETING_MAX_USER_CHARS = 40;

/** Assistant-turn ceiling at or below which a greeting-titled session is junk. */
export const JUNK_GREETING_MAX_ASSISTANT_MESSAGES = 6;

/** Title words that mark a greeting/smoke session. Matched on word
 *  boundaries, case-insensitively — "hi" must not match "history". */
export const GREETING_TITLE_VOCABULARY = [
  "hello",
  "hi",
  "howdy",
  "greeting",
  "test",
  "smoke",
  "new session",
] as const;

function isGreetingTitle(title: string): boolean {
  const t = title.toLowerCase();
  return GREETING_TITLE_VOCABULARY.some((word) => new RegExp(`\\b${word}\\b`).test(t));
}

/** Classify one session deterministically. Rule order matters:
 *
 *  1. pending todos → substantive (todos are work; never junk — AC 5)
 *  2. zero user AND zero assistant messages → probe (opened, never used — AC 3)
 *  3. zero assistant messages and ≤ 1 user message → dead-cast, regardless of
 *     title (the cast was eaten before the first reply — AC 2)
 *  4. greeting-vocabulary title, < 40 user chars, ≤ 6 assistant turns →
 *     junk-greeting (AC 1); more than 6 assistant turns stays substantive (AC 4)
 *  5. anything else → substantive (the closed-set default) */
export function classifySession(f: SessionFeatures): SessionJunkClass {
  if (f.todo_count > 0) return "substantive";
  if (f.user_message_count === 0 && f.assistant_message_count === 0) return "probe";
  if (f.assistant_message_count === 0 && f.user_message_count <= 1) return "dead-cast";
  if (
    isGreetingTitle(f.title) &&
    f.user_text_chars < JUNK_GREETING_MAX_USER_CHARS &&
    f.assistant_message_count <= JUNK_GREETING_MAX_ASSISTANT_MESSAGES
  ) {
    return "junk-greeting";
  }
  return "substantive";
}

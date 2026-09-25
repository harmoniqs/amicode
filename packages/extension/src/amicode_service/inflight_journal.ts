// ============================================================================
// inflight_journal — #1552 (interrupted-session re-dispatch): the append-only
// JSONL sidecar that makes agent loops durable across an engine bounce.
//
// WHY THIS EXISTS: a running agent loop is an OPEN CHAT POST — the SDK's
// session.prompt(), POST /session/{id}/message with a {parts:[...]} body,
// proxied through this service to the engine, and the response only closes
// when the turn completes (tens of minutes for a long campaign). The loops
// themselves live in the ENGINE process's memory, so the sanctioned deploy
// bounce (hub-restart.sh's systemctl restart → SIGTERM) kills every one of
// them at once, and an engine crash does the same. The service is the one
// layer that already SEES every in-flight turn — this module turns that
// visibility into state the next boot can act on:
//
//   track   — trackInflightChatTurn: a "start" line when a chat POST enters
//             the dispatch seam, an "end" line when the response closes
//             (fires on completion AND on client/upstream death — exactly
//             the two outcomes that must not be confused with a kill).
//   derive  — deriveInterruptedSessions (PURE: journal text → interrupted
//             set): a session is interrupted iff its latest start has no
//             matching end after it AND is within the recency window,
//             capped — a corrupted journal can never fan out unbounded work.
//   resume  — the runner's boot path (amicode_service_runner.ts) reads this
//             after engine health, fires ONE mechanical resume turn per
//             interrupted session (fire-and-forget), then clears the file.
//
// Because the journal is written THROUGH the request path, it inherits the
// service's never-crash-on-request discipline: every append is best-effort
// (try/catch, a sidecar may never become a dependency), and the derivation
// skips corrupt lines rather than failing the boot.
//
// CONFIG (the runner CLI's ENV SURFACE documents both):
//   AMICODE_INFLIGHT_JOURNAL  the journal path. Default
//                             ~/.amico/server/active-sessions.jsonl (the
//                             parent dirs are created on demand — a fresh
//                             hub has no ~/.amico/server yet).
//   AMICODE_RESUME_RECENT_MS  the recency window. Default 12h: an older
//                             start belongs to a loop the user abandoned —
//                             resuming yesterday's turn is noise, not
//                             continuity.
// ============================================================================
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type * as http from "node:http";

/** One journal line (JSONL): a chat turn opened ("start") or closed ("end")
 *  for a session, at the wall-clock millisecond it happened. */
export interface InflightJournalLine {
  kind: "start" | "end";
  sessionID: string;
  ts: number;
}

/** An interrupted session: the sessionID to re-dispatch and the ts of its
 *  latest unmatched start (the freshest evidence of the killed turn). */
export interface InterruptedSession {
  sessionID: string;
  ts: number;
}

/** #1552's resume cap: at most this many sessions are re-dispatched per boot.
 *  The journal is a sidecar, not a database — a corrupted or hostile file
 *  must never fan out unbounded resume turns. */
export const RESUME_CAP = 8;

/** #1552's default recency window: 12h. Overnight campaigns are the exact
 *  case this fix exists for; a start older than this is a stale artifact of
 *  some much earlier crash, not a loop to resurrect. */
export const RESUME_RECENT_MS_DEFAULT = 12 * 60 * 60 * 1000;

/** #1552's mechanical resume nudge — the issue's wording, exactly. The loop
 *  re-reads its own session ledger/state and continues; the nudge carries
 *  no new instructions (the campaign's own grammar owns what happens next). */
export const RESUME_MESSAGE =
  "[auto-resume] The engine restarted while your loop was in flight (issue #1552). Re-read your session ledger/state and continue exactly where you left off.";

/** The journal path (env AMICODE_INFLIGHT_JOURNAL → the ~/.amico default).
 *  Resolved per call — the late-bound seam convention, so a mid-process env
 *  change behaves like every other config carrier here. */
export function inflightJournalPath(): string {
  const env = (process.env.AMICODE_INFLIGHT_JOURNAL ?? "").trim();
  if (env !== "") return env;
  return join(homedir(), ".amico", "server", "active-sessions.jsonl");
}

/** The one tracked route (#1552): the SDK's session.prompt() —
 *  POST /session/{id}/message, the request whose response resolves only
 *  when the agent turn completes (verified against the vendored SDK gen at
 *  the manifest's upstream base: v1 names the path param {id}, v2 names it
 *  {sessionID} — the URL is the same). Returns the sessionID on a match.
 *  GETs, SSE, and every other session route observe or manage — they never
 *  carry a turn — so they stay untracked. */
export function matchInflightChatTurn(method: string | undefined, pathname: string): string | undefined {
  if (method !== "POST") return undefined;
  const m = /^\/session\/([^/]+)\/message$/.exec(pathname);
  return m === null ? undefined : m[1];
}

/** Best-effort append — NEVER throws into the request path (the service's
 *  founding discipline: a sidecar is a witness, not a dependency). Parent
 *  dirs are created on demand (~/.amico/server does not pre-exist). */
function appendJournalLine(path: string, line: InflightJournalLine): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(line) + "\n");
  } catch {
    /* best-effort by contract */
  }
}

/** The tracking hook (#1552): journal a "start" for `sessionID` now, and a
 *  matching "end" when the response closes. res "close" is the one event
 *  that fires on BOTH completion and death (client abort, upstream crash,
 *  the service's own SIGTERM) — which is exactly the pair that must leave
 *  the journal in the truthful state: an ended turn is never interrupted,
 *  a killed turn always is. */
export function trackInflightChatTurn(
  res: http.ServerResponse,
  sessionID: string,
  journalPath?: string,
): void {
  const journal = journalPath ?? inflightJournalPath();
  appendJournalLine(journal, { kind: "start", sessionID, ts: Date.now() });
  res.once("close", () => appendJournalLine(journal, { kind: "end", sessionID, ts: Date.now() }));
}

/** The derivation (#1552's pure core): journal text → the interrupted set.
 *  Grouped by sessionID in line order, a session is INTERRUPTED iff its
 *  latest start has no matching end after it, AND that start is within the
 *  recency window of `now`; the result is sorted freshest-start-first and
 *  capped. Corrupt/foreign lines are skipped — the derivation may never
 *  be the reason a boot fails. */
export function deriveInterruptedSessions(
  journalText: string,
  now: number,
  opts?: { recentMs?: number; cap?: number },
): InterruptedSession[] {
  const recentMs = opts?.recentMs ?? RESUME_RECENT_MS_DEFAULT;
  const cap = opts?.cap ?? RESUME_CAP;
  // sessionID → the ts of its latest UNMATCHED start (the only state that
  // matters: a matched end deletes the entry, a new start overwrites it).
  const open = new Map<string, number>();
  for (const raw of journalText.split("\n")) {
    const text = raw.trim();
    if (text === "") continue;
    let line: InflightJournalLine;
    try {
      line = JSON.parse(text) as InflightJournalLine;
    } catch {
      continue; // corrupt line: skip, never fatal
    }
    if (typeof line?.sessionID !== "string" || line.sessionID === "") continue;
    if (line.kind === "start" && typeof line.ts === "number") open.set(line.sessionID, line.ts);
    else if (line.kind === "end") open.delete(line.sessionID);
  }
  return [...open.entries()]
    .filter(([, ts]) => now - ts <= recentMs)
    .sort((a, b) => b[1] - a[1]) // freshest first: the cap keeps the most-recent victims
    .slice(0, cap)
    .map(([sessionID, ts]) => ({ sessionID, ts }));
}

/** The boot-side reader: derive from the journal FILE. A missing or
 *  unreadable journal is a clean boot (nothing was in flight), never a
 *  failed one — the resume step is continuity sugar, not a dependency. */
export function readInterruptedSessions(
  journalPath: string,
  now: number = Date.now(),
  opts?: { recentMs?: number; cap?: number },
): InterruptedSession[] {
  try {
    return deriveInterruptedSessions(readFileSync(journalPath, "utf8"), now, opts);
  } catch {
    return [];
  }
}

/** Clear the journal after a re-dispatch: the sessions have been handed
 *  their resume turns, so a subsequent boot must not double-resume them.
 *  Best-effort, same as every append. */
export function clearInflightJournal(journalPath: string): void {
  try {
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, "");
  } catch {
    /* best-effort by contract */
  }
}

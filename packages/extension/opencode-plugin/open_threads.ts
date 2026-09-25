// ============================================================================
// open_threads — derived open-thread digest for the onset context (#1305).
// Mechanizes the open-threads skill's classification step: sweep recent
// sessions and classify each surviving one into a bucket
// (blocked-on-user / awaiting-review / interrupted / parked / stale), then
// compose a small markdown block for prompt injection, rendered after the
// recent-sessions recap block in amicode_context.ts.
//
// RUNTIME: Bun-embedded opencode plugin. Imports: node:fs, node:path,
// node:os — plus bun:sqlite lazily (same guarded pattern as session_recap).
//
// CONSTRAINTS (#1305): deterministic, NO network, NO LLM, no DB writes —
// derived read-only per prompt build. PR-state is an INPUT feature map (the
// caller decides when to spend a network call); this module never fetches.
// Junk never surfaces; the block renders nothing when there are no open
// threads (honest empty state); the block is hard-capped.
//
// CLASSIFICATION ORDER (first match wins):
//   junk title        -> excluded entirely
//   blocked-on-user   -> last assistant text asks a question / states a
//                        waiting condition (report-only: the human owes it)
//   awaiting-review   -> PR-state input feature says a PR awaits review
//                        (report-only)
//   parked            -> pending todos (resume candidate; todo-carrying
//                        buckets may refine later)
//   interrupted       -> last text is mid-action with no wrap-up (prime
//                        resume candidate)
//   stale             -> any of the above, older than the stale threshold
//                        (age-derived; "retire unless you say otherwise")
//   no signal         -> not an open thread
//
// TEST SEAMS (all thresholds ride env seams, like the recap module's paths):
//   AMICODE_OPEN_THREADS_WINDOW_DAYS — sweep window (default 14)
//   AMICODE_OPEN_THREADS_MAX_THREADS — digest top-N cap (default 5)
//   AMICODE_OPEN_THREADS_STALE_DAYS  — stale age threshold (default 14)
//   OPENCODE_DB                      — DB path (shared with opencode itself)
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { NOISE_TITLE_PREFIXES, type SessionRow } from "./session_recap";

// ── Types (exported for testing) ─────────────────────────────────────────────

export type ThreadBucket =
  | "blocked-on-user"
  | "awaiting-review"
  | "interrupted"
  | "parked"
  | "stale";

/** PR-state as an INPUT feature — the caller's network spend, never fetched here. */
export type PrState = "awaiting-review" | "open" | "draft" | "merged" | "closed";

export interface ThreadFeatures {
  title: string;
  lastAssistantText: string;
  pendingTodos: number;
  prState?: PrState;
  ageDays: number;
}

export interface OpenThread {
  session_id: string;
  title: string;
  bucket: ThreadBucket;
  signal: string;
  created: string; // ISO
  ageDays: number;
  /** The thread-Noul (#1311) — an INPUT feature from the derived map the
   *  amico-run pass writes; undefined = no map entry = today's digest. */
  threadNoul?: number;
}

// ── Configuration (defaults + env seams) ─────────────────────────────────────

export const DEFAULT_WINDOW_DAYS = 14;
export const DEFAULT_MAX_THREADS = 5;
export const DEFAULT_STALE_DAYS = 14;

function resolvePositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (!raw || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveWindowDays(): number {
  return resolvePositiveInt("AMICODE_OPEN_THREADS_WINDOW_DAYS", DEFAULT_WINDOW_DAYS);
}

export function resolveMaxThreads(): number {
  return resolvePositiveInt("AMICODE_OPEN_THREADS_MAX_THREADS", DEFAULT_MAX_THREADS);
}

export function resolveStaleDays(): number {
  return resolvePositiveInt("AMICODE_OPEN_THREADS_STALE_DAYS", DEFAULT_STALE_DAYS);
}

// ── Junk-bucket vocabulary (#1305 AC5) ───────────────────────────────────────
// Single junk words match as whole leading words ("hi there" is junk, a title
// merely *containing* "hi" is not); multi-word phrases match as prefixes.
// The recap module's noise prefixes (Compaction) are folded in by reference.

export const JUNK_TITLE_WORDS = [
  "greeting",
  "hello",
  "hi",
  "hey",
  "howdy",
  "test",
  "scratch",
  "untitled",
  "new session",
];

export function isJunkTitle(title: string): boolean {
  const t = title.trim().toLowerCase();
  if (t === "") return true;
  if (NOISE_TITLE_PREFIXES.some(p => t.startsWith(p.toLowerCase()))) return true;
  // Whole leading word (or phrase) followed by a boundary — "hi there" is
  // junk, "hierarchy refactor" is not; "test: quick probe" is junk too.
  return JUNK_TITLE_WORDS.some(w => new RegExp(`^${w}(\\s|:|,|;|!|\\.|$)`).test(t));
}

// ── Classification vocabulary (pure, deterministic) ──────────────────────────

// The last assistant text asks the user a question or states a waiting
// condition — a decision, key, sign-off, or merge the human owes.
export const BLOCKED_PATTERNS = [
  /\bwaiting (on|for)\b/i,
  /\bsay the word\b/i,
  /\blet me know\b/i,
  /\byour (call|confirmation|sign-?off|decision|review)\b/i,
  /\bawaiting (your|user|confirmation|approval)\b/i,
  /\bwhich would you\b/i,
  /\bshall i\b/i,
  /\bwant me to\b/i,
  /\bdo you (want|prefer|need)\b/i,
];

// The session died mid-action: an unfinished step, no verdict, no wrap-up.
export const INTERRUPTED_PATTERNS = [
  /\b(in progress|running now|currently (running|solving|compiling|debugging|iterating))\b/i,
  /:\s*$/, // ends with a colon — a list intro with nothing after it
  /\.\.\.\s*$/, // trailing ellipsis
];

// An announced action in the final sentence that nothing completes.
const ANNOUNCED_ACTION_PATTERN = /\b(let me|i'll|i will|next,? (i|let's))\b/i;

// A wrap-up in the final sentence cancels the interrupted reading.
const WRAPPED_UP_PATTERN =
  /\b(done|finished|completed|complete|converged|landed|merged|shipped|banked|summary|in short|bravo)\b/i;

function lastSentence(text: string): string {
  const trimmed = text.trim();
  const parts = trimmed.split(/(?<=[.!?])\s+/);
  return parts[parts.length - 1] ?? trimmed;
}

function isBlockedSignal(text: string): boolean {
  if (text.trimEnd().endsWith("?")) return true;
  return BLOCKED_PATTERNS.some(p => p.test(text));
}

function isInterruptedSignal(text: string): boolean {
  const last = lastSentence(text);
  if (WRAPPED_UP_PATTERN.test(last)) return false;
  return INTERRUPTED_PATTERNS.some(p => p.test(text)) || ANNOUNCED_ACTION_PATTERN.test(last);
}

// ── Classification (pure, testable) ──────────────────────────────────────────

/**
 * Classify one session's features into a thread bucket, or null when it is
 * junk or carries no open signal. `staleAfterDays` is caller-resolved (env
 * seam) so this stays pure. PR-state is an input feature — never fetched here.
 */
export function classifyThread(features: ThreadFeatures, staleAfterDays: number): ThreadBucket | null {
  if (isJunkTitle(features.title)) return null;

  const bucket: ThreadBucket | null = isBlockedSignal(features.lastAssistantText)
    ? "blocked-on-user"
    : features.prState === "awaiting-review"
      ? "awaiting-review"
      : features.pendingTodos > 0
        ? "parked"
        : isInterruptedSignal(features.lastAssistantText)
          ? "interrupted"
          : null;

  if (bucket === null) return null;
  // Stale is age-derived: any open thread past the threshold retires into it.
  return features.ageDays > staleAfterDays ? "stale" : bucket;
}

/** Per-bucket one-line signal for the digest entry. */
function threadSignal(features: ThreadFeatures, bucket: ThreadBucket): string {
  switch (bucket) {
    case "blocked-on-user":
      return "waiting on you";
    case "awaiting-review":
      return "PR awaiting review";
    case "parked":
      return features.pendingTodos === 1
        ? "1 pending todo"
        : `${features.pendingTodos} pending todos`;
    case "interrupted":
      return "ended mid-action";
    case "stale":
      return "retire unless you say otherwise";
  }
}

/** Classify + assemble one OpenThread, or null when the session is not one. */
export function buildThread(
  sessionId: string,
  createdIso: string,
  features: ThreadFeatures,
  staleAfterDays: number,
): OpenThread | null {
  const bucket = classifyThread(features, staleAfterDays);
  if (bucket === null) return null;
  return {
    session_id: sessionId,
    title: features.title,
    bucket,
    signal: threadSignal(features, bucket),
    created: createdIso,
    ageDays: features.ageDays,
  };
}

// ── Digest composition (pure, testable) ──────────────────────────────────────

/** The thread-Noul promotion gate (#1311) — the curation spec's calibrated
 * pair (spec-20260920-session-curation §Calibration): a noul ≥ 0.5 promotes a
 * session into the open-thread surface (ranking + cap); below it is today's
 * behavior. Jev never derives a bucket label — promotion only. */
export const THREAD_NOUL_PROMOTION_MIN = 0.5;

const isPromoted = (t: OpenThread): boolean => t.threadNoul !== undefined && t.threadNoul >= THREAD_NOUL_PROMOTION_MIN;

/**
 * Compose the markdown block. Ordering (#1305, unchanged when no nouls):
 * non-stale threads newest-first (recency wins ties — input order preserved),
 * stale threads last (also newest-first, flagged). Capped at `maxThreads`.
 *
 * The #1311 thread-Noul rides as an INPUT feature: promoted threads (noul ≥
 * 0.5) rank ahead within their staleness group, BY NOUL DESC (Jev ranks the
 * surface), and win cap slots over mere recency — promotion INTO the
 * surface. A sub-threshold noul neither promotes nor drops (fail-open: no
 * Jev read ever removes a deterministically-surfaced thread). With no nouls
 * at all the ordering is exactly #1305's. Returns null when there are no
 * open threads — the honest empty state, no filler.
 */
export function composeOpenThreadsDigest(threads: OpenThread[], maxThreads: number): string | null {
  if (threads.length === 0) return null;

  const byAge = (a: OpenThread, b: OpenThread): number => a.ageDays - b.ageDays;
  const byNoulDesc = (a: OpenThread, b: OpenThread): number => (b.threadNoul ?? 0) - (a.threadNoul ?? 0) || byAge(a, b);
  const ordered = [
    ...threads.filter(t => t.bucket !== "stale" && isPromoted(t)).sort(byNoulDesc),
    ...threads.filter(t => t.bucket !== "stale" && !isPromoted(t)).sort(byAge),
    ...threads.filter(t => t.bucket === "stale" && isPromoted(t)).sort(byNoulDesc),
    ...threads.filter(t => t.bucket === "stale" && !isPromoted(t)).sort(byAge),
  ].slice(0, maxThreads);

  const lines = ["## Open threads", ""];
  for (const t of ordered) {
    const date = new Date(t.created);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    lines.push(`- **${t.bucket}** — ${dateStr} — ${t.title} — ${t.signal}${t.threadNoul !== undefined ? ` · noul ${t.threadNoul.toFixed(2)}` : ""}`);
  }
  return lines.join("\n");
}

// ── DB interaction (Bun-only, isolated for testability) ──────────────────────

/** Lazy-loaded Database class from bun:sqlite. Null on non-Bun runtimes. */
let SqliteDatabase: (new (path: string, opts?: { readonly?: boolean }) => any) | null = null;
try {
  SqliteDatabase = require("bun:sqlite").Database;
} catch {
  // Not running in Bun — DB access unavailable
}

const LAST_TEXT_MAX_CHARS = 3000;

/** Pull the session's last assistant text (the classification signal). */
function queryLastAssistantText(db: any, sessionId: string): string {
  try {
    const parts = db.prepare(`
      SELECT p.data FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE p.session_id = ?
        AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created DESC
      LIMIT 4
    `).all(sessionId) as Array<{ data: string }>;

    for (const row of parts) {
      try {
        const parsed = JSON.parse(row.data) as { text?: string };
        if (parsed.text && parsed.text.trim()) return parsed.text.slice(0, LAST_TEXT_MAX_CHARS);
      } catch { /* skip malformed part */ }
    }
  } catch { /* schema drift degrades to no text signal */ }
  return "";
}

/** Count the session's pending todos (opencode `todo` table). */
function queryPendingTodos(db: any, sessionId: string): number {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as cnt FROM todo WHERE session_id = ? AND status != 'completed'`,
    ).get(sessionId) as { cnt: number } | null;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The derived thread-Noul map's home (#1311): the amico-run curation pass
 *  (`amico sessions thread-noul`) writes it into the ops dir; the digest
 *  READS it (input feature — this module still makes no network call).
 *  $AMICODE_OPS_DIR → ~/.amico/amicode (the setup-state seam). */
export function threadNoulMapFile(opsDir?: string): string {
  const dir = opsDir ?? process.env.AMICODE_OPS_DIR ?? path.join(os.homedir(), ".amico", "amicode");
  return path.join(dir, "thread-nouls.json");
}

/** Read the derived noul map — Record<session_id, noul>, or undefined when
 *  the map is absent/corrupt (fail-open: the digest degrades to today). */
export function readThreadNoulMap(mapPath?: string): Record<string, number> | undefined {
  const resolved = mapPath ?? threadNoulMapFile();
  if (!fs.existsSync(resolved)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8")) as { entries?: Record<string, unknown> };
    if (parsed.entries === undefined || typeof parsed.entries !== "object") return undefined;
    const out: Record<string, number> = {};
    for (const [id, n] of Object.entries(parsed.entries)) {
      if (typeof n === "number" && Number.isFinite(n)) out[id] = n;
    }
    return out;
  } catch {
    return undefined;
  }
}

/**
 * Sweep recent sessions, classify open threads, compose the digest block.
 * `prStateFor` injects PR-state as an INPUT feature map per session — the
 * caller decides when to spend a network call; this module never fetches.
 * `threadNoulFor` (#1311) is the same seam for the derived thread-Noul map
 * (the amico-run pass spends the Jev calls; ranking + ≥ 0.5 promotion ride
 * the map, bucket labels stay deterministic). Returns null when there are
 * no open threads, the DB is unavailable (e.g. under Node/vitest), or on error.
 */
export function buildOpenThreadsBlock(
  currentSessionId?: string,
  prStateFor?: (sessionId: string) => PrState | undefined,
  threadNoulFor?: (sessionId: string) => number | undefined,
): string | null {
  if (!SqliteDatabase) return null;

  const dbPath = process.env.OPENCODE_DB;
  const resolved = dbPath && dbPath.trim() !== "" && dbPath !== ":memory:" && path.isAbsolute(dbPath)
    ? dbPath
    : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "opencode", "opencode.db");
  if (!fs.existsSync(resolved)) return null;

  let db: any;
  try {
    db = new SqliteDatabase(resolved, { readonly: true });
  } catch {
    return null;
  }

  try {
    const windowDays = resolveWindowDays();
    const staleAfterDays = resolveStaleDays();
    const maxThreads = resolveMaxThreads();
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

    const sessions = db.prepare(`
      SELECT id, title, parent_id, time_created, time_updated
      FROM session
      WHERE parent_id IS NULL
        AND time_archived IS NULL
        AND time_created > ?
      ORDER BY time_created DESC
      LIMIT ?
    `).all(cutoff, maxThreads * 4 + 10) as SessionRow[];

    if (sessions.length === 0) return null;

    const now = Date.now();
    const threads: OpenThread[] = [];
    for (const s of sessions) {
      if (currentSessionId && s.id === currentSessionId) continue;
      const ageDays = Math.max(0, (now - s.time_updated) / (24 * 60 * 60 * 1000));
      const thread = buildThread(
        s.id,
        new Date(s.time_created).toISOString(),
        {
          title: s.title,
          lastAssistantText: queryLastAssistantText(db, s.id),
          pendingTodos: queryPendingTodos(db, s.id),
          prState: prStateFor?.(s.id),
          ageDays,
        },
        staleAfterDays,
      );
      if (thread) {
        const noul = threadNoulFor?.(s.id);
        if (noul !== undefined) thread.threadNoul = noul;
        threads.push(thread);
      }
    }

    return composeOpenThreadsDigest(threads, maxThreads);
  } catch (e) {
    console.error(`[open-threads] failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

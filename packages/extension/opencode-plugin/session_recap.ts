// ============================================================================
// session_recap — reads recent sessions from the opencode SQLite DB, caches
// per-session summaries to disk, and composes a markdown block for prompt
// injection. Uses bun:sqlite (Bun built-in, no npm dep) for DB reads.
//
// RUNTIME: Bun-embedded opencode plugin. Imports: bun:sqlite, node:fs,
// node:path, node:os. No npm packages.
//
// The LLM summarization step is deferred to a future iteration — for now we
// extract a mechanical recap from message content (user prompts + assistant
// text parts). This gives us the full pipeline (DB → cache → markdown) without
// requiring an LLM call inside the plugin, which would need provider config
// the plugin doesn't have access to. The mechanical extract is good enough for
// the onset router to personalize the greeting.
//
// TEST SEAMS:
//   AMICODE_SESSION_RECAP_CACHE_DIR — override the cache directory
//   OPENCODE_DB — override the DB path (shared with opencode itself)
// ============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── Types (exported for testing) ─────────────────────────────────────────────

export interface SessionRow {
  id: string;
  title: string;
  parent_id: string | null;
  time_created: number;
  time_updated: number;
}

export interface SessionRecap {
  session_id: string;
  title: string;
  created: string; // ISO
  recap: string;
  summarized_at: string; // ISO
}

// ── Configuration ────────────────────────────────────────────────────────────

export const RECAP_WINDOW_DAYS = 7;
export const MAX_RECAPS = 10;
export const MIN_ASSISTANT_MESSAGES = 2;

/** Resolve the effective recap window in days. Reads AMICODE_SESSION_RECAP_WINDOW_DAYS
 *  from the environment; falls back to RECAP_WINDOW_DAYS if unset or invalid. */
export function resolveWindowDays(): number {
  const raw = process.env.AMICODE_SESSION_RECAP_WINDOW_DAYS;
  if (raw == null || raw.trim() === "") return RECAP_WINDOW_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return RECAP_WINDOW_DAYS;
  return parsed;
}

// Titles that indicate noise sessions (internal housekeeping)
export const NOISE_TITLE_PREFIXES = ["Compaction", "compaction"];

// ── Path resolution (seam-based, like stack_state.ts) ────────────────────────

export function resolveCacheDir(): string {
  const env = process.env.AMICODE_SESSION_RECAP_CACHE_DIR;
  if (env && env.trim() !== "") return env.trim();
  return path.join(os.homedir(), ".amico", "session-recaps");
}

export function resolveDbPath(): string {
  const env = process.env.OPENCODE_DB;
  if (env && env.trim() !== "" && env !== ":memory:") {
    if (path.isAbsolute(env)) return env;
    const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    return path.join(xdgData, "opencode", env);
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(xdgData, "opencode", "opencode.db");
}

// ── Cache ────────────────────────────────────────────────────────────────────

function ensureCacheDir(): boolean {
  try {
    fs.mkdirSync(resolveCacheDir(), { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function cachePathFor(sessionId: string): string {
  return path.join(resolveCacheDir(), `${sessionId}.json`);
}

export function readCachedRecap(sessionId: string): SessionRecap | null {
  try {
    const raw = fs.readFileSync(cachePathFor(sessionId), "utf8");
    return JSON.parse(raw) as SessionRecap;
  } catch {
    return null;
  }
}

export function writeCachedRecap(recap: SessionRecap): void {
  try {
    ensureCacheDir();
    const tmp = cachePathFor(recap.session_id) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(recap, null, 2), "utf8");
    fs.renameSync(tmp, cachePathFor(recap.session_id));
  } catch {
    // Cache write failure is non-fatal
  }
}

// ── Filtering (pure, testable) ───────────────────────────────────────────────

/** Filter sessions per the issue's acceptance criteria. */
export function filterCandidates(
  sessions: SessionRow[],
  currentSessionId: string | undefined,
  assistantCountFn: (sessionId: string) => number,
): SessionRow[] {
  const candidates: SessionRow[] = [];
  for (const s of sessions) {
    if (currentSessionId && s.id === currentSessionId) continue;
    if (NOISE_TITLE_PREFIXES.some(p => s.title.startsWith(p))) continue;
    if (assistantCountFn(s.id) < MIN_ASSISTANT_MESSAGES) continue;
    candidates.push(s);
    if (candidates.length >= MAX_RECAPS) break;
  }
  return candidates;
}

// ── Mechanical recap extraction (pure, testable) ─────────────────────────────

/** Extract key outcomes from assistant text parts. */
export function extractOutcomes(assistantTexts: string[]): string[] {
  const outcomes: string[] = [];
  for (const text of assistantTexts) {
    // Look for fidelity values
    const fMatch = text.match(/[Ff]\s*[=:≈]\s*(0\.9\d+|1\.0)/);
    if (fMatch && !outcomes.some(o => o.includes("F="))) {
      outcomes.push(`F=${fMatch[1]}`);
    }

    // Look for iteration counts
    const iterMatch = text.match(/(\d+)\s*iteration/i);
    if (iterMatch && !outcomes.some(o => o.includes("iter"))) {
      outcomes.push(`${iterMatch[1]} iterations`);
    }

    // Look for infidelity
    const infMatch = text.match(/infidelity\s*[=:≈]\s*([\d.]+[eE][-+]?\d+)/);
    if (infMatch && !outcomes.some(o => o.includes("infidelity"))) {
      outcomes.push(`infidelity ${infMatch[1]}`);
    }
  }
  return outcomes;
}

/** Compose a recap string from user prompts and extracted outcomes. */
export function composeRecapText(userTexts: string[], outcomes: string[]): string | null {
  if (userTexts.length === 0) return null;

  const firstPrompt = userTexts[0].slice(0, 120).replace(/\n/g, " ");
  const promptSummary = userTexts.length > 1
    ? `${firstPrompt}... (+${userTexts.length - 1} more turns)`
    : firstPrompt;

  const parts = [promptSummary];
  if (outcomes.length > 0) {
    parts.push(outcomes.join(", "));
  }

  return parts.join(". ");
}

// ── Markdown composition (pure, testable) ────────────────────────────────────

export function composeMarkdown(recaps: SessionRecap[], windowDays?: number): string {
  const days = windowDays ?? resolveWindowDays();
  const lines = [`## Recent sessions (last ${days} days)`, ""];

  for (const r of recaps) {
    const date = new Date(r.created);
    const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const timeStr = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    const titlePart = r.title && r.title !== "New Session" ? `**${r.title}** — ` : "";
    lines.push(`- **${dateStr}, ${timeStr}** — ${titlePart}${r.recap}`);
  }

  return lines.join("\n");
}

// ── DB interaction (Bun-only, isolated for testability) ──────────────────────

/** Lazy-loaded Database class from bun:sqlite. Null on non-Bun runtimes. */
let SqliteDatabase: (new (path: string, opts?: { readonly?: boolean }) => any) | null = null;
try {
  // bun:sqlite is a Bun built-in — this import resolves only in the Bun runtime
  // (opencode's embedded plugin runner). Under Node/vitest it throws and we
  // gracefully degrade (buildRecentSessionsBlock returns null).
  SqliteDatabase = require("bun:sqlite").Database;
} catch {
  // Not running in Bun — DB access unavailable
}

/** Query user-prompt and assistant texts from a session. Returns null if DB unavailable. */
function querySessionContent(db: any, sessionId: string): { userTexts: string[]; assistantTexts: string[] } | null {
  try {
    // Get user text parts
    const userParts = db.prepare(`
      SELECT p.data FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE p.session_id = ?
        AND json_extract(m.data, '$.role') = 'user'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created ASC
    `).all(sessionId) as Array<{ data: string }>;

    const userTexts: string[] = [];
    for (const row of userParts) {
      try {
        const parsed = JSON.parse(row.data) as { text?: string };
        if (parsed.text && parsed.text.trim()) {
          userTexts.push(parsed.text.trim());
        }
      } catch { /* skip */ }
    }

    // Get assistant text parts (latest first)
    const assistantParts = db.prepare(`
      SELECT p.data FROM part p
      JOIN message m ON p.message_id = m.id
      WHERE p.session_id = ?
        AND json_extract(m.data, '$.role') = 'assistant'
        AND json_extract(p.data, '$.type') = 'text'
      ORDER BY p.time_created DESC
      LIMIT 10
    `).all(sessionId) as Array<{ data: string }>;

    const assistantTexts: string[] = [];
    for (const row of assistantParts) {
      try {
        const parsed = JSON.parse(row.data) as { text?: string };
        if (parsed.text) assistantTexts.push(parsed.text);
      } catch { /* skip */ }
    }

    return { userTexts, assistantTexts };
  } catch {
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * List recent sessions, generate/cache recaps, compose a markdown block.
 * Returns null if there are no recent sessions, DB is unavailable, or on error.
 */
export function buildRecentSessionsBlock(currentSessionId?: string): string | null {
  if (!SqliteDatabase) return null;

  const dbPath = resolveDbPath();
  if (!fs.existsSync(dbPath)) return null;

  let db: any;
  try {
    db = new SqliteDatabase(dbPath, { readonly: true });
  } catch {
    return null;
  }

  try {
    const windowDays = resolveWindowDays();
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

    // Query recent sessions: non-subagent, non-archived, within window
    const sessions = db.prepare(`
      SELECT id, title, parent_id, time_created, time_updated
      FROM session
      WHERE parent_id IS NULL
        AND time_archived IS NULL
        AND time_created > ?
      ORDER BY time_created DESC
      LIMIT ?
    `).all(cutoff, MAX_RECAPS + 5) as SessionRow[];

    if (sessions.length === 0) return null;

    // Filter candidates
    const assistantCountFn = (sessionId: string): number => {
      const row = db.prepare(`
        SELECT COUNT(*) as cnt FROM message
        WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant'
      `).get(sessionId) as { cnt: number } | null;
      return row?.cnt ?? 0;
    };

    const candidates = filterCandidates(sessions, currentSessionId, assistantCountFn);
    if (candidates.length === 0) return null;

    // Generate recaps (cached or fresh)
    const recaps: SessionRecap[] = [];
    for (const s of candidates) {
      const cached = readCachedRecap(s.id);
      if (cached) {
        recaps.push(cached);
        continue;
      }

      const content = querySessionContent(db, s.id);
      if (!content || content.userTexts.length === 0) continue;

      const outcomes = extractOutcomes(content.assistantTexts);
      const recapText = composeRecapText(content.userTexts, outcomes);
      if (!recapText) continue;

      const recap: SessionRecap = {
        session_id: s.id,
        title: s.title,
        created: new Date(s.time_created).toISOString(),
        recap: recapText,
        summarized_at: new Date().toISOString(),
      };

      writeCachedRecap(recap);
      recaps.push(recap);
    }

    if (recaps.length === 0) return null;

    return composeMarkdown(recaps, windowDays);
  } catch (e) {
    console.error(`[session-recap] failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

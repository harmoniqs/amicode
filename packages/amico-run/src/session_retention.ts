// session_retention.ts — D4 (spec-20260905-045114) slice 3, pure core: the
// retention policy's workspace preference + the session-index renderer.
//
// Retention RELOCATES, never deletes (D4 invariant): the archive command moves
// sessions from the active tail to the archived set by stamping the engine's
// `time_archived` field — the same field the vendored engine's list endpoint
// already filters on — and restore clears it. Deletion is out of the
// vocabulary. Archive affects product lists only; the vault ledger plane and
// the coordination board are separate transports this module never touches.
//
// The archive cutoff is a WORKSPACE PREFERENCE, not a constant: it lives in
// `$AMICODE_OPS_DIR/session-retention.json` (default `~/.amico/amicode/`),
// the same ops-dir convention as solver-mode.json. Reads fail SAFE to the 30-day
// default on an absent, malformed, or out-of-range file — a corrupt preference
// must never widen what gets archived. The #1304 autoarchive age gate (hours)
// shares this file under `autoarchive_hours` (default 48 h, same fail-safe).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ARCHIVE_DAYS = 30;

/** The autoarchive age gate in hours (#1304): a junk-bucket session must be
 *  silent this long before the nightly curation relocates it. */
export const DEFAULT_AUTOARCHIVE_HOURS = 48;

export function amicodeOpsDir(env: NodeJS.ProcessEnv): string {
  const v = env.AMICODE_OPS_DIR;
  return v && v.trim() !== "" ? v : join(homedir(), ".amico", "amicode");
}

export function retentionPrefsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(amicodeOpsDir(env), "session-retention.json");
}

/** The parsed preference file, or {} on absence/malformation — every reader
 *  fails SAFE to its own default; a corrupt preference must never widen what
 *  gets archived. */
function readPrefs(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(retentionPrefsFile(env), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function positiveInteger(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

/** The archive cutoff in days. Fails safe to DEFAULT_ARCHIVE_DAYS. */
export function readArchiveDays(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(readPrefs(env).archive_days) ?? DEFAULT_ARCHIVE_DAYS;
}

/** The autoarchive age gate in hours. Fails safe to DEFAULT_AUTOARCHIVE_HOURS. */
export function readAutoArchiveHours(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(readPrefs(env).autoarchive_hours) ?? DEFAULT_AUTOARCHIVE_HOURS;
}

export type WritePrefsResult = { ok: true; file: string; days: number } | { ok: false; error: string };

/** Write one numeric preference key, preserving the file's other keys (the
 *  archive-days and autoarchive-hours gates share one ops-dir JSON file). */
function writePrefsValue(key: string, value: number, label: string, env: NodeJS.ProcessEnv): WritePrefsResult {
  if (!Number.isInteger(value) || value < 1) {
    return { ok: false, error: `${label} must be a positive integer, got ${value}` };
  }
  const file = retentionPrefsFile(env);
  const next = { schema_version: 1, ...readPrefs(env), [key]: value };
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, file, days: value };
}

export function writeArchiveDays(days: number, env: NodeJS.ProcessEnv = process.env): WritePrefsResult {
  return writePrefsValue("archive_days", days, "archive_days", env);
}

export function writeAutoArchiveHours(hours: number, env: NodeJS.ProcessEnv = process.env): WritePrefsResult {
  return writePrefsValue("autoarchive_hours", hours, "autoarchive_hours", env);
}

// ── the generated session index (pure renderer) ─────────────────────────────

/** One session row as the index consumes it — exactly the fields the DB query
 *  returns. Directory provenance is carried in full; the table renders the
 *  basename (the hand-written reference shape), the distribution header carries
 *  the full paths. */
export interface IndexSession {
  id: string;
  title: string;
  directory: string;
  time_updated: number;
  time_archived: number | null;
}

export interface IndexInput {
  generated_at: string;
  source_db: string;
  sessions: IndexSession[];
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Render SESSION-INDEX.md. Deterministic: month sections newest-first, rows
 *  newest-first with id as tie-break. Every row in the DB appears exactly once;
 *  archived rows carry their state in the table, and the distribution header
 *  carries the directory provenance + visible/archived counts. */
export function renderSessionIndex(input: IndexInput): string {
  const { sessions } = input;
  const visible = sessions.filter((s) => s.time_archived === null).length;
  const archived = sessions.length - visible;

  const byDir = new Map<string, number>();
  for (const s of sessions) byDir.set(s.directory, (byDir.get(s.directory) ?? 0) + 1);
  const dirs = [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const byMonth = new Map<string, IndexSession[]>();
  for (const s of sessions) {
    const m = monthOf(s.time_updated);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(s);
  }
  const months = [...byMonth.keys()].sort().reverse();

  const lines: string[] = [];
  lines.push("# Session index");
  lines.push("");
  lines.push(
    `*Generated ${input.generated_at} from the chat DB at \`${input.source_db}\` — ` +
      `${sessions.length} sessions: ${visible} visible · ${archived} archived.`,
  );
  lines.push(
    "Archived sessions are hidden from default lists (query: `amico sessions list --archived`; " +
      "restore: `amico sessions restore <id>`). Retention relocates — nothing is ever deleted.",
  );
  lines.push(`Directory provenance — ${dirs.length} ${dirs.length === 1 ? "directory" : "directories"}:`);
  for (const [dir, n] of dirs) lines.push(`- \`${dir}\` — ${n} ${n === 1 ? "session" : "sessions"}`);
  lines.push("Generated by `amico sessions index`; regenerate, never edit by hand.*");
  lines.push("");

  for (const m of months) {
    lines.push(`## ${m}`);
    lines.push("");
    lines.push("| last active | title | home | state | id |");
    lines.push("|---|---|---|---|---|");
    const rows = byMonth.get(m)!.sort((a, b) => b.time_updated - a.time_updated || a.id.localeCompare(b.id));
    for (const s of rows) {
      const state = s.time_archived === null ? "active" : "archived";
      const title = s.title.replace(/\|/g, "\\|");
      lines.push(`| ${dayOf(s.time_updated)} | ${title} | ${basename(s.directory)} | ${state} | \`${s.id}\` |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

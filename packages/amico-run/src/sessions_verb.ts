// sessions_verb.ts — `amico sessions` (D4 slice 3, issue #795): the retention
// lifecycle as a CLI verb — list (visibility rules), archive (relocate, never
// delete), restore (clear one field), index (generate SESSION-INDEX.md).
//
// The engine owns the archived-field mechanics (time_archived on the session
// table; its list endpoint's archived query param). THIS is the product layer:
// the visibility rules the product respects, the retention policy as a
// workspace preference, and the generated session index — over the chat DB
// the hub serves. The vault ledger plane and the coordination board are
// separate transports; this verb never reads or writes them (D4 disjointness).
//
// DB ACCESS CONVENTION (mirrors the open-threads skill, the store's other
// reader): `--db` flag → $OPENCODE_DB → ~/.local/share/opencode/opencode.db.
// Reads open READ-ONLY. Writes (archive --apply / restore) open read-write —
// the verb is the deterministic surface for what the 2026-09-05 consolidation
// did by hand SQL. `archive` is DRY-RUN BY DEFAULT: an agent running it
// against the live DB without --apply must not relocate anything.
//
// node:sqlite is imported lazily (inside openDb): it must never enter vitest's
// module graph (vite-node's builtin list predates it), and on node < 22.5 the
// verb degrades to an honest usage error instead of a crash.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readArchiveDays,
  renderSessionIndex,
  writeArchiveDays,
  type IndexSession,
} from "./session_retention.js";
import type { VerbResult } from "./verbs.js";

export const DEFAULT_LIST_LIMIT = 100;

const nodeRequire = createRequire(import.meta.url);

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

/** `--db` flag → $OPENCODE_DB → the XDG default. Same resolution order the
 *  open-threads skill documents for the store's readers. */
export function resolveSessionDb(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const flag = flagValue(argv, "--db");
  if (flag) return flag;
  const envDb = env.OPENCODE_DB;
  if (envDb && envDb.trim() !== "") return envDb;
  return join(env.XDG_DATA_HOME && env.XDG_DATA_HOME.trim() !== "" ? join(env.XDG_DATA_HOME, "opencode") : join(homedir(), ".local", "share", "opencode"), "opencode.db");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

function openDb(path: string, readOnly: boolean): Db {
  const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
  return new DatabaseSync(path, { readOnly });
}

function fail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "sessions", error, ...extra }, code: 64 };
}

interface SessionRow {
  id: string;
  parent_id: string | null;
  directory: string;
  title: string;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
}

function fetchPage(db: Db, where: string, params: unknown[], limit: number, cursor: number): { rows: SessionRow[]; total: number } {
  const total = (db.prepare(`SELECT count(*) AS n FROM session WHERE ${where}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT id, parent_id, directory, title, time_created, time_updated, time_archived
       FROM session WHERE ${where} ORDER BY time_updated DESC, id LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, cursor) as SessionRow[];
  return { rows, total };
}

// ── list ────────────────────────────────────────────────────────────────────

function sessionsList(argv: string[]): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const archived = hasFlag(argv, "--archived");
  const limit = Math.min(Math.max(Number(flagValue(argv, "--limit") ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), 1000);
  const cursor = Number(flagValue(argv, "--cursor") ?? 0) || 0;

  const db = openDb(dbPath, true);
  try {
    const where = archived ? "time_archived IS NOT NULL" : "time_archived IS NULL";
    const { rows, total } = fetchPage(db, where, [], limit, cursor);
    const next = cursor + rows.length;
    return {
      json: {
        verb: "sessions",
        subcommand: "list",
        archived,
        count: rows.length,
        total,
        next_cursor: next < total ? next : null,
        sessions: rows.map((r) => ({ ...r, archived: r.time_archived !== null })),
      },
      code: 0,
    };
  } finally {
    db.close();
  }
}

// ── archive (relocate; dry-run by default) ──────────────────────────────────

function sessionsArchive(argv: string[], env: NodeJS.ProcessEnv): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const days = flagValue(argv, "--days") ? Number(flagValue(argv, "--days")) : readArchiveDays(env);
  if (!Number.isInteger(days) || days < 1) return fail(`--days must be a positive integer, got ${days}`);
  const apply = hasFlag(argv, "--apply");
  const cutoff = Date.now() - days * 86_400_000;

  const db = openDb(dbPath, !apply);
  try {
    const candidates = (
      db
        .prepare("SELECT id FROM session WHERE time_archived IS NULL AND time_updated < ? ORDER BY time_updated DESC, id")
        .all(cutoff) as { id: string }[]
    ).map((r) => r.id);
    if (apply) {
      db.prepare("UPDATE session SET time_archived = ? WHERE time_archived IS NULL AND time_updated < ?").run(Date.now(), cutoff);
    }
    return {
      json: {
        verb: "sessions",
        subcommand: "archive",
        dry_run: !apply,
        days,
        cutoff_ms: cutoff,
        cutoff_iso: new Date(cutoff).toISOString(),
        candidates: candidates.length,
        candidate_ids: candidates.slice(0, 50),
        archived: apply ? candidates.length : 0,
        note: apply ? undefined : "dry-run: nothing written — pass --apply to stamp time_archived",
      },
      code: 0,
    };
  } finally {
    db.close();
  }
}

// ── restore (clear the one field) ───────────────────────────────────────────

function sessionsRestore(argv: string[]): VerbResult {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) return fail("session id is required: amico sessions restore <session-id>");
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);

  const db = openDb(dbPath, false);
  try {
    const row = db.prepare("SELECT time_archived FROM session WHERE id = ?").get(id) as { time_archived: number | null } | undefined;
    if (!row) return fail(`no such session: ${id}`);
    if (row.time_archived === null) return { json: { verb: "sessions", subcommand: "restore", session_id: id, restored: false }, code: 0 };
    db.prepare("UPDATE session SET time_archived = NULL WHERE id = ?").run(id);
    return { json: { verb: "sessions", subcommand: "restore", session_id: id, restored: true }, code: 0 };
  } finally {
    db.close();
  }
}

// ── index (generate; never author) ──────────────────────────────────────────

function sessionsIndex(argv: string[]): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const out = flagValue(argv, "--out") ?? "SESSION-INDEX.md";

  const db = openDb(dbPath, true);
  try {
    const rows = db
      .prepare(
        "SELECT id, directory, title, time_updated, time_archived FROM session ORDER BY time_updated DESC, id",
      )
      .all() as IndexSession[];
    const visible = rows.filter((r) => r.time_archived === null).length;
    const markdown = renderSessionIndex({
      generated_at: new Date().toISOString(),
      source_db: dbPath,
      sessions: rows,
    });
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, markdown);
    return {
      json: {
        verb: "sessions",
        subcommand: "index",
        path: out,
        sessions_indexed: rows.length,
        visible,
        archived: rows.length - visible,
        source_db: dbPath,
      },
      code: 0,
    };
  } finally {
    db.close();
  }
}

// ── prefs (the workspace preference surface) ────────────────────────────────

function sessionsPrefs(argv: string[], env: NodeJS.ProcessEnv): VerbResult {
  const days = flagValue(argv, "--days");
  if (days !== undefined) {
    const n = Number(days);
    const w = writeArchiveDays(n, env);
    if (!w.ok) return fail(w.error);
    return { json: { verb: "sessions", subcommand: "prefs", archive_days: w.days, file: w.file }, code: 0 };
  }
  return {
    json: { verb: "sessions", subcommand: "prefs", archive_days: readArchiveDays(env), file: join(env.AMICODE_OPS_DIR && env.AMICODE_OPS_DIR.trim() !== "" ? env.AMICODE_OPS_DIR : join(homedir(), ".amico", "amicode"), "session-retention.json") },
    code: 0,
  };
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function sessionsVerb(argv: string[]): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const env = process.env;
  try {
    switch (sub) {
      case "list":
        return sessionsList(rest);
      case "archive":
        return sessionsArchive(rest, env);
      case "restore":
        return sessionsRestore(rest);
      case "index":
        return sessionsIndex(rest);
      case "prefs":
        return sessionsPrefs(rest, env);
      default:
        return {
          json: {
            verb: "sessions",
            error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
            usage:
              "amico sessions list [--archived] [--limit <n>] [--cursor <c>] [--db <path>]  |  amico sessions archive [--days <n>] [--apply]  |  amico sessions restore <id>  |  amico sessions index [--out <path>]  |  amico sessions prefs [--days <n>]",
          },
          code: 64,
        };
    }
  } catch (e) {
    // node:sqlite unavailable (node < 22.5) or a DB-level fault: honest failure,
    // never a crash — and never a silent fallthrough to the wrong answer.
    return fail(`sessions ${sub} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

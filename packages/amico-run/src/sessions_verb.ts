// sessions_verb.ts — `amico sessions` (D4 slice 3, issue #795): the retention
// lifecycle as a CLI verb — list (visibility rules), archive (relocate, never
// delete), autoarchive (the #1304 classification-gated nightly flow), restore
// (clear one field), index (generate SESSION-INDEX.md).
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
// The driver is the python3 stdlib sqlite3 bridge (src/sqlite_bridge.ts) —
// NOT node:sqlite, which does not exist on the repo's CI node (20.x). See the
// bridge module header for the full rationale.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readArchiveDays,
  readAutoArchiveHours,
  renderSessionIndex,
  retentionPrefsFile,
  writeArchiveDays,
  writeAutoArchiveHours,
  type IndexSession,
} from "./session_retention.js";
import { classifySession, type SessionFeatures } from "./session_junk.js";
import { jevArchiveAdmits, jevJunkResidual, type JevPassStatus, type ResidualSession, type ResidualVerdict } from "./jev_curation.js";
import { jevDisabled } from "./jev_client.js";
import { sqliteBatch, type BridgeStatement } from "./sqlite_bridge.js";
import type { VerbResult } from "./verbs.js";

export const DEFAULT_LIST_LIMIT = 100;

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

function rowOf(r: Record<string, unknown>): SessionRow {
  return {
    id: String(r.id),
    parent_id: (r.parent_id as string | null) ?? null,
    directory: String(r.directory),
    title: String(r.title),
    time_created: Number(r.time_created),
    time_updated: Number(r.time_updated),
    time_archived: r.time_archived === null || r.time_archived === undefined ? null : Number(r.time_archived),
  };
}

// ── list ────────────────────────────────────────────────────────────────────

function sessionsList(argv: string[]): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const archived = hasFlag(argv, "--archived");
  const limit = Math.min(Math.max(Number(flagValue(argv, "--limit") ?? DEFAULT_LIST_LIMIT) || DEFAULT_LIST_LIMIT, 1), 1000);
  const cursor = Number(flagValue(argv, "--cursor") ?? 0) || 0;
  const where = archived ? "time_archived IS NOT NULL" : "time_archived IS NULL";

  let batch;
  try {
    batch = sqliteBatch(dbPath, "ro", [
      { sql: `SELECT count(*) AS n FROM session WHERE ${where}` },
      {
        sql: `SELECT id, parent_id, directory, title, time_created, time_updated, time_archived
              FROM session WHERE ${where} ORDER BY time_updated DESC, id LIMIT ? OFFSET ?`,
        params: [limit, cursor],
      },
    ]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const rows = batch.results[1].rows.map(rowOf);
  const total = Number(batch.results[0].rows[0]?.n ?? 0);
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
}

// ── archive (relocate; dry-run by default) ──────────────────────────────────

function sessionsArchive(argv: string[], env: NodeJS.ProcessEnv): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const days = flagValue(argv, "--days") ? Number(flagValue(argv, "--days")) : readArchiveDays(env);
  if (!Number.isInteger(days) || days < 1) return fail(`--days must be a positive integer, got ${days}`);
  const apply = hasFlag(argv, "--apply");
  const cutoff = Date.now() - days * 86_400_000;

  const statements: BridgeStatement[] = [
    {
      sql: "SELECT id FROM session WHERE time_archived IS NULL AND time_updated < ? ORDER BY time_updated DESC, id",
      params: [cutoff],
    },
  ];
  if (apply) {
    statements.push({
      sql: "UPDATE session SET time_archived = ? WHERE time_archived IS NULL AND time_updated < ?",
      params: [Date.now(), cutoff],
    });
  }

  let batch;
  try {
    batch = sqliteBatch(dbPath, apply ? "rw" : "ro", statements);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const candidates = batch.results[0].rows.map((r) => String(r.id));
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
      archived: apply ? Number(batch.results[1]?.changes ?? candidates.length) : 0,
      note: apply ? undefined : "dry-run: nothing written — pass --apply to stamp time_archived",
    },
    code: 0,
  };
}

// ── autoarchive (#1304: classification-gated, age-gated curation) ───────────

// The feature query: per age-eligible unarchived session, map the DB rows into
// the #1303 classifier's SessionFeatures — message roles live in message.data
// JSON, user text in the type:"text" parts of user messages, pending todos in
// the todo plane (status != 'completed', the open-threads reader convention).
const AUTOARCHIVE_FEATURES_SQL = `
  SELECT s.id, s.title, s.time_updated,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id
       AND json_extract(m.data, '$.role') = 'user') AS user_message_count,
    (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id
       AND json_extract(m.data, '$.role') = 'assistant') AS assistant_message_count,
    (SELECT COALESCE(SUM(length(json_extract(p.data, '$.text'))), 0)
       FROM part p JOIN message m ON m.id = p.message_id
       WHERE p.session_id = s.id AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text') AS user_text_chars,
    (SELECT COUNT(*) FROM todo t WHERE t.session_id = s.id
       AND t.status != 'completed') AS todo_count
  FROM session s
  WHERE s.time_archived IS NULL AND s.time_updated < ?
  ORDER BY s.time_updated DESC, s.id`;

// ── autoarchive (#1304 + #1311): classification-gated curation with the Jev
//    classifier residual as the confidence-gated middle layer ───────────────

/** The jev residual pass over rule-unclassified sessions — injectable so the
 * suite runs hermetically (the default is the real client, key read at call
 * time from the secrets path; disabled/unavailable → fail-open). */
export interface AutoarchiveDeps {
  jev?: (sessions: ResidualSession[]) => Promise<{ status: JevPassStatus; verdicts: Record<string, ResidualVerdict> }>;
}

export async function sessionsAutoarchive(argv: string[], env: NodeJS.ProcessEnv, deps: AutoarchiveDeps = {}): Promise<VerbResult> {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const hours = flagValue(argv, "--hours") ? Number(flagValue(argv, "--hours")) : readAutoArchiveHours(env);
  if (!Number.isInteger(hours) || hours < 1) return fail(`--hours must be a positive integer, got ${hours}`);
  const apply = hasFlag(argv, "--apply");
  const cutoff = Date.now() - hours * 3_600_000;

  let batch;
  try {
    batch = sqliteBatch(dbPath, "ro", [{ sql: AUTOARCHIVE_FEATURES_SQL, params: [cutoff] }]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // The caller-side mapping the #1303 classifier requires: rows → features →
  // bucket, in THIS module (the classifier stays a pure function of features).
  const judged = batch.results[0].rows.map((r) => {
    const features: SessionFeatures = {
      title: String(r.title),
      user_message_count: Number(r.user_message_count),
      user_text_chars: Number(r.user_text_chars),
      assistant_message_count: Number(r.assistant_message_count),
      todo_count: Number(r.todo_count),
    };
    return { id: String(r.id), bucket: classifySession(features), features, time_updated: Number(r.time_updated) };
  });
  const buckets = judged.reduce<Record<string, number>>((acc, j) => {
    acc[j.bucket] = (acc[j.bucket] ?? 0) + 1;
    return acc;
  }, {});
  // Deterministic junk first — the #1304 rule, first and untouched. Jev NEVER
  // re-judges a session the rules already classified (residual-only wiring).
  const ids = judged.filter((j) => j.bucket !== "substantive").map((j) => j.id);

  // ── the #1311 residual: the middle layer, additive and fail-open ─────────
  // Sessions the rules left unclassified (substantive = no junk rule fired)
  // get ONE Jev Choice; a junk-bucket read at p ≥ 0.95 AND age ≥ 48 h (the
  // FIXED gate, never the scan cutoff) admits to the archive path as an OR.
  // The off-switch (AMICO_JEV_DISABLED) skips the pass entirely — the output
  // is byte-identical to the deterministic shape (zero behavioral delta).
  const jevReport: Record<string, unknown> | undefined = await runJunkResidual(judged, env, deps);
  const admittedIds = Array.isArray(jevReport?.admitted_ids) ? (jevReport.admitted_ids as string[]) : [];
  const allIds = [...ids, ...admittedIds];

  if (apply && allIds.length > 0) {
    try {
      sqliteBatch(dbPath, "rw", [
        {
          sql: `UPDATE session SET time_archived = ? WHERE time_archived IS NULL AND id IN (${allIds.map(() => "?").join(",")})`,
          params: [Date.now(), ...allIds],
        },
      ]);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    json: {
      verb: "sessions",
      subcommand: "autoarchive",
      dry_run: !apply,
      hours,
      cutoff_ms: cutoff,
      cutoff_iso: new Date(cutoff).toISOString(),
      scanned: judged.length,
      buckets,
      candidates: allIds.length,
      candidate_ids: allIds.slice(0, 50),
      archived: apply ? allIds.length : 0,
      note: apply ? undefined : "dry-run: nothing written — pass --apply to stamp time_archived",
      ...(jevReport !== undefined ? { jev: jevReport } : {}),
    },
    code: 0,
  };
}

/** The residual step, isolated: returns the jev report block (undefined when
 * the path is disabled — the zero-delta off-switch), never throws (fail-open:
 * an error report still archives the deterministic candidates). */
async function runJunkResidual(
  judged: { id: string; bucket: string; features: SessionFeatures; time_updated: number }[],
  env: NodeJS.ProcessEnv,
  deps: AutoarchiveDeps,
): Promise<Record<string, unknown> | undefined> {
  if (jevDisabled(env)) return undefined;
  const residual: ResidualSession[] = judged
    .filter((j) => j.bucket === "substantive")
    .map((j) => ({ id: j.id, features: j.features, ageHours: (Date.now() - j.time_updated) / 3_600_000 }));
  if (residual.length === 0) return { status: "ran", consulted: 0, admitted: 0, admitted_ids: [] };
  try {
    const pass = deps.jev !== undefined ? await deps.jev(residual) : await jevJunkResidual(residual, { env });
    if (pass.status !== "ran") return { status: pass.status, consulted: 0, admitted: 0, admitted_ids: [] };
    const admittedIds = residual
      .filter((s) => jevArchiveAdmits(pass.verdicts[s.id]?.choice, pass.verdicts[s.id]?.confidence ?? 0, s.ageHours))
      .map((s) => s.id);
    return { status: "ran", consulted: residual.length, admitted: admittedIds.length, admitted_ids: admittedIds };
  } catch (e) {
    return { status: "error", error: e instanceof Error ? e.message : String(e), consulted: 0, admitted: 0, admitted_ids: [] };
  }
}

// ── restore (clear the one field) ───────────────────────────────────────────

function sessionsRestore(argv: string[]): VerbResult {
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) return fail("session id is required: amico sessions restore <session-id>");
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);

  let probe;
  try {
    probe = sqliteBatch(dbPath, "ro", [{ sql: "SELECT time_archived FROM session WHERE id = ?", params: [id] }]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const row = probe.results[0].rows[0] as { time_archived: number | null } | undefined;
  if (!row) return fail(`no such session: ${id}`);
  if (row.time_archived === null || row.time_archived === undefined) {
    return { json: { verb: "sessions", subcommand: "restore", session_id: id, restored: false }, code: 0 };
  }
  try {
    sqliteBatch(dbPath, "rw", [{ sql: "UPDATE session SET time_archived = NULL WHERE id = ?", params: [id] }]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  return { json: { verb: "sessions", subcommand: "restore", session_id: id, restored: true }, code: 0 };
}

// ── index (generate; never author) ──────────────────────────────────────────

function sessionsIndex(argv: string[]): VerbResult {
  const dbPath = resolveSessionDb(argv);
  if (!existsSync(dbPath)) return fail(`session DB not found: ${dbPath}`);
  const out = flagValue(argv, "--out") ?? "SESSION-INDEX.md";

  let batch;
  try {
    batch = sqliteBatch(dbPath, "ro", [
      { sql: "SELECT id, directory, title, time_updated, time_archived FROM session ORDER BY time_updated DESC, id" },
    ]);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const rows = batch.results[0].rows.map(rowOf).map((r) => ({ id: r.id, directory: r.directory, title: r.title, time_updated: r.time_updated, time_archived: r.time_archived }));
  const visible = rows.filter((r) => r.time_archived === null).length;
  const markdown = renderSessionIndex({
    generated_at: new Date().toISOString(),
    source_db: dbPath,
    sessions: rows as IndexSession[],
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
}

// ── prefs (the workspace preference surface) ────────────────────────────────

function sessionsPrefs(argv: string[], env: NodeJS.ProcessEnv): VerbResult {
  const days = flagValue(argv, "--days");
  const hours = flagValue(argv, "--autoarchive-hours");
  if (days !== undefined || hours !== undefined) {
    if (days !== undefined) {
      const n = Number(days);
      const w = writeArchiveDays(n, env);
      if (!w.ok) return fail(w.error);
    }
    if (hours !== undefined) {
      const n = Number(hours);
      const w = writeAutoArchiveHours(n, env);
      if (!w.ok) return fail(w.error);
    }
    return {
      json: {
        verb: "sessions",
        subcommand: "prefs",
        archive_days: readArchiveDays(env),
        autoarchive_hours: readAutoArchiveHours(env),
        file: retentionPrefsFile(env),
      },
      code: 0,
    };
  }
  return {
    json: {
      verb: "sessions",
      subcommand: "prefs",
      archive_days: readArchiveDays(env),
      autoarchive_hours: readAutoArchiveHours(env),
      file: retentionPrefsFile(env),
    },
    code: 0,
  };
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function sessionsVerb(argv: string[]): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const env = process.env;
  switch (sub) {
    case "list":
      return sessionsList(rest);
    case "archive":
      return sessionsArchive(rest, env);
    case "autoarchive":
      return await sessionsAutoarchive(rest, env);
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
            "amico sessions list [--archived] [--limit <n>] [--cursor <c>] [--db <path>]  |  amico sessions archive [--days <n>] [--apply]  |  amico sessions autoarchive [--hours <n>] [--apply]  |  amico sessions restore <id>  |  amico sessions index [--out <path>]  |  amico sessions prefs [--days <n>] [--autoarchive-hours <n>]",
        },
        code: 64,
      };
  }
}

// shard_rehome.ts — `amico fleet shard-rehome` (#1658): the tested directory
// re-home for client shards merged into the canonical DB.
//
//   amico fleet shard-rehome --client-home <path> [--db <path>] [--apply]
//
// Shard merges are #1302's by-hand flow (shard-watch is detection-only, #1306 —
// "the merge, a kill, any remediation: out of the vocabulary"), and the hand-run
// re-home of the 2026-10-01 macbook shard doubled path segments on two different
// home prefixes, producing directories that exist nowhere on the hub — the
// sessions merged fine but turned invisible to every panel listing, which
// filters by project directory. This verb is the piece of that by-hand flow that
// must never be hand-rolled SQL again:
//
//   1. reads every canonical session whose directory lives under the client home;
//   2. maps each with ONE explicit prefix substitution (client home → hub home) —
//      doubling is structurally impossible: no repeated application, no string
//      splicing, the candidate is exactly hubHome + from.slice(clientHome.length);
//   3. VALIDATES the candidate exists on the hub filesystem before writing —
//      a missing target falls back to the shard's original directory (an
//      invisible-but-truthful row beats an invisible-and-wrong one);
//   4. dry-run by default (the plan, one row per session); --apply performs the
//      per-id UPDATEs and re-reads the touched rows to verify what landed.
//
// CONSTRAINTS (the issue's invariants, enforced structurally):
//   - The mapping is a pure function of (rows, clientHome, hubHome, exists) —
//     table-tested below; the verb's only impure edges (the DB read/write via
//     the python3 bridge, the filesystem existence check, the env) are
//     injectable, mirroring shard_watch.ts.
//   - Rows not under the client home are never touched, never reported as
//     errors — the verb is scoped to the merge's own residue.
//   - A failed apply verification is a nonzero exit, never a soft warning.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolveSessionDb } from "./sessions_verb.js";
import { sqliteBatch, type BridgeStatement, type BridgeResult } from "./sqlite_bridge.js";
import type { VerbResult } from "./verbs.js";

// ── the pure re-home planner (table-tested; no fs, no clock, no spawn) ──────

export interface RehomeRow {
  id: string;
  directory: string;
}

export interface RehomeDecision {
  id: string;
  from: string;
  to: string;
  action: "rehome" | "keep";
  reason: string;
}

export interface RehomePlanOptions {
  clientHome: string;
  hubHome: string;
  exists: (directory: string) => boolean;
}

function under(path: string, home: string): boolean {
  return path === home || path.startsWith(home + "/");
}

export function planRehome(rows: RehomeRow[], opts: RehomePlanOptions): RehomeDecision[] {
  const { clientHome, hubHome, exists } = opts;
  return rows.map((row) => {
    const from = row.directory;
    if (under(from, hubHome)) {
      return { id: row.id, from, to: from, action: "keep", reason: "already hub-side" };
    }
    if (!under(from, clientHome)) {
      return { id: row.id, from, to: from, action: "keep", reason: "not under the client home — untouched" };
    }
    const candidate = hubHome + from.slice(clientHome.length);
    if (candidate === from) {
      return { id: row.id, from, to: from, action: "keep", reason: "client home equals hub home — nothing to map" };
    }
    if (!exists(candidate)) {
      return {
        id: row.id,
        from,
        to: from,
        action: "keep",
        reason: `target ${candidate} does not exist on the hub — keeping the shard's original directory`,
      };
    }
    return { id: row.id, from, to: candidate, action: "rehome", reason: "client home → hub home (single prefix substitution, target validated)" };
  });
}

// ── the verb ─────────────────────────────────────────────────────────────────

export interface ShardRehomeDeps {
  env?: NodeJS.ProcessEnv;
  hubHome?: string;
  exists?: (directory: string) => boolean;
  batch?: (dbPath: string, mode: "ro" | "rw", statements: BridgeStatement[], env: NodeJS.ProcessEnv) => BridgeResult;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function rehomeFail(error: string, extra: Record<string, unknown> = {}): VerbResult {
  return { json: { verb: "fleet", subcommand: "shard-rehome", ok: false, errors: [error], ...extra }, code: 64 };
}

export function shardRehome(argv: string[], deps: ShardRehomeDeps = {}): VerbResult {
  const env = deps.env ?? process.env;
  const hubHome = deps.hubHome ?? homedir();
  const exists = deps.exists ?? ((d: string) => existsSync(d));
  const batch = deps.batch ?? sqliteBatch;
  const apply = argv.includes("--apply");
  const ts = new Date().toISOString();

  const clientHome = flagValue(argv, "--client-home");
  if (clientHome === undefined || clientHome.trim() === "") {
    return rehomeFail("--client-home <path> is required — the re-home maps that prefix onto this machine's home; an unscoped re-home must not run");
  }
  if (!clientHome.startsWith("/")) {
    return rehomeFail(`--client-home must be an absolute path (got "${clientHome}")`);
  }
  const dbPath = flagValue(argv, "--db") ?? resolveSessionDb(argv, env);

  // read: every session whose directory lives under the client home — the merge's
  // residue, and nothing else.
  let rows: RehomeRow[];
  try {
    const read = batch(dbPath, "ro", [
      { sql: "SELECT id, directory FROM session WHERE directory LIKE ?", params: [clientHome + "%"] },
    ], env);
    rows = (read.results[0]?.rows ?? []).map((r) => ({
      id: String(r.id),
      directory: String(r.directory),
    }));
  } catch (e) {
    return rehomeFail(`canonical DB unreadable: ${(e as Error).message}`, { canonical_db: dbPath });
  }

  const plan = planRehome(rows, { clientHome, hubHome, exists });
  const rehomes = plan.filter((d) => d.action === "rehome");
  const keeps = plan.filter((d) => d.action === "keep");

  const json: Record<string, unknown> = {
    receipt_version: 1,
    ts,
    verb: "fleet",
    subcommand: "shard-rehome",
    kind: "shard-rehome",
    ok: true,
    mode: apply ? "apply" : "dry-run",
    canonical_db: dbPath,
    client_home: clientHome,
    hub_home: hubHome,
    scanned: rows.length,
    rehome_count: rehomes.length,
    kept_count: keeps.length,
    plan,
  };
  if (!apply) {
    json.would_apply = rehomes.length;
    return { json, code: 0 };
  }

  // apply: per-id UPDATEs (never a string REPLACE over the table — precision is
  // the point), then re-read the touched ids and verify every one landed.
  try {
    if (rehomes.length > 0) {
      const write = batch(dbPath, "rw", rehomes.map((d) => ({
        sql: "UPDATE session SET directory = ? WHERE id = ?",
        params: [d.to, d.id],
      })), env);
      const changed = write.results.reduce((n, r) => n + (r.changes ?? 0), 0);
      if (changed !== rehomes.length) {
        return rehomeFail(`apply touched ${changed} rows but planned ${rehomes.length} — rolling the report back, the DB commit stands; re-run the dry-run to see the remaining state`, { canonical_db: dbPath });
      }
    }
    if (rehomes.length > 0) {
      const placeholders = rehomes.map(() => "?").join(",");
      const verify = batch(dbPath, "ro", [
        { sql: `SELECT id, directory FROM session WHERE id IN (${placeholders})`, params: rehomes.map((d) => d.id) },
      ], env);
      const landed = new Map((verify.results[0]?.rows ?? []).map((r) => [String(r.id), String(r.directory)]));
      const mismatches = rehomes
        .filter((d) => landed.get(d.id) !== d.to)
        .map((d) => `${d.id}: expected ${d.to}, found ${landed.get(d.id) ?? "row missing"}`);
      if (mismatches.length > 0) {
        return rehomeFail(`post-apply verification failed for ${mismatches.length} row(s)`, { canonical_db: dbPath, mismatches });
      }
      json.verified = true;
    } else {
      json.verified = true; // nothing to verify — an honest all-keep apply
    }
  } catch (e) {
    return rehomeFail(`apply failed: ${(e as Error).message}`, { canonical_db: dbPath });
  }

  return { json, code: 0 };
}

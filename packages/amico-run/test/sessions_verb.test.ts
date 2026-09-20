// `amico sessions` — D4 slice 3 (issue #795): session retention that relocates +
// the generated session index. Pure core (session_retention.ts) is unit-tested
// against src; the verb bodies run through `dist/amico.js` against SEEDED COPY
// databases in temp dirs — never the live chat DB (shared with a running hub).
// Run: `pnpm --filter @amicode/amico-run test`.
import { beforeAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ARCHIVE_DAYS,
  DEFAULT_AUTOARCHIVE_HOURS,
  readArchiveDays,
  readAutoArchiveHours,
  writeArchiveDays,
  writeAutoArchiveHours,
  retentionPrefsFile,
} from "../src/session_retention.js";

// ── AC 3: the archive cutoff is a workspace preference with default 30 days ──
describe("retention preference — the archive cutoff", () => {
  let ops: string;
  beforeEach(() => {
    ops = mkdtempSync(join(tmpdir(), "amico-sessions-ops-"));
  });
  afterEach(() => rmSync(ops, { recursive: true, force: true }));

  it("defaults to 30 days when no preference file exists (fresh install)", () => {
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    expect(DEFAULT_ARCHIVE_DAYS).toBe(30);
  });

  it("fails safe to 30 on a malformed or out-of-range preference file", () => {
    writeFileSync(join(ops, "session-retention.json"), "{not json");
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: 0 }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: -5 }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ archive_days: "thirty" }));
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(30);
  });

  it("reads a written preference (7 days) and reports the file it came from", () => {
    writeArchiveDays(7, { AMICODE_OPS_DIR: ops });
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(7);
    expect(retentionPrefsFile({ AMICODE_OPS_DIR: ops })).toBe(join(ops, "session-retention.json"));
    const parsed = JSON.parse(readFileSync(retentionPrefsFile({ AMICODE_OPS_DIR: ops }), "utf8"));
    expect(parsed).toMatchObject({ schema_version: 1, archive_days: 7 });
  });

  it("refuses to write a non-positive or non-integer cutoff", () => {
    expect(writeArchiveDays(0, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(writeArchiveDays(2.5, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(existsSync(join(ops, "session-retention.json"))).toBe(false);
  });

  it("falls back to ~/.amico/amicode when AMICODE_OPS_DIR is unset", () => {
    expect(retentionPrefsFile({})).toBe(join(homedir(), ".amico", "amicode", "session-retention.json"));
  });
});

// ── the seeded-DB harness (NEVER the live chat DB — hub-shared production state) ──
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  try {
    // AMICO_JEV_DISABLED guards the bundle hermetically: the machine's real
    // ~/.amico/typesafe/key would otherwise arm the live Jev residual inside
    // autoarchive. Tests that WANT the enabled path override this explicitly.
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, AMICO_JEV_DISABLED: "1", ...env } });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

const DAY = 86_400_000;

interface SeedOpts {
  id: string;
  title?: string;
  directory?: string;
  updatedDaysAgo?: number;
  /** Hour resolution for the 48 h autoarchive age gate (#1304); wins over updatedDaysAgo. */
  updatedHoursAgo?: number;
  createdDaysAgo?: number;
  archived?: boolean;
  parent?: string;
  /** User message texts — implies the message/part planes (one text part per user message). */
  userMessages?: string[];
  /** Assistant message count (no parts — the classifier only counts turns). */
  assistantMessages?: number;
  /** One assistant message with a text part carrying this text (#1311 thread-noul sweep). */
  lastAssistantText?: string;
  /** Pending todo rows (status 'pending', the open-threads convention). */
  pendingTodos?: number;
}

/** Seed a minimal session table shaped like the live DB's (the columns the verb
 *  queries exist in both; the engine owns the real DDL). Seeding runs through
 *  python3's stdlib sqlite3 — the same driver the verb uses (sqlite_bridge.ts),
 *  which exists on the repo's CI node (20.x) where node:sqlite does not. */
function seedDb(dbPath: string, seeds: SeedOpts[]): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const script = `
import json, sqlite3, sys

seeds = json.loads(sys.argv[2])
now = int(sys.argv[3])
day = ${DAY}

con = sqlite3.connect(sys.argv[1], timeout=5)
con.executescript("""
CREATE TABLE session (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  parent_id TEXT,
  directory TEXT NOT NULL,
  title TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  time_archived INTEGER
);
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  worktree TEXT,
  vcs TEXT,
  name TEXT,
  time_created INTEGER,
  time_updated INTEGER
);
CREATE TABLE message (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE part (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE todo (
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  position INTEGER NOT NULL,
  time_created INTEGER NOT NULL,
  time_updated INTEGER NOT NULL,
  PRIMARY KEY (session_id, position)
);
""")
con.execute("INSERT INTO project (id, worktree, vcs, name, time_created, time_updated) VALUES (?,?,?,?,?,?)",
            ("proj_armonia", "/home/aaron/armonia", None, "armonia", now - 100 * day, now - 1 * day))
for s in seeds:
    if s.get("updatedHoursAgo") is not None:
        updated = now - int(round(s["updatedHoursAgo"] * 3600000))
    else:
        updated = now - s["updatedDaysAgo"] * day
    if s.get("createdDaysAgo") is not None:
        created = now - s["createdDaysAgo"] * day
    elif s.get("updatedDaysAgo") is not None:
        created = now - (s["updatedDaysAgo"] + 1) * day
    else:
        created = updated - day
    con.execute(
        "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?)",
        (s["id"], s.get("parent"), s.get("directory", "/home/aaron/armonia"), s.get("title", "session " + s["id"]),
         created, updated, now - s["updatedDaysAgo"] * day if s.get("archived") else None),
    )
    for i, text in enumerate(s.get("userMessages") or []):
        mid = "msg_%s_%d" % (s["id"], i)
        con.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
                    (mid, s["id"], created, updated, json.dumps({"role": "user"})))
        con.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
                    ("part_" + mid, mid, s["id"], created, updated, json.dumps({"type": "text", "text": text})))
    for i in range(s.get("assistantMessages") or 0):
        con.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
                    ("msg_%s_a%d" % (s["id"], i), s["id"], created, updated, json.dumps({"role": "assistant"})))
    if s.get("lastAssistantText") is not None:
        mid = "msg_%s_last" % s["id"]
        con.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
                    (mid, s["id"], created, updated, json.dumps({"role": "assistant"})))
        con.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
                    ("part_" + mid, mid, s["id"], created, updated, json.dumps({"type": "text", "text": s["lastAssistantText"]})))
    for i in range(s.get("pendingTodos") or 0):
        con.execute("INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?,?,?,?,?,?,?)",
                    (s["id"], "todo %d" % i, "pending", "medium", i, created, updated))
con.commit()
con.close()
  `;
  execFileSync(pythonBin(), ["-c", script, dbPath, JSON.stringify(seeds), String(Date.now())], { encoding: "utf8" });
}

/** Full-row dump of a seeded DB (python3 stdlib, read-only) — the ONLY-fields-
 *  changed assertions diff this snapshot. */
function dbRows(dbPath: string): string {
  return execFileSync(
    pythonBin(),
    ["-c", `
import json, sqlite3, sys
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
con.row_factory = sqlite3.Row
print(json.dumps({
  "sessions": [dict(r) for r in con.execute("SELECT * FROM session ORDER BY id").fetchall()],
  "projects": [dict(r) for r in con.execute("SELECT * FROM project ORDER BY id").fetchall()],
}))
      `, dbPath],
    { encoding: "utf8" },
  );
}

/** The interpreter the verb's bridge resolves: $AMICO_PYTHON → python3. */
function pythonBin(): string {
  return process.env.AMICO_PYTHON && process.env.AMICO_PYTHON.trim() !== "" ? process.env.AMICO_PYTHON : "python3";
}

// ── AC 1: the archive visibility matrix ─────────────────────────────────────
describe("amico sessions list/archive/restore — the visibility matrix (bundle)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-sessions-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function ids(r: { stdout: string }): string[] {
    return (JSON.parse(r.stdout).sessions as { id: string }[]).map((s) => s.id);
  }

  it("default list excludes archived; --archived opt-in lists them; restore clears the field", () => {
    seedDb(db, [
      { id: "ses_active", updatedDaysAgo: 1 },
      { id: "ses_old", updatedDaysAgo: 60 },
      { id: "ses_archived", updatedDaysAgo: 90, archived: true },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };

    // default: active only — the archived session is invisible
    expect(ids(run(["sessions", "list"], env))).toEqual(["ses_active", "ses_old"]);

    // explicit opt-in: archived only
    const arch = JSON.parse(run(["sessions", "list", "--archived"], env).stdout);
    expect(arch.sessions.map((s: { id: string }) => s.id)).toEqual(["ses_archived"]);
    expect(arch.sessions[0].time_archived).toBeGreaterThan(0);

    // apply the retention policy (default cutoff = the 30-day preference):
    // the 60-day-old session relocates; the active one stays.
    const a = JSON.parse(run(["sessions", "archive", "--apply"], env).stdout);
    expect(a).toMatchObject({ days: 30, archived: 1 });
    expect(ids(run(["sessions", "list"], env))).toEqual(["ses_active"]);
    expect(ids(run(["sessions", "list", "--archived"], env))).toEqual(["ses_old", "ses_archived"]);

    // restore clears the one field — the session returns to the default list
    const r = JSON.parse(run(["sessions", "restore", "ses_old"], env).stdout);
    expect(r).toMatchObject({ restored: true });
    expect(ids(run(["sessions", "list"], env))).toEqual(["ses_active", "ses_old"]);
  });

  it("archive is DRY-RUN by default (reports candidates, writes nothing) — --apply is the write", () => {
    seedDb(db, [
      { id: "ses_active", updatedDaysAgo: 1 },
      { id: "ses_old", updatedDaysAgo: 60 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const dry = JSON.parse(run(["sessions", "archive"], env).stdout);
    expect(dry).toMatchObject({ dry_run: true, days: 30, candidates: 1 });
    expect(ids(run(["sessions", "list"], env))).toEqual(["ses_active", "ses_old"]); // untouched
  });

  it("restore of an already-active session is an idempotent no-op; unknown id is a usage error", () => {
    seedDb(db, [{ id: "ses_active", updatedDaysAgo: 1 }]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    expect(run(["sessions", "restore", "ses_active"], env).code).toBe(0);
    expect(JSON.parse(run(["sessions", "restore", "ses_active"], env).stdout)).toMatchObject({ restored: false });
    expect(run(["sessions", "restore", "ses_nope"], env).code).toBe(64);
  });

  it("refuses to run without a resolvable session DB (missing default is an honest 64, not a live-DB guess)", () => {
    const r = run(["sessions", "list"], { OPENCODE_DB: join(tmp, "nope", "missing.db"), AMICODE_OPS_DIR: ops });
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatch(/not found|no session/);
  });
});

// ── AC 4: the index is generated, never authored — and matches the DB ───────
describe("amico sessions index — regeneration vs the seeded DB (bundle)", () => {
  let tmp: string;
  let db: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-sessions-idx-"));
    db = join(tmp, "opencode.db");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  interface ParsedRow { id: string; month: string; home: string; state: string }

  /** Parse the generated markdown back into rows — the shape check is part of
   *  the contract: month sections, one row per session, provenance columns. */
  function parseIndex(text: string): { rows: ParsedRow[]; header: string; distribution: string[]; visible: number; archived: number } {
    const header = text.split("\n").find((l) => l.startsWith("*Generated"))!;
    const distribution = text.split("\n").filter((l) => l.startsWith("- `"));
    const visibleM = header.match(/(\d+) visible · (\d+) archived/)!;
    const rows: ParsedRow[] = [];
    let month = "";
    for (const line of text.split("\n")) {
      const m = line.match(/^## (\d{4}-\d{2})$/);
      if (m) { month = m[1]; continue; }
      const r = line.match(/^\| [\d-]+ \| .* \| (\S+) \| (\w+) \| `(ses_\w+)` \|$/);
      if (r) rows.push({ month, home: r[1], state: r[2], id: r[3] });
    }
    return { rows, header, distribution, visible: Number(visibleM[1]), archived: Number(visibleM[2]) };
  }

  it("regenerates a complete, provenance-carrying index that matches the seeded DB", () => {
    seedDb(db, [
      { id: "ses_a1", title: "Fleet sync", directory: "/home/aaron/armonia", updatedDaysAgo: 2 },
      { id: "ses_a2", title: "Gate solve", directory: "/home/aaron/harmoniqs/amicode", updatedDaysAgo: 3 },
      { id: "ses_b1", title: "Old work", directory: "/home/aaron/armonia", updatedDaysAgo: 40, archived: true },
      { id: "ses_sub1", title: "child", directory: "/home/aaron/armonia", updatedDaysAgo: 2, parent: "ses_a1" },
    ]);
    const out = join(tmp, "sessions", "SESSION-INDEX.md");
    const r = JSON.parse(
      run(["sessions", "index", "--db", db, "--out", out], { AMICODE_OPS_DIR: tmp }).stdout,
    );
    expect(r).toMatchObject({ sessions_indexed: 4, visible: 3, archived: 1, source_db: db });
    expect(existsSync(out)).toBe(true);

    const text = readFileSync(out, "utf8");
    const parsed = parseIndex(text);
    // complete: every DB row appears exactly once
    expect(parsed.rows.map((x) => x.id).sort()).toEqual(["ses_a1", "ses_a2", "ses_b1", "ses_sub1"].sort());
    // provenance: home column is the directory basename from the DB
    expect(parsed.rows.find((x) => x.id === "ses_a2")!.home).toBe("amicode");
    expect(parsed.rows.find((x) => x.id === "ses_a1")!.home).toBe("armonia");
    // archive state per row matches the DB
    expect(parsed.rows.find((x) => x.id === "ses_b1")!.state).toBe("archived");
    expect(parsed.rows.find((x) => x.id === "ses_a1")!.state).toBe("active");
    // month sections follow time_updated
    const nowMonth = new Date().toISOString().slice(0, 7);
    expect(parsed.rows.find((x) => x.id === "ses_a1")!.month).toBe(nowMonth);
    // the distribution header carries the full-path provenance + counts
    expect(parsed.distribution).toContain("- `/home/aaron/armonia` — 3 sessions");
    expect(parsed.distribution).toContain("- `/home/aaron/harmoniqs/amicode` — 1 session");
    expect(parsed.visible).toBe(3);
    expect(parsed.archived).toBe(1);
  });

  it("regeneration is deterministic apart from the generated-at stamp (idempotent rewrite)", () => {
    seedDb(db, [{ id: "ses_x1", title: "Only", updatedDaysAgo: 1 }]);
    const out = join(tmp, "SESSION-INDEX.md");
    const env = { AMICODE_OPS_DIR: tmp };
    run(["sessions", "index", "--db", db, "--out", out], env);
    const first = readFileSync(out, "utf8");
    run(["sessions", "index", "--db", db, "--out", out], env);
    const second = readFileSync(out, "utf8");
    expect(second.replace(/\*Generated [^*]+\*/, "")).toBe(first.replace(/\*Generated [^*]+\*/, ""));
  });

  it("an empty DB yields an honest empty index (0 visible · 0 archived), not an error", () => {
    seedDb(db, []);
    const out = join(tmp, "SESSION-INDEX.md");
    const r = JSON.parse(run(["sessions", "index", "--db", db, "--out", out], { AMICODE_OPS_DIR: tmp }).stdout);
    expect(r).toMatchObject({ sessions_indexed: 0, visible: 0, archived: 0 });
    expect(readFileSync(out, "utf8")).toMatch(/0 sessions: 0 visible · 0 archived/);
  });
});

// ── AC 5: the boot list fetch remains paginated under growth (D4: "the recent
//    tail first, so the refetch contract does not degrade as the list grows") ──
describe("amico sessions list — pagination under a 1000+ session store (bundle)", () => {
  let tmp: string;
  let db: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-sessions-pg-"));
    db = join(tmp, "opencode.db");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("a seeded 1200-session store walks fully through bounded pages, newest first, exactly once", () => {
    const N = 1200;
    const seeds: SeedOpts[] = [];
    for (let i = 0; i < N; i++) {
      seeds.push({ id: `ses_pg${String(i).padStart(4, "0")}`, title: `s${i}`, updatedDaysAgo: (i % 400) + (i / 400) * 0.01, createdDaysAgo: 500 });
    }
    seedDb(db, seeds);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp };

    // first page (the boot page): bounded at the default limit, recent tail first
    const first = JSON.parse(run(["sessions", "list"], env).stdout);
    expect(first.count).toBe(100);
    expect(first.total).toBe(N);
    expect(first.next_cursor).toBe(100);

    // walk every page: 1200 sessions, each exactly once, no archive leakage
    const seen: string[] = [];
    let cursor: number | null = 0;
    let pages = 0;
    while (cursor !== null) {
      const page = JSON.parse(run(["sessions", "list", "--cursor", String(cursor)], env).stdout);
      expect(page.count).toBeLessThanOrEqual(100);
      for (const s of page.sessions as { id: string }[]) seen.push(s.id);
      cursor = page.next_cursor;
      pages++;
      expect(pages).toBeLessThan(50); // termination guard
    }
    expect(seen.length).toBe(N);
    expect(new Set(seen).size).toBe(N);

    // ordering: time_updated DESC — the first page is the recent tail, and the
    // walk is globally descending (allowing the id tie-break within a tick)
    const firstIds = (first.sessions as { id: string }[]).map((s) => s.id);
    expect(firstIds[0]).toBe("ses_pg0000"); // most recently updated
    const byUpdated = JSON.parse(run(["sessions", "list", "--limit", "1000"], env).stdout);
    expect(byUpdated.count).toBe(1000); // --limit is honored up to a hard cap
  });

  it("pagination respects the visibility rules (archived rows never leak into a default walk)", () => {
    const seeds: SeedOpts[] = [];
    for (let i = 0; i < 250; i++) {
      seeds.push({ id: `ses_v${String(i).padStart(3, "0")}`, updatedDaysAgo: i % 200 });
    }
    seeds.push({ id: "ses_hidden", updatedDaysAgo: 10, archived: true });
    seedDb(db, seeds);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp };

    const seen: string[] = [];
    let cursor: number | null = 0;
    while (cursor !== null) {
      const page = JSON.parse(run(["sessions", "list", "--limit", "50", "--cursor", String(cursor)], env).stdout);
      for (const s of page.sessions as { id: string }[]) seen.push(s.id);
      cursor = page.next_cursor;
    }
    expect(seen).toHaveLength(250);
    expect(seen).not.toContain("ses_hidden");
  });
});

// ── AC 2: archive affects product lists only — the vault ledger plane and the
//    coordination plane are separate transports (D4 disjointness invariant) ──
describe("amico sessions archive — disjointness from the vault/coordination planes (bundle)", () => {
  let tmp: string;
  let db: string;
  let vault: string;
  let claims: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-sessions-disj-"));
    db = join(tmp, "opencode.db");
    vault = join(tmp, "vault");
    mkdirSync(join(vault, "sessions"), { recursive: true });
    writeFileSync(join(vault, "sessions", "session-ledger.md"), "# ledger plane — never touched by archive\n");
    claims = join(tmp, "claims.jsonl");
    writeFileSync(claims, '{"type":"claim","work_id":"w1"}\n');
    mkdirSync(join(tmp, "board"), { recursive: true });
    writeFileSync(join(tmp, "board", "m5-board.md"), "# coordination board — never touched\n");
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("archive --apply and restore change ONLY time_archived on session rows; sibling planes are byte-identical", () => {
    seedDb(db, [
      { id: "ses_active", updatedDaysAgo: 1 },
      { id: "ses_old", updatedDaysAgo: 60, directory: "/home/aaron/armonia" },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp };
    const before = dbRows(db);
    const vaultBefore = readFileSync(join(vault, "sessions", "session-ledger.md"), "utf8");
    const claimsBefore = readFileSync(claims, "utf8");
    const boardBefore = readFileSync(join(tmp, "board", "m5-board.md"), "utf8");
    const vaultListBefore = execFileSync("find", [vault], { encoding: "utf8" });

    run(["sessions", "archive", "--apply"], env);
    run(["sessions", "restore", "ses_old"], env);

    // sibling planes byte-identical, no new vault-plane files
    expect(readFileSync(join(vault, "sessions", "session-ledger.md"), "utf8")).toBe(vaultBefore);
    expect(readFileSync(claims, "utf8")).toBe(claimsBefore);
    expect(readFileSync(join(tmp, "board", "m5-board.md"), "utf8")).toBe(boardBefore);
    expect(execFileSync("find", [vault], { encoding: "utf8" })).toBe(vaultListBefore);

    // the DB delta is exactly the time_archived stamp + its clear — project
    // rows and every other session column untouched (archive writes ONE field)
    const after = dbRows(db);
    const beforeParsed = JSON.parse(before) as { sessions: Record<string, unknown>[]; projects: unknown[] };
    const afterParsed = JSON.parse(after) as { sessions: Record<string, unknown>[]; projects: unknown[] };
    expect(afterParsed.projects).toEqual(beforeParsed.projects);
    const diffs: string[] = [];
    for (let i = 0; i < beforeParsed.sessions.length; i++) {
      for (const k of Object.keys(beforeParsed.sessions[i])) {
        if (String(beforeParsed.sessions[i][k]) !== String(afterParsed.sessions[i][k])) diffs.push(`${k}:${beforeParsed.sessions[i][k]}->${afterParsed.sessions[i][k]}`);
      }
    }
    // ses_old was archived then restored → net zero; nothing else may differ
    expect(diffs).toEqual([]);
  });
});

// ── AC 3 (end-to-end): the cutoff the archive applies comes from the workspace
//    preference, overridable per call — never a hardcoded constant ────────────
describe("amico sessions prefs/archive — the cutoff is the preference (bundle)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-sessions-prefs-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("prefs --days writes the preference; archive --apply honors it (7d cutoff, not 30)", () => {
    seedDb(db, [
      { id: "ses_5d", updatedDaysAgo: 5 },
      { id: "ses_10d", updatedDaysAgo: 10 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };

    const p = JSON.parse(run(["sessions", "prefs", "--days", "7"], env).stdout);
    expect(p).toMatchObject({ archive_days: 7 });
    expect(JSON.parse(readFileSync(join(ops, "session-retention.json"), "utf8")).archive_days).toBe(7);

    // dry-run first: exactly the 10-day-old session crosses the 7-day cutoff
    expect(JSON.parse(run(["sessions", "archive"], env).stdout)).toMatchObject({ days: 7, candidates: 1, candidate_ids: ["ses_10d"] });
    run(["sessions", "archive", "--apply"], env);
    const after = JSON.parse(run(["sessions", "list"], env).stdout);
    expect(after.sessions.map((s: { id: string }) => s.id)).toEqual(["ses_5d"]);
  });

  it("--days overrides the preference for a single call without writing it", () => {
    seedDb(db, [{ id: "ses_1d", updatedDaysAgo: 1 }]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const dry = JSON.parse(run(["sessions", "archive", "--days", "1"], env).stdout);
    expect(dry).toMatchObject({ days: 1, candidates: 1 });
    expect(existsSync(join(ops, "session-retention.json"))).toBe(false);
    expect(JSON.parse(run(["sessions", "prefs"], env).stdout)).toMatchObject({ archive_days: 30 });
  });

  it("unknown subcommand is a usage error listing the surface", () => {
    const r = run(["sessions", "bogus"], { AMICODE_OPS_DIR: ops });
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).usage).toMatch(/archive/);
  });
});

// ══ #1304: the age-gated, classification-aware autoarchive ══════════════════
// The archive verb relocates by age alone; #1304 gates it on the #1303
// classifier (junk buckets only), a 48 h age gate, and the todo protection —
// wrapped by the nightly ops job (ops/session-archive/). Same harness rules:
// seeded temp DBs, never the live chat DB.

const HOUR = 3_600_000;

/** The junk-shaped feature seeds, per the #1303 classifier's buckets. */
function junkSeeds(): SeedOpts[] {
  return [
    { id: "ses_greet", title: "Friendly greeting", userMessages: ["hi there"], assistantMessages: 2, updatedHoursAgo: 72 },
    { id: "ses_dead", title: "Deep refactor of the ingestion pipeline", userMessages: ["please continue"], assistantMessages: 0, updatedHoursAgo: 72 },
    { id: "ses_probe", title: "New session - 2026-09-20T08:31", updatedHoursAgo: 72 },
    { id: "ses_real", title: "Campaign solve", userMessages: ["optimize this gate with the usual care and full context"], assistantMessages: 20, updatedHoursAgo: 72 },
    { id: "ses_young", title: "hello", userMessages: ["hi"], assistantMessages: 1, updatedHoursAgo: 2 },
  ];
}

const JUNK_OLD_IDS = ["ses_greet", "ses_dead", "ses_probe"];

describe("amico sessions autoarchive — classification-gated archive (#1304, bundle)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-autoarchive-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function ids(r: { stdout: string }): string[] {
    return (JSON.parse(r.stdout).sessions as { id: string }[]).map((s) => s.id);
  }

  it("AC 1: --apply archives junk-bucket sessions past the age gate — and ONLY time_archived changes", () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const before = JSON.parse(dbRows(db)) as { sessions: Record<string, unknown>[] };

    const a = JSON.parse(run(["sessions", "autoarchive", "--apply"], env).stdout);
    expect(a).toMatchObject({ subcommand: "autoarchive", dry_run: false, scanned: 4, candidates: 3, archived: 3 });
    expect(new Set(a.candidate_ids as string[])).toEqual(new Set(JUNK_OLD_IDS));

    // the junk buckets relocated; substantive + young stay visible
    expect(new Set(ids(run(["sessions", "list"], env)))).toEqual(new Set(["ses_real", "ses_young"]));
    expect(new Set(ids(run(["sessions", "list", "--archived"], env)))).toEqual(new Set([...JUNK_OLD_IDS]));

    // the DB delta is exactly the time_archived stamp — every other column
    // of every row byte-identical (the engine owns the field; the verb writes ONE field)
    const after = JSON.parse(dbRows(db)) as { sessions: Record<string, unknown>[] };
    for (const row of after.sessions) {
      const was = before.sessions.find((r) => r.id === row.id)!;
      for (const k of Object.keys(was)) {
        if (k === "time_archived") continue;
        expect(String(row[k]), `${row.id}.${k}`).toBe(String(was[k]));
      }
    }
    for (const id of JUNK_OLD_IDS) {
      expect(Number(after.sessions.find((r) => r.id === id)!.time_archived)).toBeGreaterThan(0);
    }
    expect(after.sessions.find((r) => r.id === "ses_real")!.time_archived).toBeNull();
    expect(after.sessions.find((r) => r.id === "ses_young")!.time_archived).toBeNull();
  });

  it("AC 2: a session with pending todos is never archived, regardless of bucket or age", () => {
    seedDb(db, [
      { id: "ses_todo_greet", title: "hello", userMessages: ["hi"], assistantMessages: 1, pendingTodos: 1, updatedHoursAgo: 200 },
      { id: "ses_todo_dead", title: "follow-up queue", userMessages: ["one prompt"], assistantMessages: 0, pendingTodos: 2, updatedHoursAgo: 200 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const dry = JSON.parse(run(["sessions", "autoarchive"], env).stdout);
    expect(dry).toMatchObject({ candidates: 0 });
    expect(JSON.parse(run(["sessions", "autoarchive", "--apply"], env).stdout)).toMatchObject({ archived: 0 });
    expect(new Set(ids(run(["sessions", "list"], env)))).toEqual(new Set(["ses_todo_greet", "ses_todo_dead"]));
    expect(ids(run(["sessions", "list", "--archived"], env))).toEqual([]);
  });

  it("AC 3: a session updated within the default 48 h age gate is never archived — the gate rides the retention preference", () => {
    seedDb(db, [
      { id: "ses_fresh", title: "hello", userMessages: ["hi"], assistantMessages: 1, updatedHoursAgo: 12 },
      { id: "ses_stale", title: "hello", userMessages: ["hi"], assistantMessages: 1, updatedHoursAgo: 49 },
      { id: "ses_edge", title: "hello", userMessages: ["hi"], assistantMessages: 1, updatedHoursAgo: 47 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    expect(JSON.parse(run(["sessions", "autoarchive"], env).stdout)).toMatchObject({ hours: 48, candidates: 1, candidate_ids: ["ses_stale"] });

    // the gate is the same ops-dir preference pattern — configurable, fail-safe
    const p = JSON.parse(run(["sessions", "prefs", "--autoarchive-hours", "6"], env).stdout);
    expect(p).toMatchObject({ autoarchive_hours: 6 });
    // a 6 h gate crosses all three greeting sessions (12 / 47 / 49 h old)
    const six = JSON.parse(run(["sessions", "autoarchive"], env).stdout);
    expect(six).toMatchObject({ hours: 6, candidates: 3 });
  });

  it("AC 4: dry-run is the DEFAULT — reports count + ids, writes nothing", () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const dry = JSON.parse(run(["sessions", "autoarchive"], env).stdout);
    expect(dry).toMatchObject({ dry_run: true, candidates: 3, archived: 0 });
    expect(new Set(dry.candidate_ids as string[])).toEqual(new Set(JUNK_OLD_IDS));
    // nothing moved
    expect(new Set(ids(run(["sessions", "list"], env)))).toEqual(new Set(["ses_greet", "ses_dead", "ses_probe", "ses_real", "ses_young"]));
    const after = JSON.parse(dbRows(db)) as { sessions: Record<string, unknown>[] };
    for (const row of after.sessions) expect(row.time_archived).toBeNull();
  });

  it("AC 6: an autoarchived session restores through the existing unarchive path (round-trip)", () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    run(["sessions", "autoarchive", "--apply"], env);
    expect(ids(run(["sessions", "list"], env)).sort()).toEqual(["ses_real", "ses_young"].sort());

    const r = JSON.parse(run(["sessions", "restore", "ses_greet"], env).stdout);
    expect(r).toMatchObject({ restored: true });
    expect(new Set(ids(run(["sessions", "list"], env)))).toEqual(new Set(["ses_real", "ses_young", "ses_greet"]));
  });

  it("usage: a missing DB is an honest 64; bad --hours is a usage error", () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    expect(run(["sessions", "autoarchive"], { OPENCODE_DB: join(tmp, "nope.db"), AMICODE_OPS_DIR: ops }).code).toBe(64);
    expect(run(["sessions", "autoarchive", "--hours", "0"], env).code).toBe(64);
    expect(run(["sessions", "autoarchive", "--hours", "half"], env).code).toBe(64);
  });
});

describe("autoarchive hours — the retention preference (unit)", () => {
  let ops: string;
  beforeEach(() => {
    ops = mkdtempSync(join(tmpdir(), "amico-autoarchive-prefs-"));
  });
  afterEach(() => rmSync(ops, { recursive: true, force: true }));

  it("defaults to 48 hours and fails safe on a malformed or out-of-range file", () => {
    expect(DEFAULT_AUTOARCHIVE_HOURS).toBe(48);
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(48);
    writeFileSync(join(ops, "session-retention.json"), "{not json");
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(48);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ autoarchive_hours: 0 }));
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(48);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ autoarchive_hours: -1 }));
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(48);
    writeFileSync(join(ops, "session-retention.json"), JSON.stringify({ autoarchive_hours: "48" }));
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(48);
  });

  it("reads a written preference and PRESERVES the sibling archive_days key", () => {
    writeArchiveDays(7, { AMICODE_OPS_DIR: ops });
    writeAutoArchiveHours(24, { AMICODE_OPS_DIR: ops });
    expect(readAutoArchiveHours({ AMICODE_OPS_DIR: ops })).toBe(24);
    expect(readArchiveDays({ AMICODE_OPS_DIR: ops })).toBe(7);
    const parsed = JSON.parse(readFileSync(retentionPrefsFile({ AMICODE_OPS_DIR: ops }), "utf8"));
    expect(parsed).toMatchObject({ schema_version: 1, archive_days: 7, autoarchive_hours: 24 });
  });

  it("refuses a non-positive or non-integer gate", () => {
    expect(writeAutoArchiveHours(0, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(writeAutoArchiveHours(2.5, { AMICODE_OPS_DIR: ops }).ok).toBe(false);
    expect(existsSync(join(ops, "session-retention.json"))).toBe(false);
  });
});

// ── the nightly ops job: ops/session-archive/run-session-archive.sh ─────────
// Smoke path per the issue's testing decision: dry-run green on a seeded temp
// DB fixture, one JSON receipt line per run, nonzero on a hard failure.
describe("ops/session-archive job — the nightly wrapper (smoke, #1304)", () => {
  const SCRIPT = join(__dirname, "..", "..", "..", "ops", "session-archive", "run-session-archive.sh");
  let tmp: string;
  let db: string;
  let ops: string;
  let receipts: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-autoarchive-ops-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    receipts = join(tmp, "receipts.jsonl");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function jobEnv(): Record<string, string> {
    return {
      SESSION_ARCHIVE_DB: db,
      SESSION_ARCHIVE_RECEIPTS: receipts,
      SESSION_ARCHIVE_AMICO: BUNDLE,
      AMICODE_OPS_DIR: ops,
      // hermeticity: the nightly wrapper spawns the CLI; without this the
      // machine's real jev key would arm the live residual inside autoarchive
      AMICO_JEV_DISABLED: "1",
    };
  }

  function job(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  function receiptLines(): Record<string, unknown>[] {
    return readFileSync(receipts, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it("AC 4+5: dry-run (the default) exits 0, appends exactly ONE receipt line (mode, scanned, archived 0, ids), and writes nothing to the DB", () => {
    seedDb(db, junkSeeds());
    const r = job([], jobEnv());
    expect(r.code).toBe(0);

    const lines = receiptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      receipt_version: 1,
      kind: "session-archive",
      mode: "dry-run",
      scanned: 4,
      archived: 0,
    });
    expect(new Set(lines[0].ids as string[])).toEqual(new Set(JUNK_OLD_IDS));
    expect(typeof lines[0].ts).toBe("string");

    // nothing relocated
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const vis = JSON.parse(run(["sessions", "list"], env).stdout);
    expect(vis.total).toBe(5);
    const rows = JSON.parse(dbRows(db)) as { sessions: Record<string, unknown>[] };
    for (const row of rows.sessions) expect(row.time_archived).toBeNull();
  });

  it("AC 5: an apply run appends ONE receipt line (mode apply, archived count + ids) and the junk sessions relocate", () => {
    seedDb(db, junkSeeds());
    const r = job(["--apply"], jobEnv());
    expect(r.code).toBe(0);

    const lines = receiptLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: "session-archive", mode: "apply", scanned: 4, archived: 3 });
    expect(new Set(lines[0].ids as string[])).toEqual(new Set(JUNK_OLD_IDS));

    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const vis = JSON.parse(run(["sessions", "list"], env).stdout);
    expect(new Set((vis.sessions as { id: string }[]).map((s) => s.id))).toEqual(new Set(["ses_real", "ses_young"]));
  });

  it("hard failure — a missing DB exits NONZERO and never touches the receipts journal", () => {
    const r = job([], { ...jobEnv(), SESSION_ARCHIVE_DB: join(tmp, "missing", "opencode.db") });
    expect(r.code).not.toBe(0);
    expect(existsSync(receipts)).toBe(false);
  });
});

// ══ #1311: the Jev classifier residual in autoarchive (the middle layer) ═══
// Residual-only wiring: sessions the deterministic rules leave unclassified
// get ONE Jev Choice; junk-bucket p ≥ 0.95 AND the FIXED 48 h gate admit to
// the archive path as an OR with the deterministic junk rule (which stays
// first and untouched). In-process deps inject the jev pass (no network);
// bundle runs prove the off-switch / unavailable zero-delta paths.
import { sessionsAutoarchive } from "../src/sessions_verb.js";
import { jevArchiveAdmits, type ResidualSession, type ResidualVerdict } from "../src/jev_curation.js";

/** A fake jev pass for the in-process wiring tests: records the sessions it
 * was asked about, answers from the given verdict map. */
function fakeJev(verdicts: Record<string, ResidualVerdict>, log: ResidualSession[] = []) {
  return async (sessions: ResidualSession[]): Promise<{ status: "ran"; verdicts: Record<string, ResidualVerdict> }> => {
    log.push(...sessions);
    return { status: "ran", verdicts };
  };
}

describe("sessions autoarchive — the jev classifier residual (#1311, in-process)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-jev-res-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("RESIDUAL-ONLY: the deterministic junk sessions get NO jev call — only the rule-unclassified do", async () => {
    seedDb(db, junkSeeds());
    const asked: ResidualSession[] = [];

    const r = await sessionsAutoarchive(["--db", db], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops }, { jev: fakeJev({}, asked) });

    expect(r.code).toBe(0);
    // the three junk sessions never reach the middle layer; ses_real (substantive, 72 h) is the residual
    expect(asked.map((s) => s.id)).toEqual(["ses_real"]);
    expect(asked[0].ageHours).toBeGreaterThanOrEqual(48);
  });

  it("admits a junk-bucket read at p ≥ 0.95 AND age ≥ 48 h: the session archives with the deterministic junk", async () => {
    seedDb(db, [
      ...junkSeeds(),
      { id: "ses_ambiguous", title: "Untitled follow-up", userMessages: ["hi"], assistantMessages: 2, updatedHoursAgo: 49 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };

    const dry = (await sessionsAutoarchive(["--db", db], env, { jev: fakeJev({ ses_ambiguous: { choice: "junk-greeting", confidence: 0.96 } }) })).json as Record<string, unknown>;
    expect(dry.candidates).toBe(4);
    expect(dry.jev).toMatchObject({ status: "ran", consulted: 2, admitted: 1, admitted_ids: ["ses_ambiguous"] });

    const applied = (await sessionsAutoarchive(["--db", db, "--apply"], env, { jev: fakeJev({ ses_ambiguous: { choice: "junk-greeting", confidence: 0.96 } }) })).json as Record<string, unknown>;
    expect(applied.archived).toBe(4);
    const visible = JSON.parse(run(["sessions", "list"], env).stdout);
    expect((visible.sessions as { id: string }[]).map((s) => s.id).sort()).toEqual(["ses_real", "ses_young"].sort());
  });

  it("the calibrated pair holds at the boundary: 0.94 never admits; 'substantive' and 'unclassified' never admit", async () => {
    seedDb(db, [
      { id: "ses_a", title: "Untitled one", userMessages: ["hi"], assistantMessages: 2, updatedHoursAgo: 49 },
      { id: "ses_b", title: "Untitled two", userMessages: ["hi"], assistantMessages: 2, updatedHoursAgo: 49 },
      { id: "ses_c", title: "Untitled three", userMessages: ["hi"], assistantMessages: 2, updatedHoursAgo: 49 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const verdicts: Record<string, ResidualVerdict> = {
      ses_a: { choice: "junk-greeting", confidence: 0.94 },
      ses_b: { choice: "substantive", confidence: 1.0 },
      ses_c: { choice: "unclassified", confidence: 1.0 },
    };

    const r = (await sessionsAutoarchive(["--db", db], env, { jev: fakeJev(verdicts) })).json as Record<string, unknown>;
    expect(r.candidates).toBe(0);
    expect(r.jev).toMatchObject({ consulted: 3, admitted: 0 });
  });

  it("the jev age gate is the FIXED 48 h, never the scan cutoff: a fresh scanned session is untouchable on a model's word", async () => {
    seedDb(db, [
      { id: "ses_fresh_sub", title: "Untitled fresh", userMessages: ["just started this"], assistantMessages: 2, updatedHoursAgo: 2 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };

    // --hours 1 scans the 2 h-old session; jev reads junk at 0.99 — still NO admission (2 h < 48 h)
    const r = (await sessionsAutoarchive(["--db", db, "--hours", "1"], env, { jev: fakeJev({ ses_fresh_sub: { choice: "junk-greeting", confidence: 0.99 } }) })).json as Record<string, unknown>;
    expect(r.candidates).toBe(0);
    expect(r.jev).toMatchObject({ admitted: 0 });
  });

  it("fail-open: a crashing jev pass never breaks the archive run — deterministic candidates survive intact", async () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const crash = async () => {
      throw new Error("jev down");
    };

    const dry = (await sessionsAutoarchive(["--db", db], env, { jev: crash })).json as Record<string, unknown>;
    expect(dry.candidates).toBe(3); // the deterministic junk, untouched
    expect(dry.jev).toMatchObject({ status: "error" });
    expect(run(["sessions", "list"], env).code).toBe(0);
  });
});

describe("sessions autoarchive — the jev off-switch and unavailability (bundle)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-jev-off-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  /** The deterministic output's exact key set — the zero-delta contract. */
  const DETERMINISTIC_KEYS = [
    "archived",
    "buckets",
    "candidate_ids",
    "candidates",
    "cutoff_iso",
    "cutoff_ms",
    "dry_run",
    "hours",
    "note",
    "scanned",
    "subcommand",
    "verb",
  ].sort();

  it("AMICO_JEV_DISABLED=1 → ZERO delta: the output JSON is exactly the deterministic shape (no jev key)", () => {
    seedDb(db, junkSeeds());
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops, AMICO_JEV_DISABLED: "1" };
    const r = JSON.parse(run(["sessions", "autoarchive"], env).stdout);
    expect(Object.keys(r).sort()).toEqual(DETERMINISTIC_KEYS);
    expect(r.candidates).toBe(3);
  });

  it("enabled but no key → fail-open with the honest unavailable report; the deterministic path is untouched", () => {
    seedDb(db, junkSeeds());
    const env = {
      OPENCODE_DB: db,
      AMICODE_OPS_DIR: ops,
      AMICO_JEV_DISABLED: "0",
      AMICO_TYPESAFE_KEY_FILE: join(tmp, "missing-key"),
    };
    const r = JSON.parse(run(["sessions", "autoarchive"], env).stdout);
    expect(r.candidates).toBe(3);
    expect(new Set(r.candidate_ids as string[])).toEqual(new Set(JUNK_OLD_IDS));
    expect(r.jev).toMatchObject({ status: "unavailable" });
  });

  it("default harness runs carry no jev key either (hermeticity guard, machine-key-proof)", () => {
    seedDb(db, junkSeeds());
    // run() injects AMICO_JEV_DISABLED=1 — the machine's real key cannot arm the residual
    const r = JSON.parse(run(["sessions", "autoarchive"], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops }).stdout);
    expect(r.jev).toBeUndefined();
  });
});

// ══ #1311: the onset thread-Noul pass — the amico-run half of the digest seam ══
// `amico sessions thread-noul` sweeps the digest window, ONE noul call per
// candidate (junk titles pre-filtered deterministically), and writes the
// derived map the onset digest reads (thread-nouls.json in the ops dir —
// dry-run by default, --apply writes). Fail-open on every client failure.
import { sessionsThreadNoul } from "../src/sessions_verb.js";
import type { NoulCandidate } from "../src/jev_curation.js";

describe("amico sessions thread-noul — the derived noul map (#1311, in-process)", () => {
  let tmp: string;
  let db: string;
  let ops: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-jev-noul-"));
    db = join(tmp, "opencode.db");
    ops = join(tmp, "ops");
    mkdirSync(ops, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  function fakeNouls(nouls: Record<string, number>, log: NoulCandidate[] = []) {
    return async (candidates: NoulCandidate[]) => {
      log.push(...candidates);
      return { status: "ran" as const, nouls };
    };
  }

  it("sweeps the window and asks ONE noul per NON-JUNK candidate — junk titles pre-filtered, window honored", async () => {
    seedDb(db, [
      { id: "ses_bug", title: "Bug report: panel", userMessages: ["the panel loses sessions"], lastAssistantText: "The fix is staged — waiting on your confirmation.", pendingTodos: 1, updatedHoursAgo: 20 },
      { id: "ses_greeting", title: "hello", userMessages: ["hi"], lastAssistantText: "Hello!", updatedHoursAgo: 2 },
      { id: "ses_old", title: "Ancient work", userMessages: ["old"], lastAssistantText: "done", createdDaysAgo: 40, updatedDaysAgo: 39 },
    ]);
    const asked: NoulCandidate[] = [];

    const r = (await sessionsThreadNoul(["--db", db], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops }, { jev: fakeNouls({ ses_bug: 0.71 }, asked) })).json as Record<string, unknown>;

    // only the bug report: greeting junk pre-filtered, the 39-day-old session outside the 14-day window
    expect(asked.map((c) => c.id)).toEqual(["ses_bug"]);
    expect(asked[0]).toMatchObject({ title: "Bug report: panel", pendingTodos: 1 });
    expect(asked[0].lastAssistantText).toContain("waiting on your confirmation");
    expect(r).toMatchObject({ subcommand: "thread-noul", status: "ran", candidates: 1, judged: 1 });
  });

  it("dry-run is the DEFAULT (reports, writes no map); --apply writes the map the digest reads", async () => {
    seedDb(db, [
      { id: "ses_bug", title: "Bug report: panel", userMessages: ["fix it"], lastAssistantText: "Waiting on your call.", pendingTodos: 1, updatedHoursAgo: 20 },
    ]);
    const env = { OPENCODE_DB: db, AMICODE_OPS_DIR: ops };
    const mapPath = join(ops, "thread-nouls.json");

    const dry = (await sessionsThreadNoul(["--db", db], env, { jev: fakeNouls({ ses_bug: 0.71 }) })).json as Record<string, unknown>;
    expect(dry.dry_run).toBe(true);
    expect(existsSync(mapPath)).toBe(false);

    const applied = (await sessionsThreadNoul(["--db", db, "--apply"], env, { jev: fakeNouls({ ses_bug: 0.71 }) })).json as Record<string, unknown>;
    expect(applied.dry_run).toBe(false);
    expect(applied.map_path).toBe(mapPath);
    const written = JSON.parse(readFileSync(mapPath, "utf8"));
    expect(written).toMatchObject({ schema_version: 1, entries: { ses_bug: 0.71 } });
    expect(typeof written.generated_at).toBe("string");
  });

  it("fail-open: a crashing pass reports the error, writes NO map, exits 0", async () => {
    seedDb(db, [
      { id: "ses_bug", title: "Bug report: panel", userMessages: ["fix it"], lastAssistantText: "Waiting on your call.", updatedHoursAgo: 20 },
    ]);
    const crash = async () => {
      throw new Error("jev down");
    };

    const r = (await sessionsThreadNoul(["--db", db, "--apply"], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops }, { jev: crash })).json as Record<string, unknown>;
    expect(r.status).toBe("error");
    expect(existsSync(join(ops, "thread-nouls.json"))).toBe(false);
  });

  it("no key → unavailable, no map (the fail-open configuration)", async () => {
    seedDb(db, [
      { id: "ses_bug", title: "Bug report: panel", userMessages: ["fix it"], lastAssistantText: "Waiting on your call.", updatedHoursAgo: 20 },
    ]);
    const jev = async (candidates: NoulCandidate[]) => ({ status: "unavailable" as const, nouls: {} as Record<string, number> });

    const r = (await sessionsThreadNoul(["--db", db, "--apply"], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops, AMICO_TYPESAFE_KEY_FILE: join(tmp, "missing-key") }, { jev })).json as Record<string, unknown>;
    expect(r.status).toBe("unavailable");
    expect(r.candidates).toBe(1);
    expect(r).not.toHaveProperty("entries");
    expect(existsSync(join(ops, "thread-nouls.json"))).toBe(false);
  });

  it("the off-switch (bundle): ZERO delta — no jev block, no map, exit 0", () => {
    seedDb(db, [
      { id: "ses_bug", title: "Bug report: panel", userMessages: ["fix it"], lastAssistantText: "Waiting on your call.", updatedHoursAgo: 20 },
    ]);
    const r = JSON.parse(run(["sessions", "thread-noul", "--apply"], { OPENCODE_DB: db, AMICODE_OPS_DIR: ops }).stdout);
    expect(r.verb).toBe("sessions");
    expect(r.subcommand).toBe("thread-noul"); // the verb RAN (not a usage error)
    expect(r.jev).toBeUndefined();
    expect(r.status).toBeUndefined();
    expect(existsSync(join(ops, "thread-nouls.json"))).toBe(false);
  });

  it("usage: a missing DB is an honest 64; bad --days is a usage error", async () => {
    expect((await sessionsThreadNoul(["--db", join(tmp, "nope.db")], { AMICODE_OPS_DIR: ops })).code).toBe(64);
    expect((await sessionsThreadNoul(["--db", db, "--days", "0"], { AMICODE_OPS_DIR: ops })).code).toBe(64);
  });
});

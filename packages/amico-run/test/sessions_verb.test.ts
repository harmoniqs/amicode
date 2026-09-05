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
  readArchiveDays,
  writeArchiveDays,
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
    const stdout = execFileSync("node", [BUNDLE, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
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
  updatedDaysAgo: number;
  createdDaysAgo?: number;
  archived?: boolean;
  parent?: string;
}

/** Seed a minimal session table shaped like the live DB's (the columns the verb
 *  queries exist in both; the engine owns the real DDL). Seeding runs in a
 *  spawned `node -e` so `node:sqlite` never enters vitest's module graph
 *  (vite-node's builtin list predates it and cannot load it). */
function seedDb(dbPath: string, seeds: SeedOpts[]): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.argv[1]);
    const now = Date.now();
    db.exec(\`CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_archived INTEGER
    )\`);
    const ins = db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?)");
    for (const s of JSON.parse(process.argv[2])) {
      const updated = now - s.updatedDaysAgo * ${DAY};
      const created = now - (s.createdDaysAgo !== undefined ? s.createdDaysAgo : s.updatedDaysAgo + 1) * ${DAY};
      ins.run(s.id, s.parent ?? null, s.directory ?? "/home/aaron/armonia", s.title ?? ("session " + s.id),
        created, updated, s.archived ? now - s.updatedDaysAgo * ${DAY} : null);
    }
    db.close();
  `;
  execFileSync(
    process.execPath,
    ["--no-warnings", "-e", script, dbPath, JSON.stringify(seeds)],
    { encoding: "utf8" },
  );
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

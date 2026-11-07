// `amico distill` (amicode #1680 — brain flywheel slice 1, the artery): the
// nightly notturno job that distills classified-substantive chat sessions into
// candidate claim-notes with resolvable provenance. Hermetic suite — seeded
// COPY databases in temp dirs (the session-archive fixture pattern, never the
// live chat DB), in-process jev injection (the #1311 residual discipline),
// and tiny fixture registries (the notturno verb's tinyRegistry pattern).
// Run: `pnpm --filter @amicode/amico-run test distill`
import { beforeAll, describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { distillVerb } from "../src/distill_verb.js";
import { claimTypeQuestion, CLAIM_TYPES, CLAIM_TYPE_NONE, type ClaimTypeCandidate, type ClaimTypeVerdict, type JevPassStatus } from "../src/jev_curation.js";
import { classifySession, type SessionFeatures } from "../src/session_junk.js";

// ── the seeded-DB harness (the sessions_verb.test.ts fixture pattern) ─────────
const DAY = 86_400_000;

interface SeedOpts {
  id: string;
  title?: string;
  directory?: string;
  updatedDaysAgo?: number;
  createdDaysAgo?: number;
  archived?: boolean;
  parent?: string;
  userMessages?: string[];
  assistantMessages?: number;
  lastAssistantText?: string;
  pendingTodos?: number;
}

/** Seed a minimal chat DB shaped like the live one (the columns the verb's
 *  queries exist in both; the engine owns the real DDL). python3 stdlib
 *  sqlite3 — the same driver the verb uses (sqlite_bridge.ts). */
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
for s in seeds:
    updated = now - s.get("updatedDaysAgo", 1) * day
    created = now - s.get("createdDaysAgo", (s.get("updatedDaysAgo", 1) + 1)) * day
    con.execute(
        "INSERT INTO session (id, parent_id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?)",
        (s["id"], s.get("parent"), s.get("directory", "/home/aaron/armonia"), s.get("title", "session " + s["id"]),
         created, updated, now - s.get("updatedDaysAgo", 1) * day if s.get("archived") else None),
    )
    for i, text in enumerate(s.get("userMessages") or []):
        mid = "msg_%s_%d" % (s["id"], i)
        con.execute("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)",
                    (mid, s["id"], created + i, updated, json.dumps({"role": "user"})))
        con.execute("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)",
                    ("part_" + mid, mid, s["id"], created + i, updated, json.dumps({"type": "text", "text": text})))
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

/** Read-only probe: which of the given session/message ids exist in the DB —
 * the evidence-pointer RESOLUTION check (the #1680 constraint: every pointer
 * a claim-note carries must resolve into the substrate). */
function resolvePointers(
  dbPath: string,
  sessionIds: string[],
  messageIds: string[],
): { sessions: string[]; messages: string[] } {
  const script = `
import json, sqlite3, sys
con = sqlite3.connect("file:" + sys.argv[1] + "?mode=ro", uri=True, timeout=5)
sessions = sys.argv[2].split(",") if sys.argv[2] else []
messages = sys.argv[3].split(",") if sys.argv[3] else []
out = {"sessions": [], "messages": []}
for sid in sessions:
    if con.execute("SELECT 1 FROM session WHERE id = ?", (sid,)).fetchone():
        out["sessions"].append(sid)
for mid in messages:
    if con.execute("SELECT 1 FROM message WHERE id = ?", (mid,)).fetchone():
        out["messages"].append(mid)
print(json.dumps(out))
  `;
  return JSON.parse(execFileSync(pythonBin(), ["-c", script, dbPath, sessionIds.join(","), messageIds.join(",")], { encoding: "utf8" }));
}

function pythonBin(): string {
  return process.env.AMICO_PYTHON && process.env.AMICO_PYTHON.trim() !== "" ? process.env.AMICO_PYTHON : "python3";
}

// ── the fake jev pass (the #1311 in-process injection discipline) ────────────

/** A fake claim-type jev: records every candidate it was asked about (id +
 *  the digest fold the question would send) and answers from the verdict
 *  map. The asked list is AC 3's witness — junk sessions must NEVER appear
 *  in it. */
function fakeJev(
  verdicts: Record<string, { choice: string; confidence: number }>,
  asked?: { id: string; state: unknown }[],
): (candidates: ClaimTypeCandidate[]) => Promise<{ status: JevPassStatus; verdicts: Record<string, ClaimTypeVerdict> }> {
  return async (candidates) => {
    for (const c of candidates) asked?.push({ id: c.id, state: claimTypeQuestion(c).state });
    return { status: "ran", verdicts: { ...verdicts } };
  };
}

/** A tiny fixture notturno registry (the notturno verb's tinyRegistry pattern)
 *  with the distill job registered — the receipt's membership check. */
function distillRegistry(dir: string, record: "always" | "acted" = "always", name = "registry.toml"): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    [
      "[job.distill]",
      'workflow = "notturno-distill.yml"',
      'cadence  = "0 4 * * *"',
      'surface  = "mini"',
      'warrant  = "stage"',
      'delivers = ["vault-commit"]',
      `record   = "${record}"`,
      "enabled  = true",
      "",
    ].join("\n"),
  );
  return p;
}

// ── shared fixtures ──────────────────────────────────────────────────────────

/** A clearly substantive session (real user text, many assistant turns). */
const SUBSTANTIVE_USER_TEXT =
  "so apparently all of my agentic amicode work is causing headaches for jack and jj who have to revert or fix my merges; " +
  "let's work out a mitigation plan with pre-merge verification and a shared checklist.";

function substantiveSeed(): SeedOpts {
  return {
    id: "ses_good",
    title: "Agent merges causing teammate reverts — mitigation plan",
    updatedDaysAgo: 1,
    userMessages: [SUBSTANTIVE_USER_TEXT, "yes, add the checklist step before every merge, that is the method we want"],
    assistantMessages: 6,
    lastAssistantText: "solved: the mitigation plan — pre-merge verification gates plus a shared checklist, recorded as a best practice.",
  };
}

function junkSeeds(): SeedOpts[] {
  return [
    { id: "ses_hi", title: "hello", updatedDaysAgo: 1, userMessages: ["hi"], assistantMessages: 2 },
    { id: "ses_dead", title: "spawned then eaten", updatedDaysAgo: 1, userMessages: ["go"] },
    { id: "ses_probe", title: "probe", updatedDaysAgo: 1, userMessages: [], assistantMessages: 0 },
  ];
}

/** Classify a seed through the REAL classifier — the worklist contract witness
 *  (the distill verb reuses #1304's classification, never a second classifier). */
function bucketOf(seed: SeedOpts): string {
  return classifySession({
    title: seed.title ?? `session ${seed.id}`,
    user_message_count: (seed.userMessages ?? []).length,
    user_text_chars: (seed.userMessages ?? []).join("").length,
    assistant_message_count: (seed.assistantMessages ?? 0) + (seed.lastAssistantText !== undefined ? 1 : 0),
    todo_count: seed.pendingTodos ?? 0,
  } satisfies SessionFeatures);
}

// ── AC 1: a substantive session distills to a candidate claim-note ──────────

describe("amico distill — AC 1: candidate claim-note with resolvable evidence", () => {
  let tmp: string;
  let db: string;
  let cand: string;
  let state: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-distill-"));
    db = join(tmp, "opencode.db");
    cand = join(tmp, "claims", "candidates");
    state = join(tmp, "distill-state.json");
    env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp, AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("emits at least one candidate claim-note carrying the session id, and every evidence pointer resolves", async () => {
    seedDb(db, [substantiveSeed(), ...junkSeeds()]);
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state],
      env,
      { jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.91 } }) },
    );
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json).toMatchObject({ verb: "distill", dry_run: false, status: "ran", distilled: 1, claims: 1 });

    // the note exists in the dedicated candidate area, keyed by session id
    const notePath = join(cand, "claim-ses_good.md");
    expect(existsSync(notePath)).toBe(true);
    expect((json.notes as string[])[0]).toBe(notePath);

    // frontmatter: provenance (session id, timestamps) + the claim contract
    const raw = readFileSync(notePath, "utf8");
    expect(raw.startsWith("---\n")).toBe(true);
    const fm = parseYaml(raw.split("\n---")[0]!.replace(/^---\n/, "")) as Record<string, unknown>;
    expect(fm.session_id).toBe("ses_good");
    expect(fm.type).toBe("claim-candidate");
    expect(fm.claim_type).toBe("insight");
    expect(fm.status).toBe("unverified");
    expect(fm.confidence).toBe(0.91);
    expect(String(fm.statement)).toContain("mitigation plan");
    expect(typeof fm.distilled_at).toBe("string");
    expect(String(fm.session_created)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(fm.session_updated)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(String(fm.source_db)).toBe(db);

    // AC 1's evidence contract: EVERY pointer resolves into the chat DB
    const pointers = fm.evidence as string[];
    expect(pointers.length).toBeGreaterThanOrEqual(2);
    expect(pointers).toContain("chat-session/ses_good");
    const sessionIds = pointers.filter((p) => p.startsWith("chat-session/")).map((p) => p.slice("chat-session/".length));
    const messageIds = pointers.filter((p) => p.startsWith("chat-message/")).map((p) => p.slice("chat-message/".length));
    expect(messageIds.length).toBeGreaterThanOrEqual(1);
    const resolved = resolvePointers(db, sessionIds, messageIds);
    expect(resolved.sessions.sort()).toEqual(sessionIds.sort());
    expect(resolved.messages.sort()).toEqual(messageIds.sort());
  });

  it("evidence is SALIENT, not wholesale: a long session cites the fold's bounded rows (first/last user + last assistant), all resolving", async () => {
    const many: SeedOpts = {
      id: "ses_long",
      title: "A long working session with a real conclusion",
      updatedDaysAgo: 1,
      userMessages: Array.from({ length: 10 }, (_, i) => `turn ${i}: ${"working through the design, ".repeat(8)}`),
      assistantMessages: 12,
      lastAssistantText: "solved — the durable finding is recorded here",
    };
    seedDb(db, [many]);
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_long: { choice: "insight", confidence: 0.9 } }),
    });
    expect(r.code).toBe(0);
    const raw = readFileSync(join(cand, "claim-ses_long.md"), "utf8");
    const fm = parseYaml(raw.split("\n---")[0]!.replace(/^---\n/, "")) as Record<string, unknown>;
    const pointers = fm.evidence as string[];
    const messageIds = pointers.filter((p) => p.startsWith("chat-message/")).map((p) => p.slice("chat-message/".length));
    // bounded: the fold's inputs, never the whole spine (the live-DB flaw)
    expect(messageIds.length).toBe(3);
    // and they resolve into the substrate
    const resolved = resolvePointers(db, ["ses_long"], messageIds);
    expect(resolved.sessions).toEqual(["ses_long"]);
    expect(resolved.messages.sort()).toEqual([...messageIds].sort());
  });

  it("a 'none' verdict writes no note but stamps the session (the honest no-claim path)", async () => {
    seedDb(db, [substantiveSeed()]);
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_good: { choice: CLAIM_TYPE_NONE, confidence: 0.8 } }),
    });
    expect(r.code).toBe(0);
    const json = r.json as Record<string, unknown>;
    expect(json).toMatchObject({ distilled: 1, claims: 0, no_claim: 1 });
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(false);
    const stamp = JSON.parse(readFileSync(state, "utf8")) as { entries: Record<string, { claim_type: string }> };
    expect(stamp.entries.ses_good).toMatchObject({ claim_type: "none" });
  });

  it("a per-session jev error is fail-open: no note, no stamp, counted honestly, the run still exits 0", async () => {
    seedDb(db, [substantiveSeed()]);
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: async () => ({ status: "ran", verdicts: { ses_good: { error: "no choice answer for claim_type" } } }),
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ distilled: 0, claims: 0, errors: 1 });
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(false);
  });
});

// ── AC 2: the state stamp makes re-runs no-ops ───────────────────────────────

describe("amico distill — AC 2: already-distilled sessions are no-ops on re-run", () => {
  let tmp: string;
  let db: string;
  let cand: string;
  let state: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-distill-2-"));
    db = join(tmp, "opencode.db");
    cand = join(tmp, "claims", "candidates");
    state = join(tmp, "distill-state.json");
    env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp, AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("re-running --apply after a successful distill consults nothing and writes nothing new", async () => {
    seedDb(db, [substantiveSeed()]);
    const asked: { id: string; state: unknown }[] = [];
    const jev = fakeJev({ ses_good: { choice: "method", confidence: 0.88 } }, asked);
    const first = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, { jev });
    expect(first.json).toMatchObject({ distilled: 1, claims: 1 });
    expect(asked.map((a) => a.id)).toEqual(["ses_good"]);

    const asked2: { id: string; state: unknown }[] = [];
    const second = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_good: { choice: "method", confidence: 0.88 } }, asked2),
    });
    expect(second.code).toBe(0);
    expect(second.json).toMatchObject({ dry_run: false, distilled: 0, claims: 0, already_distilled: 1, consulted: 0 });
    expect(asked2).toEqual([]); // no second jev call for the same session
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(true); // exactly one note, not overwritten
    const files = (readFileSync(join(cand, "claim-ses_good.md"), "utf8") as string).length;
    expect(files).toBeGreaterThan(0);
  });

  it("a malformed state file fails safe to empty (re-distills) rather than crashing", async () => {
    seedDb(db, [substantiveSeed()]);
    writeFileSync(state, "{not json");
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }),
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ distilled: 1, claims: 1 });
  });
});

// ── AC 3: junk-classified sessions are never read for distillation ───────────

describe("amico distill — AC 3: junk never reaches distillation", () => {
  let tmp: string;
  let db: string;
  let cand: string;
  let state: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-distill-3-"));
    db = join(tmp, "opencode.db");
    cand = join(tmp, "claims", "candidates");
    state = join(tmp, "distill-state.json");
    env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp, AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("junk-greeting/dead-cast/probe sessions are never consulted and never distilled", async () => {
    const junk = junkSeeds();
    // the worklist-contract witness: the REAL classifier buckets these junk
    for (const j of junk) expect(bucketOf(j)).not.toBe("substantive");
    expect(bucketOf(substantiveSeed())).toBe("substantive");

    seedDb(db, [substantiveSeed(), ...junk]);
    const asked: { id: string; state: unknown }[] = [];
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }, asked),
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ scanned: 4, substantive: 1, distilled: 1 });
    expect((r.json as Record<string, unknown>).junk).toBe(3);
    // only the substantive session reached the middle layer
    expect(asked.map((a) => a.id)).toEqual(["ses_good"]);
    // no candidate note names a junk session
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(true);
    for (const j of junk) expect(existsSync(join(cand, `claim-${j.id}.md`))).toBe(false);
  });

  it("a named junk session (--session) is refused for distillation, honestly", async () => {
    seedDb(db, junkSeeds());
    const asked: { id: string; state: unknown }[] = [];
    const r = await distillVerb(["--apply", "--session", "ses_hi", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({}, asked),
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ status: "ran", consulted: 0, distilled: 0, junk_named: "ses_hi" });
    expect(asked).toEqual([]);
  });
});

// ── AC 4: the pass receipt in the notturno journal ────────────────────────────

describe("amico distill — AC 4: the notturno pass receipt (job name, counts, duration)", () => {
  let tmp: string;
  let db: string;
  let cand: string;
  let state: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-distill-4-"));
    db = join(tmp, "opencode.db");
    cand = join(tmp, "claims", "candidates");
    state = join(tmp, "distill-state.json");
    env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp, AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("an acted run files a scheduled-passes.md record: job distill, counts, duration", async () => {
    seedDb(db, [substantiveSeed()]);
    const registry = distillRegistry(tmp);
    const dashboards = join(tmp, "dashboards");
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }) },
    );
    expect(r.code).toBe(0);
    const receipt = (r.json as Record<string, unknown>).receipt as Record<string, unknown>;
    expect(receipt).toMatchObject({ filed: true, job: "distill" });

    const journal = readFileSync(join(dashboards, "scheduled-passes.md"), "utf8");
    // the notturno section shape: job name + status in the header, counts in the
    // outcome line, duration + artifacts on their own lines
    expect(journal).toContain("# Scheduled passes");
    expect(journal).toMatch(/## Pass \d{4}-\d{2}-\d{2} — distill — ok/);
    expect(journal).toMatch(/- distill: scanned \d+ sessions \(substantive \d+, junk \d+\), distilled 1, claims 1, none 0, errors 0/);
    expect(journal).toMatch(/- duration: \d+s/);
    expect(journal).toContain(`- artifacts:\n  - ${join(cand, "claim-ses_good.md")}`);
  });

  it("an unregistered job id is refused: the registry membership check (exit 2, no receipt)", async () => {
    seedDb(db, [substantiveSeed()]);
    const registry = join(tmp, "other.toml");
    writeFileSync(registry, '[job.other]\nworkflow = "w.yml"\ncadence = "* * *"\nsurface = "mini"\nwarrant = "stage"\nenabled = false\n');
    const dashboards = join(tmp, "dashboards");
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }) },
    );
    expect(r.code).toBe(2);
    expect((r.json as Record<string, unknown>).error).toMatch(/unknown job 'distill'/);
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
  });

  it("a deny-listed registry is refused loudly (exit 64) — org config never runs through the public verb", async () => {
    seedDb(db, [substantiveSeed()]);
    const sub = join(tmp, "automation", "notturno");
    mkdirSync(sub, { recursive: true });
    const registry = distillRegistry(sub, "always", "notturno.toml");
    writeFileSync(
      join(sub, "instance-deny-list.toml"),
      '[[deny]]\npath = "automation/notturno/notturno.toml"\nreason = "instance config by construction"\n',
    );
    const dashboards = join(tmp, "dashboards");
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }) },
    );
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).error).toMatch(/denied by the instance deny list/);
  });

  it("record = \"acted\" + zero distilled → no receipt (self-filtering, the notturno record-mode contract)", async () => {
    seedDb(db, [substantiveSeed()]);
    const registry = distillRegistry(tmp, "acted");
    const dashboards = join(tmp, "dashboards");
    // already-distilled stamp → the run consults nothing → acted nothing
    writeFileSync(state, JSON.stringify({ schema_version: 1, entries: { ses_good: { distilled_at: "2026-10-01T00:00:00Z", claim_type: "none", note: null } } }));
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({}) },
    );
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).receipt).toMatchObject({ filed: false, skipped: true });
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
  });

  it("no --registry → the body still runs, the receipt is honestly not filed", async () => {
    seedDb(db, [substantiveSeed()]);
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], env, {
      jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }),
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ distilled: 1, claims: 1 });
    expect((r.json as Record<string, unknown>).receipt).toMatchObject({ filed: false, reason: "no --registry" });
  });

  it("--registry without --dashboards is a usage error (the receipt has nowhere to land)", async () => {
    seedDb(db, [substantiveSeed()]);
    const registry = distillRegistry(tmp);
    const r = await distillVerb(["--apply", "--candidates", cand, "--state", state, "--registry", registry], env, {
      jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }),
    });
    expect(r.code).toBe(64);
    expect((r.json as Record<string, unknown>).error).toMatch(/--dashboards/);
  });
});

// ── AC 5: dry (report-only) and apply (writes) are explicit modes ─────────────

describe("amico distill — AC 5: dry-run by default, --apply writes", () => {
  let tmp: string;
  let db: string;
  let cand: string;
  let state: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "amico-distill-5-"));
    db = join(tmp, "opencode.db");
    cand = join(tmp, "claims", "candidates");
    state = join(tmp, "distill-state.json");
    env = { OPENCODE_DB: db, AMICODE_OPS_DIR: tmp, AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key" };
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("dry-run (default) consults nothing and writes nothing — it reports the would-distill set", async () => {
    seedDb(db, [substantiveSeed(), ...junkSeeds()]);
    const asked: { id: string; state: unknown }[] = [];
    const registry = distillRegistry(tmp);
    const dashboards = join(tmp, "dashboards");
    const r = await distillVerb(
      ["--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({ ses_good: { choice: "insight", confidence: 0.9 } }, asked) },
    );
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ dry_run: true, scanned: 4, substantive: 1, would_distill: 1, consulted: 0 });
    expect(asked).toEqual([]);
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(false);
    expect(existsSync(state)).toBe(false);
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(false);
  });

  it("--apply writes the note, the state stamp, and the receipt (all three)", async () => {
    seedDb(db, [substantiveSeed()]);
    const registry = distillRegistry(tmp);
    const dashboards = join(tmp, "dashboards");
    const r = await distillVerb(
      ["--apply", "--candidates", cand, "--state", state, "--registry", registry, "--dashboards", dashboards],
      env,
      { jev: fakeJev({ ses_good: { choice: "hazard", confidence: 0.95 } }) },
    );
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ dry_run: false });
    expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(true);
    const stamp = JSON.parse(readFileSync(state, "utf8")) as { schema_version: number; entries: Record<string, unknown> };
    expect(stamp.schema_version).toBe(1);
    expect(stamp.entries.ses_good).toMatchObject({ claim_type: "hazard", note: join(cand, "claim-ses_good.md") });
    expect(existsSync(join(dashboards, "scheduled-passes.md"))).toBe(true);
  });
});

// ── the jev seam (the #1311 middle-layer discipline, third call site) ─────────

describe("distill — the jev claim-type seam", () => {
  it("the question is a Choice over the parent claim contract's closed type set, 'none' included", () => {
    const seed = substantiveSeed();
    const { question, state } = claimTypeQuestion({
      id: "ses_good",
      title: seed.title!,
      userMessageCount: 2,
      userTextChars: SUBSTANTIVE_USER_TEXT.length,
      assistantMessageCount: 7,
      firstUserText: SUBSTANTIVE_USER_TEXT,
      lastUserText: "add the checklist step",
      lastAssistantText: "solved: the mitigation plan",
    });
    expect(question.type).toBe("choice");
    expect(question.instructions).toMatch(/[Dd]urable knowledge/);
    for (const t of [...CLAIM_TYPES, CLAIM_TYPE_NONE]) expect(question.criteria).toHaveProperty(t);
    expect((state as Record<string, unknown>).title).toBe(seed.title);
    // the fold is digest-sized: excerpts are capped, never raw spines
    expect(JSON.stringify(state).length).toBeLessThan(2000);
  });

  it("unavailable jev (no key) is a NAMED no-op: nothing distilled, nothing stamped, exit 0", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "amico-distill-jev-"));
    try {
      const db = join(tmp, "opencode.db");
      const cand = join(tmp, "claims", "candidates");
      const state = join(tmp, "distill-state.json");
      seedDb(db, [substantiveSeed()]);
      const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], {
        OPENCODE_DB: db,
        AMICODE_OPS_DIR: tmp,
        AMICO_TYPESAFE_KEY_FILE: "/nonexistent/amico-test-guard/no-key",
      });
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ status: "unavailable", distilled: 0, consulted: 0 });
      expect(existsSync(state)).toBe(false);
      expect(existsSync(join(cand, "claim-ses_good.md"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("AMICO_JEV_DISABLED=1 is the zero-delta off-switch: status disabled, nothing written", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "amico-distill-off-"));
    try {
      const db = join(tmp, "opencode.db");
      const cand = join(tmp, "claims", "candidates");
      const state = join(tmp, "distill-state.json");
      seedDb(db, [substantiveSeed()]);
      const r = await distillVerb(["--apply", "--candidates", cand, "--state", state], {
        OPENCODE_DB: db,
        AMICODE_OPS_DIR: tmp,
        AMICO_JEV_DISABLED: "1",
      });
      expect(r.code).toBe(0);
      expect(r.json).toMatchObject({ status: "disabled", distilled: 0 });
      expect(existsSync(state)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ── usage + the CLI wiring (bundle: the verb must be reachable as `amico distill`) ──

const BUNDLE = join(__dirname, "..", "dist", "amico.js");
beforeAll(() => {
  execFileSync("node", [join(__dirname, "..", "esbuild.config.mjs")], { cwd: join(__dirname, "..") });
});

describe("amico distill — usage errors and CLI wiring (bundle)", () => {
  function run(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("node", [BUNDLE, ...args], {
        encoding: "utf8",
        env: { ...process.env, AMICO_JEV_DISABLED: "1", ...env },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("is a registered top-level verb: `amico distill` runs (disabled path), not unknown-verb", () => {
    const tmp = mkdtempSync(join(tmpdir(), "amico-distill-cli-"));
    try {
      const db = join(tmp, "opencode.db");
      seedDb(db, [substantiveSeed()]);
      const r = run(["distill", "--db", db, "--candidates", join(tmp, "c"), "--state", join(tmp, "s.json"), "--apply"]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ verb: "distill", status: "disabled" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("missing DB is an honest 64, not a live-DB guess", () => {
    const r = run(["distill", "--db", "/nonexistent/amico-test-guard/no.db"]);
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatch(/not found/);
  });

  it("unknown flag is a usage 64", () => {
    const tmp = mkdtempSync(join(tmpdir(), "amico-distill-usage-"));
    try {
      const db = join(tmp, "opencode.db");
      seedDb(db, []);
      const r = run(["distill", "--db", db, "--bogus"], { OPENCODE_DB: db });
      expect(r.code).toBe(64);
      expect(JSON.parse(r.stdout).error).toMatch(/unknown flag/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bad --limit is a usage 64", () => {
    const tmp = mkdtempSync(join(tmpdir(), "amico-distill-limit-"));
    try {
      const db = join(tmp, "opencode.db");
      seedDb(db, []);
      const r = run(["distill", "--db", db, "--limit", "0"]);
      expect(r.code).toBe(64);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

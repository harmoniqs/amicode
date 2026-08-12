// Tests for the Problem-workspace fs module (opencode-plugin/problems.ts).
//
// problems.ts uses node: builtins (fs/path/os) — sibling-module rules, not the
// dependency-free entities.ts. Every test points AMICODE_PROBLEMS_DIR at a fresh
// temp dir so nothing touches the real ~/.amico. Reads go through .json sidecars.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "smol-toml";
import {
  problemsDir,
  problemDir,
  readActiveSlug,
  setActiveSlug,
  listProblems,
  createProblem,
  openProblem,
  renameProblem,
  archiveProblem,
  ensureActiveProblem,
  appendEvent,
  appendRunRef,
  writeEntityFiles,
  lastEventSeq,
  migrateLegacyEntities,
} from "../opencode-plugin/problems";

let tmp: string;
let prevEnv: string | undefined;

beforeEach(() => {
  prevEnv = process.env.AMICODE_PROBLEMS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-problems-"));
  process.env.AMICODE_PROBLEMS_DIR = tmp;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
  else process.env.AMICODE_PROBLEMS_DIR = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("problemsDir / problemDir", () => {
  it("honors AMICODE_PROBLEMS_DIR", () => {
    expect(problemsDir()).toBe(tmp);
    expect(problemDir("x-gate")).toBe(path.join(tmp, "x-gate"));
  });
});

describe("createProblem", () => {
  it("writes card.toml + card.json + entities/ and sets active (W2.1: problem.toml is the ProblemSpec)", () => {
    const meta = createProblem("X gate on Q1");
    expect(meta.slug).toBe("x-gate-on-q1");
    expect(meta.status).toBe("designing");
    const dir = problemDir("x-gate-on-q1");
    expect(fs.existsSync(path.join(dir, "card.toml"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "card.json"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "entities"))).toBe(true);
    // legacy problem.* must NOT exist — that basename is now the ProblemSpec
    expect(fs.existsSync(path.join(dir, "problem.toml"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "problem.json"))).toBe(false);
    expect(readActiveSlug()).toBe("x-gate-on-q1");
    const doc = parse(fs.readFileSync(path.join(dir, "card.toml"), "utf8")) as any;
    expect(doc.problem.name).toBe("X gate on Q1");
  });
  it("reads legacy problem.json when card.json absent (backward compat)", () => {
    const dir = problemDir("legacy-read");
    fs.mkdirSync(dir, { recursive: true });
    // Simulate old workspace with problem.json only
    fs.writeFileSync(path.join(dir, "problem.json"), JSON.stringify({ name: "old", slug: "legacy-read", created: new Date().toISOString(), status: "designing" }));
    fs.writeFileSync(path.join(dir, "problem.toml"), `[problem]\nname = "old"\nslug = "legacy-read"\ncreated = "2026-01-01T00:00:00Z"\nstatus = "designing"\nrecorded = "2026-01-01T00:00:00Z"\n`);
    setActiveSlug("legacy-read");
    const opened = openProblem("legacy-read");
    expect(opened?.slug).toBe("legacy-read");
  });
  it("auto-suffixes a colliding slug", () => {
    createProblem("X gate");
    const second = createProblem("X gate");
    expect(second.slug).toBe("x-gate-2");
  });
  it("records a problem/created lifecycle event", () => {
    const meta = createProblem("X gate");
    const lines = fs
      .readFileSync(path.join(problemDir(meta.slug), "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    const evt = JSON.parse(lines[0]);
    expect(evt).toMatchObject({ seq: 1, entity: "problem", action: "created" });
    expect(Number.isNaN(Date.parse(evt.ts))).toBe(false);
  });
});

describe("openProblem", () => {
  it("opens by exact slug and by fuzzy name, sets active", () => {
    createProblem("X gate on Q1");
    createProblem("Y gate on Q2");
    expect(openProblem("x-gate-on-q1")?.slug).toBe("x-gate-on-q1");
    expect(readActiveSlug()).toBe("x-gate-on-q1");
    expect(openProblem("gate on q2")?.slug).toBe("y-gate-on-q2");
    expect(openProblem("nonexistent")).toBeUndefined();
  });
  it("excludes archived from fuzzy match but still opens by exact slug", () => {
    createProblem("X gate on Q1");
    archiveProblem("x-gate-on-q1");
    expect(openProblem("gate on q1")).toBeUndefined();
    expect(openProblem("x-gate-on-q1")?.slug).toBe("x-gate-on-q1");
  });
});

describe("renameProblem", () => {
  it("renames name only for an established (non-untitled) slug", () => {
    createProblem("X gate");
    const meta = renameProblem("x-gate", "X gate on transmon Q1");
    expect(meta.slug).toBe("x-gate"); // slug immutable
    expect(meta.name).toBe("X gate on transmon Q1");
    expect(fs.existsSync(problemDir("x-gate"))).toBe(true);
  });
  it("re-slugs and renames the dir for an untitled slug, updating active", () => {
    const u = ensureActiveProblem(); // untitled-*
    expect(u.slug.startsWith("untitled")).toBe(true);
    const meta = renameProblem(u.slug, "X gate on Q1");
    expect(meta.slug).toBe("x-gate-on-q1");
    expect(fs.existsSync(problemDir("x-gate-on-q1"))).toBe(true);
    expect(fs.existsSync(problemDir(u.slug))).toBe(false);
    expect(readActiveSlug()).toBe("x-gate-on-q1");
  });
});

describe("ensureActiveProblem", () => {
  it("auto-creates an untitled problem when no active pointer exists", () => {
    expect(readActiveSlug()).toBeUndefined();
    const meta = ensureActiveProblem();
    expect(meta.slug.startsWith("untitled")).toBe(true);
    expect(readActiveSlug()).toBe(meta.slug);
  });
  it("auto-creates when the active pointer is dangling", () => {
    setActiveSlug("deleted-slug"); // points at a dir that never existed
    const meta = ensureActiveProblem();
    expect(meta.slug).not.toBe("deleted-slug");
    expect(fs.existsSync(problemDir(meta.slug))).toBe(true);
  });
  it("returns the existing active problem when present", () => {
    const created = createProblem("X gate");
    const active = ensureActiveProblem();
    expect(active.slug).toBe(created.slug);
  });
});

describe("appendEvent", () => {
  it("returns a monotonic seq and writes valid JSONL", () => {
    const meta = createProblem("X gate"); // seq 1 = created
    const s2 = appendEvent(meta.slug, {
      entity: "system",
      action: "created",
      diff: { platform: { from: null, to: "transmon" } },
      hash: "sha256:abc",
      source: { tool: "amicode_pick_system", stage: "platform" },
    });
    const s3 = appendEvent(meta.slug, { entity: "system", action: "updated", diff: { levels: { from: 3, to: 4 } } });
    expect(s2).toBe(2);
    expect(s3).toBe(3);
    const lines = fs
      .readFileSync(path.join(problemDir(meta.slug), "events.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(3);
    const e2 = JSON.parse(lines[1]);
    expect(e2).toMatchObject({ seq: 2, entity: "system", action: "created", hash: "sha256:abc", provenance: null });
    expect(e2.source.tool).toBe("amicode_pick_system");
  });
});

describe("lastEventSeq", () => {
  it("returns 0 before any event and the highest seq after", () => {
    const meta = createProblem("X gate"); // created event = seq 1
    expect(lastEventSeq(meta.slug)).toBe(1);
    appendEvent(meta.slug, { entity: "system", action: "created" });
    expect(lastEventSeq(meta.slug)).toBe(2);
  });
});

describe("appendRunRef", () => {
  it("appends to both runs.toml and runs.json", () => {
    const meta = createProblem("X gate");
    appendRunRef(meta.slug, { run_id: "20260703-190412-abcd", lab: "default", tier: "vetted", recorded: "t1" });
    appendRunRef(meta.slug, { run_id: "20260703-191500-efgh", lab: "default", tier: "free", recorded: "t2" });
    const toml = parse(fs.readFileSync(path.join(problemDir(meta.slug), "runs.toml"), "utf8")) as any;
    expect(toml.runs).toHaveLength(2);
    expect(toml.runs[1].tier).toBe("free");
    const json = JSON.parse(fs.readFileSync(path.join(problemDir(meta.slug), "runs.json"), "utf8"));
    expect(json.runs).toHaveLength(2);
    expect(json.runs[0].run_id).toBe("20260703-190412-abcd");
  });
});

describe("writeEntityFiles", () => {
  it("writes entities/<kind>.toml + .json", () => {
    const meta = createProblem("X gate");
    writeEntityFiles(meta.slug, "system", '[system]\nplatform = "transmon"\n', '{"platform":"transmon"}\n');
    const dir = path.join(problemDir(meta.slug), "entities");
    expect(fs.readFileSync(path.join(dir, "system.toml"), "utf8")).toContain("transmon");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "system.json"), "utf8")).platform).toBe("transmon");
  });
});

describe("listProblems", () => {
  it("lists all problems with status", () => {
    createProblem("X gate");
    createProblem("Y gate");
    archiveProblem("y-gate");
    const all = listProblems();
    expect(all.map((p) => p.slug).sort()).toEqual(["x-gate", "y-gate"]);
    expect(all.find((p) => p.slug === "y-gate")?.status).toBe("archived");
  });
});

describe("migrateLegacyEntities (injectable roots — env-skip lives at the call site)", () => {
  function legacyFixture(): string {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-legacy-"));
    fs.writeFileSync(path.join(legacy, "system.toml"), '[system]\nplatform = "transmon"\n');
    fs.writeFileSync(path.join(legacy, "system.json"), '{"platform":"transmon"}');
    fs.writeFileSync(path.join(legacy, "formulation.toml"), '[formulation]\nproblem = "gate_synthesis"\n');
    fs.writeFileSync(path.join(legacy, "score_manifest.json"), '{"manifest":{}}');
    fs.writeFileSync(path.join(legacy, "interview_state.json"), "{}");
    fs.writeFileSync(path.join(legacy, "usage.jsonl"), "{}\n");
    return legacy;
  }

  it("reshapes a flat legacy dir into an archived problem workspace + sets active", () => {
    const legacy = legacyFixture();
    const root = path.join(tmp, "fresh-problems"); // does not exist yet
    migrateLegacyEntities(legacy, root);
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("legacy-"));
    expect(dirs).toHaveLength(1);
    const ws = path.join(root, dirs[0]);
    // entity files reshaped under entities/
    expect(fs.existsSync(path.join(ws, "entities", "system.toml"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "entities", "system.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "entities", "formulation.toml"))).toBe(true);
    // score-state files at the workspace root
    expect(fs.existsSync(path.join(ws, "score_manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "interview_state.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws, "usage.jsonl"))).toBe(true);
    // synthesized archived meta + active set (no other problem) — W2.1: card.* is the card
    const meta = JSON.parse(fs.readFileSync(path.join(ws, "card.json"), "utf8"));
    expect(meta.status).toBe("archived");
    expect(fs.readFileSync(path.join(root, "active"), "utf8").trim()).toBe(dirs[0]);
    fs.rmSync(legacy, { recursive: true, force: true });
  });

  it("no-ops when problemsRoot already exists", () => {
    const legacy = legacyFixture();
    const root = path.join(tmp, "existing-problems");
    fs.mkdirSync(root, { recursive: true });
    migrateLegacyEntities(legacy, root);
    expect(fs.readdirSync(root).filter((d) => d.startsWith("legacy-"))).toHaveLength(0);
    fs.rmSync(legacy, { recursive: true, force: true });
  });

  it("no-ops when legacySrc is absent", () => {
    const root = path.join(tmp, "root-no-legacy");
    migrateLegacyEntities(path.join(tmp, "does-not-exist"), root);
    expect(fs.existsSync(root)).toBe(false);
  });
});

// `amico note` (issue #113, slice B3) — the librarian's deterministic bookkeeping
// half. Pure logic (note.ts: renderExperimentNote / mergeBestGates /
// bumpBestGatesInText) is unit-tested against src; the write / bump-best bodies
// run through `dist/amico.js` with $AMICO_VAULT_DIR pointed at a seeded temp vault.
// Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderExperimentNote,
  experimentId,
  mergeBestGates,
  bumpBestGatesInText,
  parseBestGate,
  routeNote,
  renderRoutedNote,
  routedNoteBasename,
  slugify,
  stampToDate,
  isRoutableType,
  ROUTE_FOLDERS,
  type BestGate,
} from "../src/note.js";
import type { Mount } from "../src/mounts.js";
import { loadNotes } from "../src/vault_query.js";

// ── pure logic (note.ts) ────────────────────────────────────────────────────────
describe("renderExperimentNote + experimentId", () => {
  it("renders full frontmatter with the passed fields (nothing invented)", () => {
    const note = renderExperimentNote({ platform: "fluxonium", gate: "X", fidelity: 0.99986, date: "2026-07-09", duration_us: 0.01, status: "improved" });
    expect(note).toMatch(/^---\ntype: experiment/);
    expect(note).toMatch(/platform: fluxonium/);
    expect(note).toMatch(/gate: X/);
    expect(note).toMatch(/fidelity: 0.99986/);
    expect(note).toMatch(/status: improved/);
    expect(note).toMatch(/tags: \[experiment, fluxonium, gate\/X, status\/improved, task\/experiment\]/);
  });
  it("deterministic id from date+platform+gate (+session prefix)", () => {
    expect(experimentId({ platform: "transmon", gate: "H", fidelity: 0.9, date: "2026-07-09" })).toBe("experiment-20260709-transmon-H");
    expect(experimentId({ platform: "transmon", gate: "H", fidelity: 0.9, date: "2026-07-09", session_id: "abcd1234-xyz" })).toBe("experiment-20260709-transmon-H-abcd1234");
  });
});

describe("mergeBestGates", () => {
  const g = (gate: string, f: number): BestGate => ({ gate, fidelity: f });
  it("adds an absent gate (sorted); bumps only on strictly higher fidelity; no-op otherwise", () => {
    expect(mergeBestGates([g("Y", 0.99)], g("X", 0.9)).gates.map((x) => x.gate)).toEqual(["X", "Y"]);
    const bump = mergeBestGates([g("X", 0.99)], g("X", 0.999));
    expect(bump.bumped).toBe(true);
    expect(bump.previous?.fidelity).toBe(0.99);
    const noop = mergeBestGates([g("X", 0.999)], g("X", 0.9));
    expect(noop.bumped).toBe(false);
  });
});

describe("parseBestGate", () => {
  it("parses an inline table with a quoted wikilink source", () => {
    const g = parseBestGate('{gate: X, fidelity: 0.9995, duration_ns: 10, source: "[[fluxonium-X-v1]]"}');
    expect(g).toMatchObject({ gate: "X", fidelity: 0.9995, duration_ns: 10, source: "[[fluxonium-X-v1]]" });
  });
  it("rejects an entry missing gate or fidelity", () => {
    expect(parseBestGate("{fidelity: 0.9}")).toBeUndefined();
    expect(parseBestGate("{gate: X}")).toBeUndefined();
  });
});

describe("bumpBestGatesInText — surgical frontmatter edit", () => {
  const note = [
    "---",
    "type: system-context",
    "platform: fluxonium",
    "best_gates:",
    '  - {gate: X, fidelity: 0.9995, duration_ns: 10, source: "[[fluxonium-X-v1]]"}',
    '  - {gate: Y, fidelity: 0.999, duration_ns: 30, source: "[[fluxonium-Y-v1]]"}',
    "open_questions:",
    '  - "min gate time?"',
    "tags: [system-context, fluxonium]",
    "---",
    "",
    "# Fluxonium",
    "Body.",
    "",
  ].join("\n");

  it("bumps a gate to higher fidelity, leaving the rest of the note intact", () => {
    const res = bumpBestGatesInText(note, { gate: "X", fidelity: 0.99999, duration_ns: 10, source: "[[exp-new]]" });
    expect(res.ok).toBe(true);
    expect(res.bumped).toBe(true);
    expect(res.text).toMatch(/gate: X, fidelity: 0.99999/);
    expect(res.text).toMatch(/open_questions:/); // untouched
    expect(res.text).toMatch(/# Fluxonium\nBody\./); // body untouched
    expect(res.text).toMatch(/gate: Y, fidelity: 0.999/); // sibling untouched
  });
  it("no-op when the candidate does not beat the incumbent", () => {
    const res = bumpBestGatesInText(note, { gate: "X", fidelity: 0.9 });
    expect(res.bumped).toBe(false);
    expect(res.text).toBe(note);
  });
  it("adds a new gate into an empty `best_gates: []`", () => {
    const empty = ["---", "type: system-context", "platform: rydberg", "best_gates: []", "tags: [x]", "---", "# R", "b", ""].join("\n");
    const res = bumpBestGatesInText(empty, { gate: "CZ", fidelity: 0.999, source: "[[exp-cz]]" });
    expect(res.bumped).toBe(true);
    expect(res.text).toMatch(/best_gates:\n {2}- \{gate: CZ, fidelity: 0.999/);
    expect(res.text).not.toMatch(/best_gates: \[\]/);
  });
  it("errors (never throws) when there is no best_gates key", () => {
    const res = bumpBestGatesInText("---\ntype: system-context\n---\n# x\n", { gate: "X", fidelity: 0.9 });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/best_gates/);
  });
});

// ── routed generic note — pure core (note.ts) ─────────────────────────────────────
describe("routeNote — intent → first writable mount of that kind, else personal fallback", () => {
  const mk = (name: string, kind: string, writable: boolean): Mount => ({ name, kind, path: `/v/${name}`, writable });
  const personal = mk("me", "personal", true);
  const eng = mk("acme", "engagement", true);
  const team = mk("shared", "team", false); // ro

  it("routes to the first writable mount of the intent kind (no route_intent)", () => {
    const d = routeNote([personal, eng, team], "engagement");
    expect(d).toEqual({ mount: eng });
  });
  it("falls back to personal and stamps route_intent when the target kind is read-only", () => {
    const d = routeNote([personal, team], "team");
    expect(d).toEqual({ mount: personal, routeIntent: "team" });
  });
  it("falls back to personal and stamps route_intent when the target kind is absent", () => {
    const d = routeNote([personal], "engagement");
    expect(d).toEqual({ mount: personal, routeIntent: "engagement" });
  });
  it("personal intent routes to the personal mount with no route_intent", () => {
    expect(routeNote([personal, team], "personal")).toEqual({ mount: personal });
  });
  it("errors when there is no writable personal mount to fall back to", () => {
    const d = routeNote([team], "team");
    expect(d).toMatchObject({ error: expect.stringMatching(/personal/) });
  });
});

describe("routed note rendering helpers", () => {
  it("stampToDate slices the stamp's date; slugify kebabs the title", () => {
    expect(stampToDate("20260711-013000")).toBe("2026-07-11");
    expect(slugify("A Great Plan!")).toBe("a-great-plan");
    expect(slugify("!!!")).toBe("note"); // empty slug guard
  });
  it("routedNoteBasename is <type>-<stamp>-<slug>", () => {
    expect(routedNoteBasename("plan", "20260711-013000", "My Big Idea")).toBe("plan-20260711-013000-my-big-idea");
  });
  it("renderRoutedNote emits minimal frontmatter; route_intent only when set", () => {
    const plain = renderRoutedNote({ type: "spec", title: "Title", body: "prose", stamp: "20260711-013000" });
    expect(plain).toMatch(/^---\ntype: spec\ndate: 2026-07-11\nsession_id: null\ntags: \[spec\]\n---/);
    expect(plain).not.toMatch(/route_intent/);
    expect(plain).toMatch(/# Title\n\nprose/);
    const rerouted = renderRoutedNote({ type: "note", title: "T", body: "b", stamp: "20260711-013000", route_intent: "team" });
    expect(rerouted).toMatch(/route_intent: team/);
  });
  it("ROUTE_FOLDERS / isRoutableType map types to folders and exclude experiment", () => {
    expect(ROUTE_FOLDERS).toMatchObject({ spec: "specs", plan: "plans", insight: "insights", method: "methods", note: "notes", hopper: "hopper" });
    expect(isRoutableType("plan")).toBe(true);
    expect(isRoutableType("experiment")).toBe(false);
  });
});

// ── verb bodies through the bundle ──────────────────────────────────────────────
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

let vault: string; // $AMICO_VAULT_DIR
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "amico-note-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("amico note write (bundle)", () => {
  it("writes an experiment note into experiments/ with full frontmatter", () => {
    const r = run(["note", "write", "--platform", "fluxonium", "--kind", "X", "--fidelity", "0.99986", "--duration-us", "0.01", "--status", "improved", "--date", "2026-07-09"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ written: true, id: "experiment-20260709-fluxonium-X" });
    const text = readFileSync(join(vault, "experiments", "experiment-20260709-fluxonium-X.md"), "utf8");
    expect(text).toMatch(/fidelity: 0.99986/);
    expect(text).toMatch(/status: improved/);
  });
  it("--from-run reads result.toml for fidelity/duration", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-note-run-"));
    writeFileSync(join(runDir, "result.toml"), "fidelity = 0.999995\nduration_us = 0.04\n");
    const r = run(["note", "write", "--platform", "transmon", "--kind", "H", "--from-run", runDir, "--date", "2026-07-09"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const text = readFileSync(join(vault, "experiments", "experiment-20260709-transmon-H.md"), "utf8");
    expect(text).toMatch(/fidelity: 0.999995/);
    expect(text).toMatch(/duration_us: 0.04/);
    rmSync(runDir, { recursive: true, force: true });
  });
  it("--dry-run computes without writing", () => {
    const r = run(["note", "write", "--platform", "fluxonium", "--kind", "X", "--fidelity", "0.9", "--date", "2026-07-09", "--dry-run"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).dry_run).toBe(true);
    expect(existsSync(join(vault, "experiments"))).toBe(false);
  });
  it("missing fidelity + no run → 64", () => {
    expect(run(["note", "write", "--platform", "fluxonium", "--kind", "X"], { AMICO_VAULT_DIR: vault }).code).toBe(64);
  });

  // ── SEAM 3 (amicode #714): the shape quartet in the experiment note's metrics
  // block — stamped from a quartet-carrying result.toml, cited (referenced, never
  // re-computed), absent-means-absent on older runs.
  it("--from-run with params.shape_metrics stamps a ## Metrics block citing the source", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-note-quartet-"));
    writeFileSync(
      join(runDir, "result.toml"),
      [
        "fidelity = 0.999995",
        "duration_us = 0.04",
        "",
        "[params]",
        "",
        "[params.shape_metrics]",
        "bend = [0.001, 0.0012]",
        "int_u2 = [0.5, 0.55]",
        "max_du = [0.02, 0.025]",
        "crest = [0.15, 0.16]",
        "T = 10.0",
        'parameterization = "linear"',
        "",
      ].join("\n"),
    );
    const r = run(["note", "write", "--platform", "transmon", "--kind", "X", "--from-run", runDir, "--date", "2026-09-01"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const text = readFileSync(join(vault, "experiments", "experiment-20260901-transmon-X.md"), "utf8");
    expect(text).toMatch(/## Metrics/);
    expect(text).toMatch(/Piccolo\.shape_metrics/); // the note cites the source
    expect(text).toMatch(/params\.shape_metrics/); // …and the payload path
    expect(text).toMatch(/bend: \[0.001, 0.0012\]/);
    expect(text).toMatch(/int_u2: \[0.5, 0.55\]/);
    expect(text).toMatch(/max_du: \[0.02, 0.025\]/);
    expect(text).toMatch(/crest: \[0.15, 0.16\]/);
    expect(text).toMatch(/T: 10/);
    expect(text).toMatch(/parameterization: linear/);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("the librarian read path returns the quartet (the metrics block round-trips through loadNotes → `amico vault query`)", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-note-quartet-rt-"));
    writeFileSync(
      join(runDir, "result.toml"),
      [
        "fidelity = 0.999995",
        "",
        "[params.shape_metrics]",
        "bend = [0.001]",
        "int_u2 = [0.5]",
        "max_du = [0.02]",
        "crest = [0.15]",
        'parameterization = "linear"',
        "",
      ].join("\n"),
    );
    const r = run(["note", "write", "--platform", "transmon", "--kind", "H", "--from-run", runDir, "--date", "2026-09-01"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const recs = loadNotes(vault);
    const exp = recs.find((n) => n.folder === "experiments");
    expect(exp).toBeDefined(); // the note IS in the knowledge graph
    expect(exp!.body).toMatch(/## Metrics/);
    expect(exp!.body).toMatch(/bend: \[0.001\]/);
    expect(exp!.body).toMatch(/Piccolo\.shape_metrics/);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("an older result.toml (no quartet) writes the note cleanly — no Metrics block (absent-means-absent)", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-note-old-"));
    writeFileSync(join(runDir, "result.toml"), "fidelity = 0.999995\nduration_us = 0.04\n");
    const r = run(["note", "write", "--platform", "transmon", "--kind", "Y", "--from-run", runDir, "--date", "2026-09-01"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const text = readFileSync(join(vault, "experiments", "experiment-20260901-transmon-Y.md"), "utf8");
    expect(text).not.toMatch(/## Metrics/);
    rmSync(runDir, { recursive: true, force: true });
  });

  it("a malformed params.shape_metrics degrades to absent — clean note, no half-quartet, no error", () => {
    const runDir = mkdtempSync(join(tmpdir(), "amico-note-badq-"));
    writeFileSync(join(runDir, "result.toml"), 'fidelity = 0.999995\n\n[params]\nshape_metrics = "nope"\n');
    const r = run(["note", "write", "--platform", "transmon", "--kind", "Z", "--from-run", runDir, "--date", "2026-09-01"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const text = readFileSync(join(vault, "experiments", "experiment-20260901-transmon-Z.md"), "utf8");
    expect(text).not.toMatch(/## Metrics/);
    expect(text).toMatch(/fidelity: 0.999995/); // the note itself is intact
    rmSync(runDir, { recursive: true, force: true });
  });
});

describe("amico note bump-best (bundle)", () => {
  function seedContext(): void {
    const dir = join(vault, "qubit-hardware-context");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "fluxonium-half-flux.md"),
      ["---", "type: system-context", "platform: fluxonium", "best_gates:", '  - {gate: X, fidelity: 0.9995, duration_ns: 10, source: "[[fluxonium-X-v1]]"}', "open_questions:", '  - "min gate time?"', "tags: [system-context, fluxonium]", "---", "# Fluxonium", "Body.", ""].join("\n"),
    );
  }
  it("auto-finds the system-context note by platform and bumps best_gates", () => {
    seedContext();
    const r = run(["note", "bump-best", "--platform", "fluxonium", "--kind", "X", "--fidelity", "0.99999", "--duration-ns", "10", "--source", "[[exp-new-X]]"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ bumped: true, written: true });
    const text = readFileSync(join(vault, "qubit-hardware-context", "fluxonium-half-flux.md"), "utf8");
    expect(text).toMatch(/gate: X, fidelity: 0.99999/);
    expect(text).toMatch(/open_questions:/); // preserved
  });
  it("no-op when the candidate does not beat the incumbent (exit 0, written:false)", () => {
    seedContext();
    const r = run(["note", "bump-best", "--platform", "fluxonium", "--kind", "X", "--fidelity", "0.9"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.bumped).toBe(false);
    expect(out.written).toBe(false);
  });
  it("no matching context note → 64", () => {
    const r = run(["note", "bump-best", "--platform", "nonesuch", "--kind", "X", "--fidelity", "0.99"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(64);
  });
});

// ── routed generic writer `note route` (bundle) — NEW subcommand, mount-aware ──────
/** Seed a vault dir under `root` with an `.amico-vault.toml` marker. */
function seedMarker(root: string, name: string, kind: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".amico-vault.toml"), `kind = "${kind}"\nname = "${name}"\n`);
  return dir;
}
/** Fixture env pointing the spawned CLI at a multi-mount root (Task 6 seam). */
function mountEnv(root: string): Record<string, string> {
  return { AMICO_VAULTS_ROOT: root, AMICO_MOUNTS_TOML: join(root, "none.toml"), AMICO_VAULT_DIR: "" };
}
const STAMP = "20260711-013000";

describe("amico note route (bundle)", () => {
  it("routes to the writable mount of the intent kind (no route_intent)", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "me", "personal");
    seedMarker(root, "acme", "engagement");
    const r = run(["note", "route", "--type", "spec", "--intent", "engagement", "--title", "My Spec", "--body", "hello", "--stamp", STAMP], mountEnv(root));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ written: true, type: "spec", intent: "engagement", mount: "acme", route_intent: null });
    const file = join(root, "acme", "specs", `spec-${STAMP}-my-spec.md`);
    expect(out.path).toBe(file);
    const text = readFileSync(file, "utf8");
    expect(text).toMatch(/^---\ntype: spec\ndate: 2026-07-11/);
    expect(text).not.toMatch(/route_intent/);
    rmSync(root, { recursive: true, force: true });
  });

  it("team intent with a read-only team mount → personal fallback + route_intent: team", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "me", "personal");
    seedMarker(root, "shared", "team"); // ro by default
    const r = run(["note", "route", "--type", "note", "--intent", "team", "--title", "Notice", "--body", "b", "--stamp", STAMP], mountEnv(root));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ written: true, mount: "me", route_intent: "team" });
    const text = readFileSync(join(root, "me", "notes", `note-${STAMP}-notice.md`), "utf8");
    expect(text).toMatch(/route_intent: team/);
    rmSync(root, { recursive: true, force: true });
  });

  it("missing personal mount → error JSON, exit 64", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "shared", "team"); // no personal mount to fall back to
    const r = run(["note", "route", "--type", "note", "--title", "x", "--body", "y", "--stamp", STAMP], mountEnv(root));
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatch(/personal/);
    rmSync(root, { recursive: true, force: true });
  });

  it("--type experiment is rejected with a pointer to `note write`", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "me", "personal");
    const r = run(["note", "route", "--type", "experiment", "--title", "x", "--body", "y"], mountEnv(root));
    expect(r.code).toBe(64);
    const out = JSON.parse(r.stdout);
    expect(out.error).toMatch(/experiment/);
    expect(JSON.stringify(out)).toMatch(/note write/);
    rmSync(root, { recursive: true, force: true });
  });

  it("folder + filename follow the explicit type→folder map and <type>-<stamp>-<slug> naming", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "me", "personal");
    const r = run(["note", "route", "--type", "plan", "--title", "Great Plan!", "--body", "b", "--stamp", STAMP], mountEnv(root));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.path).toBe(join(root, "me", "plans", `plan-${STAMP}-great-plan.md`));
    expect(existsSync(out.path)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("--commit stages + commits in a git-repo mount", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    const me = seedMarker(root, "me", "personal");
    execFileSync("git", ["-C", me, "init", "-q"]);
    execFileSync("git", ["-C", me, "config", "user.email", "t@example.com"]);
    execFileSync("git", ["-C", me, "config", "user.name", "Test"]);
    const r = run(["note", "route", "--type", "note", "--title", "Committed", "--body", "b", "--stamp", STAMP, "--commit"], mountEnv(root));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ written: true, commit: { committed: true } });
    const log = execFileSync("git", ["-C", me, "log", "--oneline"], { encoding: "utf8" });
    expect(log).toMatch(new RegExp(`note-${STAMP}-committed`));
    rmSync(root, { recursive: true, force: true });
  });

  it("--commit into a non-repo mount → warning, note still written, exit 0", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-route-"));
    seedMarker(root, "me", "personal"); // not a git repo
    const r = run(["note", "route", "--type", "note", "--title", "NoRepo", "--body", "b", "--stamp", STAMP, "--commit"], mountEnv(root));
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.written).toBe(true);
    expect(out.commit.committed).toBe(false);
    expect(out.commit.warning).toMatch(/git/i);
    rmSync(root, { recursive: true, force: true });
  });
});

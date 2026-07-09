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
  type BestGate,
} from "../src/note.js";

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

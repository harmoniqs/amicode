// `amico vault` (issue #113, slice B3) — knowledge-graph retrieval. Pure ranking
// (vault_query.ts) is unit-tested against src; the query body is exercised
// end-to-end through `dist/amico.js` with $AMICO_VAULT_DIR pointed at a seeded
// temp vault (mirrors catalog_verb.test.ts). Run: `pnpm --filter @amicode/amico-run test`.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNotes, rankNotes } from "../src/vault_query.js";

// ── seed helpers ──────────────────────────────────────────────────────────────
function seedNote(vault: string, folder: string, file: string, frontmatter: string, body: string): void {
  const dir = join(vault, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `---\n${frontmatter}\n---\n\n${body}\n`);
}

let vault: string;
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "amico-vault-"));
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

// ── pure logic (vault_query.ts) ─────────────────────────────────────────────────
describe("loadNotes", () => {
  it("scans insights/ + experiments/; parses type/platform/gate/tags/title; skips non-md", () => {
    seedNote(vault, "insights", "insight-1.md", "type: insight\nplatform: fluxonium\ngate: X\ntags: [insight, fluxonium, gate/X]", "# Warm-start wins\nWarm-starting helps.");
    seedNote(vault, "experiments", "exp-1.md", "type: experiment\nplatform: transmon\ngate: H", "# A transmon run\nbody");
    writeFileSync(join(vault, "insights", "not-md.txt"), "ignored");
    const notes = loadNotes(vault);
    expect(notes).toHaveLength(2);
    const insight = notes.find((n) => n.file === "insight-1.md")!;
    expect(insight.type).toBe("insight");
    expect(insight.platform).toBe("fluxonium");
    expect(insight.gate).toBe("X");
    expect(insight.tags).toEqual(["insight", "fluxonium", "gate/X"]);
    expect(insight.title).toBe("Warm-start wins");
  });
  it("never throws on a missing vault → empty", () => {
    expect(loadNotes(join(vault, "does-not-exist"))).toEqual([]);
  });
  it("falls back to the filename as title when no H1", () => {
    seedNote(vault, "insights", "no-heading.md", "type: insight", "just prose, no heading");
    expect(loadNotes(vault)[0].title).toBe("no-heading");
  });
});

describe("rankNotes relevance", () => {
  it("ranks title hits above tag hits above body hits", () => {
    seedNote(vault, "insights", "a.md", "type: insight\ntags: [insight]", "# fluxonium optimization\nbody about gates"); // title hit = 5
    seedNote(vault, "insights", "b.md", "type: insight\ntags: [insight, fluxonium]", "# unrelated\nbody"); // tag hit = 3
    seedNote(vault, "insights", "c.md", "type: insight\ntags: [insight]", "# unrelated\nfluxonium fluxonium in body"); // 2 body hits = 2
    const hits = rankNotes(loadNotes(vault), "fluxonium");
    expect(hits.map((h) => h.file)).toEqual(["a.md", "b.md", "c.md"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score); // title-weighted > tag-weighted
    expect(hits[1].score).toBeGreaterThan(hits[2].score); // tag-weighted > body-weighted
  });
  it("respects the --type / --platform / --gate filters", () => {
    seedNote(vault, "insights", "i.md", "type: insight\nplatform: fluxonium\ngate: X", "# fluxonium\nx");
    seedNote(vault, "experiments", "e.md", "type: experiment\nplatform: fluxonium\ngate: X", "# fluxonium\nx");
    expect(rankNotes(loadNotes(vault), "fluxonium", { type: "insight" }).map((h) => h.file)).toEqual(["i.md"]);
    expect(rankNotes(loadNotes(vault), "fluxonium", { gate: "Y" })).toEqual([]);
  });
  it("honors limit and drops zero-score notes", () => {
    seedNote(vault, "insights", "hit.md", "type: insight", "# rydberg blockade\ntext");
    seedNote(vault, "insights", "miss.md", "type: insight", "# nothing\ntext");
    const hits = rankNotes(loadNotes(vault), "rydberg", { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toBe("hit.md");
  });
});

// ── verb body through the bundle ──────────────────────────────────────────────
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

describe("amico vault query (bundle)", () => {
  it("ranks notes by relevance, returns count + hits with snippet", () => {
    seedNote(vault, "insights", "warm.md", "type: insight\ntags: [insight, method/warm-start]", "# warm-start beats cold-start\nwarm-starting from the incumbent helps a lot");
    seedNote(vault, "experiments", "cold.md", "type: experiment\ntags: [experiment]", "# a cold run\nunrelated body");
    const r = run(["vault", "query", "--q", "warm-start incumbent"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ verb: "vault", subcommand: "query", query: "warm-start incumbent" });
    expect(out.count).toBeGreaterThanOrEqual(1);
    expect(out.hits[0].file).toBe("warm.md");
    expect(out.hits[0].snippet).toMatch(/warm-start/i);
  });
  it("--type filter narrows to that note type", () => {
    seedNote(vault, "insights", "i.md", "type: insight", "# rydberg\nrydberg text");
    seedNote(vault, "experiments", "e.md", "type: experiment", "# rydberg\nrydberg text");
    const r = run(["vault", "query", "--q", "rydberg", "--type", "experiment"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.count).toBe(1);
    expect(out.hits[0].type).toBe("experiment");
  });
  it("empty vault → count 0, exit 0", () => {
    const r = run(["vault", "query", "--q", "anything"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).count).toBe(0);
  });
  it("missing --q → 64", () => {
    expect(run(["vault", "query"], { AMICO_VAULT_DIR: vault }).code).toBe(64);
  });
  it("unknown subcommand → 64 with usage", () => {
    const r = run(["vault", "frobnicate"], { AMICO_VAULT_DIR: vault });
    expect(r.code).toBe(64);
    expect(JSON.parse(r.stdout).error).toMatch(/unknown subcommand/);
  });
});

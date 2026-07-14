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

// ── mount-aware verbs (Task 7): multi-mount fixtures reach the bundle via the env seam ──
/** Seed a vault dir under `root` with an `.amico-vault.toml` marker. */
function seedMarker(root: string, name: string, markerBody: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".amico-vault.toml"), markerBody);
  return dir;
}

describe("amico vault status (bundle) — field-compatible with amico-vault status --json", () => {
  it("emits {ok, mounts:[{id,path,kind,writable,last_sync,warnings}], error} with drift warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-mstatus-"));
    seedMarker(root, "me", 'kind = "personal"\nname = "me"');
    seedMarker(root, "shared", 'kind = "project"\nname = "shared"'); // marker says project…
    const manifest = join(root, "mounts.toml");
    writeFileSync(manifest, ["[[mount]]", 'id = "shared"', 'kind = "team"', `path = "${join(root, "shared")}"`].join("\n")); // …manifest says team

    const r = run(["vault", "status", "--json"], { AMICO_VAULTS_ROOT: root, AMICO_MOUNTS_TOML: manifest, AMICO_VAULT_DIR: "" });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.error).toBeNull();
    expect(Array.isArray(out.mounts)).toBe(true);

    const shared = out.mounts.find((m: { id: string }) => m.id === "shared");
    expect(shared).toMatchObject({ kind: "team", writable: false });
    expect(shared.warnings.join(" ")).toMatch(/drift.*project.*team/i);
    expect(typeof shared.last_sync).toBe("string"); // "unknown" for a non-git temp dir (tolerated)
    expect(Object.keys(shared).sort()).toEqual(["id", "kind", "last_sync", "path", "warnings", "writable"]);

    const me = out.mounts.find((m: { id: string }) => m.id === "me");
    expect(me).toMatchObject({ kind: "personal", writable: true });
    expect(me.warnings).toEqual([]); // no manifest override ⇒ no drift
    rmSync(root, { recursive: true, force: true });
  });
});

describe("amico vault resolve (bundle) — first-hit across precedence", () => {
  it("resolves to the highest-precedence mount that has the relpath; reports misses otherwise", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-mresolve-"));
    seedMarker(root, "a", 'kind = "personal"\nname = "a"'); // rank 0 — wins collisions
    seedMarker(root, "b", 'kind = "team"\nname = "b"'); // rank 4
    seedNote(join(root, "a"), "insights", "shared.md", "type: insight", "# a copy");
    seedNote(join(root, "b"), "insights", "shared.md", "type: insight", "# b copy");
    seedNote(join(root, "b"), "insights", "bonly.md", "type: insight", "# b only");
    const env = { AMICO_VAULTS_ROOT: root, AMICO_MOUNTS_TOML: join(root, "none.toml"), AMICO_VAULT_DIR: "" };

    const hit = JSON.parse(run(["vault", "resolve", "insights/shared.md"], env).stdout);
    expect(hit).toMatchObject({ found: true, mount: "a", path: join(root, "a", "insights", "shared.md") });

    const hitB = JSON.parse(run(["vault", "resolve", "insights/bonly.md"], env).stdout);
    expect(hitB).toMatchObject({ found: true, mount: "b" });

    const miss = JSON.parse(run(["vault", "resolve", "insights/ghost.md"], env).stdout);
    expect(miss).toMatchObject({ found: false, path: null });
    expect(miss.misses).toEqual([join(root, "a"), join(root, "b")]);
    rmSync(root, { recursive: true, force: true });
  });
  it("missing relpath → 64 (checked before any stack resolution)", () => {
    expect(run(["vault", "resolve"], { AMICO_VAULT_DIR: "" }).code).toBe(64);
  });
});

describe("amico vault query — union over the mount stack (bundle)", () => {
  it("searches all mounts in precedence order; a same-relpath collision is won by the higher-precedence mount", () => {
    const root = mkdtempSync(join(tmpdir(), "amico-mquery-"));
    seedMarker(root, "a", 'kind = "personal"\nname = "a"');
    seedMarker(root, "b", 'kind = "team"\nname = "b"');
    seedNote(join(root, "a"), "insights", "shared.md", "type: insight", "# shared alpha\nkeyword rydberg here");
    seedNote(join(root, "b"), "insights", "shared.md", "type: insight", "# shared beta\nkeyword rydberg here");
    seedNote(join(root, "b"), "insights", "bonly.md", "type: insight", "# b only\nkeyword rydberg here");
    const env = { AMICO_VAULTS_ROOT: root, AMICO_MOUNTS_TOML: join(root, "none.toml"), AMICO_VAULT_DIR: "" };

    const out = JSON.parse(run(["vault", "query", "--q", "rydberg"], env).stdout);
    expect(out.count).toBe(2); // a/shared (b/shared shadowed) + b/bonly
    expect(out.mounts).toEqual(["a", "b"]);
    const shared = out.hits.find((h: { file: string }) => h.file === "shared.md");
    expect(shared.mount).toBe("a"); // personal (rank 0) wins the collision
    expect(shared.title).toBe("shared alpha");
    expect(out.hits.find((h: { file: string }) => h.file === "bonly.md").mount).toBe("b");

    // --mount restricts to a single mount
    const restricted = JSON.parse(run(["vault", "query", "--q", "rydberg", "--mount", "b"], env).stdout);
    expect(restricted.count).toBe(2); // b/shared + b/bonly
    expect(restricted.hits.every((h: { mount: string }) => h.mount === "b")).toBe(true);
    expect(restricted.hits.find((h: { file: string }) => h.file === "shared.md").title).toBe("shared beta");
    rmSync(root, { recursive: true, force: true });
  });
  it("$AMICO_VAULT_DIR forces a single mount and wins over $AMICO_VAULTS_ROOT (back-compat)", () => {
    const single = mkdtempSync(join(tmpdir(), "amico-single-"));
    const multi = mkdtempSync(join(tmpdir(), "amico-multi-"));
    seedNote(single, "insights", "only.md", "type: insight", "# only\nkeyword photon");
    seedMarker(multi, "x", 'kind = "personal"\nname = "x"');
    seedNote(join(multi, "x"), "insights", "other.md", "type: insight", "# other\nkeyword photon");

    const out = JSON.parse(
      run(["vault", "query", "--q", "photon"], { AMICO_VAULT_DIR: single, AMICO_VAULTS_ROOT: multi, AMICO_MOUNTS_TOML: join(multi, "none.toml") }).stdout,
    );
    expect(out.count).toBe(1);
    expect(out.hits[0].file).toBe("only.md");
    expect(out.vault).toBe(single); // the forced single mount root
    rmSync(single, { recursive: true, force: true });
    rmSync(multi, { recursive: true, force: true });
  });
});

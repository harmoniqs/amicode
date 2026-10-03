// `amico claims` (amicode #1681, brain flywheel slice 2 + #1682 slice 3): the
// claims registry's CLI surface — `project` (memory card → claim, dry-run by
// default), `lint` (contract + evidence-pointer resolution), and `render`
// (the hot-layer memory index as a GENERATED view of the registry, ranked by
// recency + adoption + confidence, #1682). Hermetic: fixture registries/vaults
// in temp dirs, and a fake personal mount (the .amico-vault.toml marker) for
// default-resolution checks — never the live vault.
// Run: `pnpm --filter @amicode/amico-run test claims`
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { claimsVerb } from "../src/claims_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { readDistillState } from "../src/distill.js";
import { INDEX_MAX_LINES } from "../src/claims.js";
import { loadPluginIndexReader, pluginMemoryIndexCap } from "./helpers.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures", "claims");
const CARD_FILE = join(FIXTURES, "vault", "amicode", "memory", "project_two_qubit_challenge.md");

/** A fake vault root with one personal mount (the marker convention) — the
 *  hermetic stand-in for resolveMountStack's default resolution. */
function fakeVaultRoot(): { root: string; mount: string } {
  const root = mkdtempSync(join(tmpdir(), "claims-vault-"));
  const mount = join(root, "vault-aaron");
  mkdirSync(join(mount, "amicode", "memory"), { recursive: true });
  mkdirSync(join(mount, "amicode", "claims"), { recursive: true });
  writeFileSync(join(mount, ".amico-vault.toml"), 'kind = "personal"\nname = "vault-aaron"\n');
  return { root, mount };
}

describe("amico claims project — the memory-card projection verb", () => {
  it("usage: no subcommand / unknown subcommand → usage error, exit 64", async () => {
    expect((await claimsVerb([], {})).code).toBe(64);
    expect((await claimsVerb(["frobnicate"], {})).code).toBe(64);
    expect(((await claimsVerb([], {})).json as { usage: string }).usage).toContain("amico claims");
  });

  it("dry-run by default: renders + validates, writes NOTHING", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const r = await claimsVerb(["project", CARD_FILE, "--out", out], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.type).toBe("insight");
    expect(j.statement).toContain("Two-qubit gates");
    expect(j.valid).toBe(true); // the in-process schema gate ran before reporting
    expect(existsSync(join(out, "project_two_qubit_challenge.md"))).toBe(false);
  });

  it("--apply writes the claim note, idempotently (same card + same clock → same path, same bytes)", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const noon = () => new Date("2026-10-02T12:00:00.000Z");
    const first = await claimsVerb(["project", CARD_FILE, "--out", out, "--apply"], {}, { now: noon });
    expect(first.code).toBe(0);
    const file = join(out, "project_two_qubit_challenge.md");
    const bytes = readFileSync(file, "utf8");
    expect(bytes).toContain("type: insight");
    expect(bytes).toContain("memory-card/project_two_qubit_challenge.md");
    // second run with the same clock: same path, same bytes — no duplicate
    await claimsVerb(["project", CARD_FILE, "--out", out, "--apply"], {}, { now: noon });
    expect(readFileSync(file, "utf8")).toBe(bytes);
  });

  it("--type overrides the mechanical map; a bad type is a usage error", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const r = await claimsVerb(["project", CARD_FILE, "--out", out, "--type", "hazard", "--apply"], {});
    expect(r.code).toBe(0);
    expect(readFileSync(join(out, "project_two_qubit_challenge.md"), "utf8")).toContain("type: hazard");
    const bad = await claimsVerb(["project", CARD_FILE, "--out", out, "--type", "rant"], {});
    expect(bad.code).toBe(64);
  });

  it("refuses an unknown card type and a missing card, writing nothing", async () => {
    const out = mkdtempSync(join(tmpdir(), "claims-out-"));
    const scratch = mkdtempSync(join(tmpdir(), "claims-card-"));
    const badCard = join(scratch, "bad.md");
    writeFileSync(badCard, "---\nname: x\ndescription: y\ntype: rant\n---\n\nbody\n");
    const r = await claimsVerb(["project", badCard, "--out", out, "--apply"], {});
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("unknown memory-card type");
    expect(existsSync(join(out, "bad.md"))).toBe(false);

    const missing = await claimsVerb(["project", join(scratch, "nope.md"), "--out", out], {});
    expect(missing.code).toBe(64);
  });

  it("no personal mount and no --out → refuses to guess a vault (the distill doctrine)", async () => {
    const bare = mkdtempSync(join(tmpdir(), "claims-bare-")); // no mounts resolve
    const r = await claimsVerb(["project", CARD_FILE], { AMICO_VAULTS_ROOT: bare });
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("--out");
  });

  it("defaults --out to the personal mount's amicode/claims/ subtree", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), readFileSync(CARD_FILE, "utf8"));
    const r = await claimsVerb(["project", join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), "--apply"], {
      AMICO_VAULTS_ROOT: root,
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(mount, "amicode", "claims", "project_two_qubit_challenge.md"))).toBe(true);
  });
});

describe("amico claims lint — the registry gate verb", () => {
  it("a clean fixture registry lints clean: exit 0", async () => {
    const r = await claimsVerb(["lint", "--registry", join(FIXTURES, "registry"), "--vault", join(FIXTURES, "vault")], {});
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.clean).toBe(true);
    expect(j.files).toBe(1);
  });

  it("a dirty registry exits 1 with the findings, field-precise", async () => {
    const reg = mkdtempSync(join(tmpdir(), "claims-reg-"));
    writeFileSync(
      join(reg, "unknown-type.md"),
      "---\ntype: feedback\nstatement: an unprojected card\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory: []\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    const r = await claimsVerb(["lint", "--registry", reg, "--vault", join(FIXTURES, "vault")], {});
    expect(r.code).toBe(1);
    const j = r.json as Record<string, unknown>;
    expect(j.clean).toBe(false);
    expect((j.findings as string[]).some((f) => f.includes("unknown-type.md") && f.includes("/type"))).toBe(true);
  });

  it("defaults --registry and --vault to the personal mount (hermetic fake vault)", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "claims", "a.md"), readFileSync(join(FIXTURES, "registry", "project_two_qubit_challenge.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "memory", "project_two_qubit_challenge.md"), readFileSync(CARD_FILE, "utf8"));
    const r = await claimsVerb(["lint"], { AMICO_VAULTS_ROOT: root });
    expect(r.code).toBe(0);
    expect((r.json as Record<string, unknown>).files).toBe(1);

    // no personal mount at all → refuse to guess, exit 64
    const bare = mkdtempSync(join(tmpdir(), "claims-bare-"));
    const none = await claimsVerb(["lint"], { AMICO_VAULTS_ROOT: bare });
    expect(none.code).toBe(64);
  });

  it("is registered as a spine verb (CLI dispatch + MCP facade, one impl)", () => {
    const claims = SPINE_VERBS.find((v) => v.name === "claims");
    expect(claims, "the claims verb is registered").toBeDefined();
    expect(claims!.summary).toContain("lint");
    expect(claims!.summary).toContain("render");
  });
});

// ── amico claims render — the hot-layer index verb (amicode #1682, slice 3:
// MEMORY.md becomes a generated view of the claims registry) ──────────────────

describe("amico claims render — the hot-layer index verb (#1682)", () => {
  const NOON = () => new Date("2026-10-02T12:00:00.000Z");
  const RENDER_REGISTRY = join(FIXTURES, "render-registry");

  /** A one-claim registry in a temp dir — the minimal live set. */
  function registryWithOneClaim(): string {
    const dir = mkdtempSync(join(tmpdir(), "claims-render-"));
    writeFileSync(
      join(dir, "only.md"),
      "---\ntype: insight\nstatement: the only claim\nstatus: unverified\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-09-01T00:00:00.000Z\n    event: created\n    note: f\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    return dir;
  }

  it("usage errors: unknown flag → 64; missing registry → 64; no mount and no --registry/--out → refuses to guess", async () => {
    const bad = await claimsVerb(["render", "--bogus"], {});
    expect(bad.code).toBe(64);

    const missing = await claimsVerb(["render", "--registry", join(tmpdir(), "definitely-absent-registry")], {});
    expect(missing.code).toBe(64);
    expect((missing.json as { error: string }).error).toContain("claims registry not found");

    const bare = mkdtempSync(join(tmpdir(), "claims-bare-")); // no mount resolves
    const noMount = await claimsVerb(["render"], { AMICO_VAULTS_ROOT: bare });
    expect(noMount.code).toBe(64);
    expect((noMount.json as { error: string }).error).toContain("--registry");

    const noOut = await claimsVerb(["render", "--registry", registryWithOneClaim()], { AMICO_VAULTS_ROOT: bare });
    expect(noOut.code).toBe(64);
    expect((noOut.json as { error: string }).error).toContain("--out");
  });

  it("refuses to overwrite the index with an EMPTY view: zero live claims → 64, naming the dead ones", async () => {
    const empty = mkdtempSync(join(tmpdir(), "claims-empty-"));
    const r = await claimsVerb(["render", "--registry", empty, "--out", join(empty, "MEMORY.md")], {});
    expect(r.code).toBe(64);
    expect((r.json as { error: string }).error).toContain("no live claims");

    const allDead = mkdtempSync(join(tmpdir(), "claims-dead-"));
    writeFileSync(
      join(allDead, "dead.md"),
      "---\ntype: insight\nstatement: dead\nstatus: refuted\nconfidence: medium\nevidence: []\napplied: 0\nlast_applied: null\nhistory:\n  - date: 2026-09-01T00:00:00.000Z\n    event: refuted\n    note: f\nscope: personal\ntags: []\n---\n\nbody\n",
    );
    const dead = await claimsVerb(["render", "--registry", allDead, "--out", join(allDead, "MEMORY.md")], {});
    expect(dead.code).toBe(64);
    expect((dead.json as { error: string }).error).toContain("refuted");
  });

  it("dry-run by default: renders + reports, writes NOTHING", async () => {
    const { root, mount } = fakeVaultRoot();
    const r = await claimsVerb(["render", "--registry", RENDER_REGISTRY], { AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    const j = r.json as Record<string, unknown>;
    expect(j.dry_run).toBe(true);
    expect(j.bullets).toBe(3); // 5 fixture claims − 1 refuted − 1 superseded
    expect(existsSync(join(mount, "amicode", "memory", "MEMORY.md"))).toBe(false);
    // the full rendered view rides the json — the caller can inspect before applying
    expect((j.rendered as string).startsWith("<!--\ngenerated view")).toBe(true);
  });

  it("--apply writes the index at the default out (<mount>/amicode/memory/MEMORY.md); --cap-per-type caps domains", async () => {
    const { root, mount } = fakeVaultRoot();
    writeFileSync(join(mount, "amicode", "claims", "a.md"), readFileSync(join(RENDER_REGISTRY, "best_practice_warm_start.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "claims", "b.md"), readFileSync(join(RENDER_REGISTRY, "insight_recent_unverified.md"), "utf8"));
    writeFileSync(join(mount, "amicode", "claims", "c.md"), readFileSync(join(RENDER_REGISTRY, "insight_two_qubit_challenge.md"), "utf8"));

    // default registry (the mount's amicode/claims) + default out
    const r = await claimsVerb(["render", "--apply"], { AMICO_VAULTS_ROOT: root }, { now: NOON });
    expect(r.code).toBe(0);
    const file = join(mount, "amicode", "memory", "MEMORY.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("- ")).length).toBe(3);

    // per-domain cap 1: 2 insight claims → 1 insight bullet + the best-practice
    const capped = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", join(mount, "amicode", "memory", "MEMORY.md"), "--apply", "--cap-per-type", "1"], {}, { now: NOON });
    expect(capped.code).toBe(0);
    const bullets = readFileSync(join(mount, "amicode", "memory", "MEMORY.md"), "utf8").split("\n").filter((l) => l.startsWith("- "));
    expect(bullets.length).toBe(2);
    expect(bullets.some((b) => b.includes("../claims/best_practice_warm_start.md"))).toBe(true);

    const badCap = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--cap-per-type", "0"], {});
    expect(badCap.code).toBe(64);
  });

  it("idempotent + regenerate-away: apply → HAND-EDIT → re-apply (same clock) → byte-identical to the first render", async () => {
    const { root, mount } = fakeVaultRoot();
    const out = join(mount, "amicode", "memory", "MEMORY.md");
    const first = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(first.code).toBe(0);
    const bytes = readFileSync(out, "utf8");

    // the hand-edit the doctrine discards
    writeFileSync(out, bytes + "- [hand-added](../claims/nope.md) — a hand edit that must not survive\n");

    const second = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(second.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(bytes);
    expect((second.json as Record<string, unknown>).bullets).toBe((first.json as Record<string, unknown>).bullets);
  });

  it("the REAL plugin reader (byte-extracted from the extension's stack_state.ts) parses the generated output unchanged", async () => {
    const { root, mount } = fakeVaultRoot();
    const out = join(mount, "amicode", "memory", "MEMORY.md");
    const r = await claimsVerb(["render", "--registry", RENDER_REGISTRY, "--out", out, "--apply"], {}, { now: NOON });
    expect(r.code).toBe(0);

    // the actual readIndexLines from the plugin source, over the actual file
    const read = loadPluginIndexReader();
    const bullets = read(mount, join("memory", "MEMORY.md"), 50);
    const expected = readFileSync(out, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "));
    expect(bullets).toEqual(expected); // every bullet survives the reader, order preserved
    expect(bullets.length).toBe(3);

    // and the plugin's call-site cap IS the renderer's hard cap (never emit
    // what the reader truncates)
    expect(pluginMemoryIndexCap()).toBe(INDEX_MAX_LINES);
  });
});

// readDistillState re-export sanity: the distill seam stays importable beside
// the claims seam (one substrate, one CLI).
it("the distill state seam remains untouched by this slice", () => {
  expect(readDistillState(join(tmpdir(), "definitely-absent-state.json")).entries).toEqual({});
});

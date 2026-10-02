// `amico claims` (amicode #1681, brain flywheel slice 2): the claims registry's
// CLI surface — `project` (memory card → claim, dry-run by default) and `lint`
// (the registry's gate: unknown types, unresolved evidence pointers, missing
// required fields). Hermetic: fixture registries/vaults in temp dirs, and a
// fake personal mount (the .amico-vault.toml marker) for default-resolution
// checks — never the live vault.
// Run: `pnpm --filter @amicode/amico-run test claims`
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { claimsVerb } from "../src/claims_verb.js";
import { SPINE_VERBS } from "../src/verbs.js";
import { readDistillState } from "../src/distill.js";

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
  });
});

// readDistillState re-export sanity: the distill seam stays importable beside
// the claims seam (one substrate, one CLI).
it("the distill state seam remains untouched by this slice", () => {
  expect(readDistillState(join(tmpdir(), "definitely-absent-state.json")).entries).toEqual({});
});

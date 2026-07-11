// `mounts.ts` — the Armonia mount-stack resolver (Slice B, plan Task 6;
// spec-20260703-053956 vault-CLI canonical order). Pure logic, so it is unit-tested
// directly against src (no bundle): fixture tmp-dir vault trees exercise discovery,
// precedence, the manifest override/rescue, and the env seam. The parity oracle is
// the amico-plugin session-start hook (branch feat/amico-vault-mounts-toml, PR #27).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMountStack, personalMount } from "../src/mounts.js";

// ── fixture helpers ─────────────────────────────────────────────────────────────
let root: string; // a fresh vaults-root per test
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amico-mounts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Seed a vault dir with an `.amico-vault.toml` marker. `marker === null` seeds a
 *  bare dir (no marker); otherwise `marker` is the marker's TOML body. */
function seedVault(dirName: string, marker: string | null): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  if (marker !== null) writeFileSync(join(dir, ".amico-vault.toml"), marker);
}

/** Write a `mounts.toml` manifest under a temp path and return it. */
function seedManifest(body: string): string {
  const path = join(root, "mounts.toml");
  writeFileSync(path, body);
  return path;
}

const NO_MANIFEST = () => join(root, "no-such-mounts.toml");

// ── (a) 6-kind ordering (no manifest → kind-rank-then-name) ─────────────────────
describe("resolveMountStack — kind-rank ordering (no manifest)", () => {
  it("orders personal<engagement<project<restricted<team<public regardless of dir name", () => {
    // Dir names are chosen so alphabetical order fights kind-rank order.
    seedVault("z-personal", 'kind = "personal"');
    seedVault("y-engagement", 'kind = "engagement"');
    seedVault("x-project", 'kind = "project"');
    seedVault("w-restricted", 'kind = "restricted"');
    seedVault("v-team", 'kind = "team"');
    seedVault("u-public", 'kind = "public"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.kind)).toEqual([
      "personal",
      "engagement",
      "project",
      "restricted",
      "team",
      "public",
    ]);
    // restricted (3) sorts strictly before team (4) — the spec correction vs the Ombra draft.
    const kinds = stack.mounts.map((m) => m.kind);
    expect(kinds.indexOf("restricted")).toBeLessThan(kinds.indexOf("team"));
  });
  it("breaks kind ties by name (ascending)", () => {
    seedVault("b-personal", 'kind = "personal"');
    seedVault("a-personal", 'kind = "personal"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.name)).toEqual(["a-personal", "b-personal"]);
  });
});

// ── (b) missing marker → skipped + warned ───────────────────────────────────────
describe("resolveMountStack — missing marker", () => {
  it("drops a dir with no .amico-vault.toml and warns, keeping the valid ones", () => {
    seedVault("good", 'kind = "personal"');
    seedVault("bare", null);
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.name)).toEqual(["good"]);
    expect(stack.warnings.join("\n")).toMatch(/bare/);
    expect(stack.warnings.join("\n")).toMatch(/marker/i);
  });
});

// ── (c) marker missing kind AND no manifest entry → skipped + warned ────────────
describe("resolveMountStack — missing kind, no rescue", () => {
  it("skips a marker with no kind when no manifest entry supplies one", () => {
    seedVault("orphan", 'name = "orphan"');
    seedVault("ok", 'kind = "personal"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.name)).toEqual(["ok"]);
    expect(stack.warnings.join("\n")).toMatch(/orphan/);
    expect(stack.warnings.join("\n")).toMatch(/kind/i);
  });
});

// ── (c′) marker missing kind WITH manifest entry → RESCUED with manifest kind ────
describe("resolveMountStack — rescue via manifest kind (oracle rule)", () => {
  it("rescues a kind-less marker using the manifest kind (override before skip)", () => {
    seedVault("rescued", 'name = "rescued"'); // no kind in the marker
    const manifest = seedManifest(
      ['[[mount]]', 'id = "rescued"', 'kind = "team"', `path = "${join(root, "rescued")}"`].join("\n"),
    );
    const stack = resolveMountStack(root, manifest);
    expect(stack.mounts).toHaveLength(1);
    expect(stack.mounts[0]).toMatchObject({ name: "rescued", kind: "team", writable: false });
  });
});

// ── (d) duplicate name → second skipped ─────────────────────────────────────────
describe("resolveMountStack — duplicate id", () => {
  it("keeps the first, skips the second, and warns", () => {
    seedVault("d1", 'kind = "personal"\nname = "dup"');
    seedVault("d2", 'kind = "personal"\nname = "dup"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.path)).toEqual([join(root, "d1")]);
    expect(stack.warnings.join("\n")).toMatch(/duplicate/i);
  });
});

// ── (e) name defaults to basename ───────────────────────────────────────────────
describe("resolveMountStack — name default", () => {
  it("uses the directory basename when the marker omits name", () => {
    seedVault("my-basename", 'kind = "project"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts[0].name).toBe("my-basename");
  });
});

// ── (f) manifest order + kind/writable override + unlisted appended (discovery order) ──
describe("resolveMountStack — manifest ordering & overrides", () => {
  it("orders by manifest, overrides kind/writable, appends unlisted in discovery order", () => {
    seedVault("aaa", 'kind = "personal"');
    seedVault("bbb", 'kind = "project"'); // unlisted in the manifest
    seedVault("ccc", 'kind = "team"');
    const manifest = seedManifest(
      [
        "[[mount]]",
        'id = "ccc"',
        'kind = "engagement"', // override team → engagement
        `path = "${join(root, "ccc")}"`,
        "writable = true", // override ro → rw
        "",
        "[[mount]]",
        'id = "aaa"',
        `path = "${join(root, "aaa")}"`,
      ].join("\n"),
    );
    const stack = resolveMountStack(root, manifest);
    // manifest order [ccc, aaa]; then unlisted bbb in discovery order.
    expect(stack.mounts.map((m) => m.name)).toEqual(["ccc", "aaa", "bbb"]);
    const ccc = stack.mounts.find((m) => m.name === "ccc")!;
    expect(ccc.kind).toBe("engagement");
    expect(ccc.writable).toBe(true);
  });
});

// ── (g) writability defaults by kind ────────────────────────────────────────────
describe("resolveMountStack — default writability by kind", () => {
  it("personal/engagement/project are rw; restricted/team/public are ro", () => {
    seedVault("p", 'kind = "personal"');
    seedVault("e", 'kind = "engagement"');
    seedVault("j", 'kind = "project"');
    seedVault("r", 'kind = "restricted"');
    seedVault("t", 'kind = "team"');
    seedVault("b", 'kind = "public"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    const w = Object.fromEntries(stack.mounts.map((m) => [m.kind, m.writable]));
    expect(w).toEqual({
      personal: true,
      engagement: true,
      project: true,
      restricted: false,
      team: false,
      public: false,
    });
  });
});

// ── (h) missing vaults root → empty stack, no throw ─────────────────────────────
describe("resolveMountStack — missing root", () => {
  it("returns an empty stack (never throws) when the vaults root is absent", () => {
    const stack = resolveMountStack(join(root, "does-not-exist"), NO_MANIFEST());
    expect(stack.mounts).toEqual([]);
    expect(stack.warnings).toEqual([]);
  });
});

// ── tolerance: corrupt marker / manifest are non-fatal (house rule) ─────────────
describe("resolveMountStack — tolerates corrupt TOML", () => {
  it("skips a corrupt marker with a warning and keeps resolving the rest", () => {
    seedVault("broken", "kind = = bad toml");
    seedVault("fine", 'kind = "personal"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.name)).toEqual(["fine"]);
    expect(stack.warnings.length).toBeGreaterThan(0);
  });
  it("ignores a corrupt manifest (falls back to kind-rank) with a warning", () => {
    seedVault("solo", 'kind = "personal"');
    const manifest = seedManifest("[[mount]\n oops not toml =");
    const stack = resolveMountStack(root, manifest);
    expect(stack.mounts.map((m) => m.name)).toEqual(["solo"]);
    expect(stack.warnings.join("\n")).toMatch(/manifest|mounts\.toml/i);
  });
});

// ── (i) env seam: $AMICO_VAULTS_ROOT / $AMICO_MOUNTS_TOML defaults ───────────────
describe("resolveMountStack — env seam", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it("reads $AMICO_VAULTS_ROOT / $AMICO_MOUNTS_TOML when no params are passed", () => {
    seedVault("envvault", 'kind = "personal"');
    delete process.env.AMICO_VAULT_DIR;
    process.env.AMICO_VAULTS_ROOT = root;
    process.env.AMICO_MOUNTS_TOML = NO_MANIFEST();
    const stack = resolveMountStack();
    expect(stack.mounts.map((m) => m.name)).toEqual(["envvault"]);
  });
  it("$AMICO_VAULT_DIR forces a single personal mount and wins over $AMICO_VAULTS_ROOT", () => {
    seedVault("ignored", 'kind = "team"');
    const forced = mkdtempSync(join(tmpdir(), "amico-forced-"));
    process.env.AMICO_VAULT_DIR = forced;
    process.env.AMICO_VAULTS_ROOT = root; // must be ignored
    const stack = resolveMountStack();
    expect(stack.mounts).toHaveLength(1);
    expect(stack.mounts[0]).toMatchObject({ path: forced, kind: "personal", writable: true });
    rmSync(forced, { recursive: true, force: true });
  });
  it("explicit params win over $AMICO_VAULT_DIR", () => {
    seedVault("explicit", 'kind = "project"');
    process.env.AMICO_VAULT_DIR = "/some/forced/dir";
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(stack.mounts.map((m) => m.name)).toEqual(["explicit"]);
  });
});

// ── personalMount ───────────────────────────────────────────────────────────────
describe("personalMount", () => {
  it("returns the first personal mount, else undefined", () => {
    seedVault("team-one", 'kind = "team"');
    seedVault("me", 'kind = "personal"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(personalMount(stack)?.name).toBe("me");
  });
  it("undefined when there is no personal mount", () => {
    seedVault("team-only", 'kind = "team"');
    const stack = resolveMountStack(root, NO_MANIFEST());
    expect(personalMount(stack)).toBeUndefined();
  });
});

// `amico skills check` (amicode#996) — the SKILL.md validation verb: the
// shared `skill` schema plus the structural rules no JSON schema can express
// (folder name = frontmatter name, duplicate names within one root), over one
// or more skill roots, defaulting to the three fleet surfaces with the
// freshness script's honest-degradation posture (an absent root is skipped,
// never a crash). Read-only by construction: pure filesystem + registry.
// Run: pnpm --filter @amicode/amico-run test skills_verb
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsVerb } from "../src/skills_verb.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skills-verb-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a skill dir; frontmatter lines verbatim, empty string = none. */
function skill(name: string, fm: string, body = "Body prose.\n"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, fm === "" ? `# ${name}\n\n${body}` : `---\n${fm}---\n\n${body}`);
  return path;
}

const check = (args: string[]) => {
  const r = skillsVerb(args);
  return { code: r.code, json: r.json as Record<string, unknown> };
};
const rootsOf = (json: Record<string, unknown>) => json.roots as Array<Record<string, unknown>>;

describe("amico skills check --roots", () => {
  it("reports a valid skill clean: scanned/valid counts, exit 0", () => {
    skill("atoms", "name: atoms\ndescription: Rydberg physics reference.\nsurface: public\n");
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ verb: "skills", subcommand: "check", ok: true });
    expect(rootsOf(json)[0]).toMatchObject({
      root,
      status: "ok",
      scanned: 1,
      valid: 1,
      invalid: 0,
    });
  });

  it("an invalid skill fails the check with reasons: exit 1, per-root invalid details", () => {
    skill("atoms", "name: atoms\ndescription: Rydberg physics reference.\nsurface: public\n");
    skill("bad-skill", "name: other-name\ndescription: x\nsurface: public\n");
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(1);
    expect(json).toMatchObject({ ok: false, scanned: 2, valid: 1, invalid: 1 });
    const bad = rootsOf(json)[0].invalid_details as Array<Record<string, unknown>>;
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ skill: "bad-skill", path: join(root, "bad-skill", "SKILL.md") });
    expect((bad[0].reasons as string[]).some((r) => r.includes('does not equal the folder name "bad-skill"'))).toBe(true);
  });

  it("a schema violation surfaces with its field-precise reason (surface outside the enum)", () => {
    skill("skew", "name: skew\ndescription: x\nsurface: sideways\n");
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(1);
    const bad = rootsOf(json)[0].invalid_details as Array<Record<string, unknown>>;
    expect((bad[0].reasons as string[]).some((r) => r.includes("schema: /surface") && r.includes("public, entitled, internal"))).toBe(true);
  });

  it("malformed frontmatter is a named reason, never a crash", () => {
    skill("broken", "name: broken\ndescription: [unclosed\n");
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(1);
    const bad = rootsOf(json)[0].invalid_details as Array<Record<string, unknown>>;
    expect((bad[0].reasons as string[]).some((r) => r.includes("frontmatter"))).toBe(true);
  });

  it("duplicate skill names within one root are errors (two folders claiming one identity)", () => {
    skill("alpha", "name: shared\ndescription: first\nsurface: public\n");
    skill("beta", "name: shared\ndescription: second\nsurface: public\n");
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(1);
    const bad = rootsOf(json)[0].invalid_details as Array<Record<string, unknown>>;
    expect(bad).toHaveLength(2); // both copies are named — folder-name mismatches too
    expect((bad[1].reasons as string[]).some((r) => r.includes('duplicate skill name "shared"'))).toBe(true);
  });

  it("multiple --roots are all scanned (variadic flag), each reported separately", () => {
    const other = join(root, "other");
    skill("alpha", "name: alpha\ndescription: x\n");
    mkdirSync(other);
    const betaPath = join(other, "beta", "SKILL.md");
    mkdirSync(join(other, "beta"));
    writeFileSync(betaPath, "---\nname: beta\ndescription: y\n---\n");
    const { code, json } = check(["check", "--roots", root, other]);
    expect(code).toBe(0);
    const roots = rootsOf(json);
    expect(roots).toHaveLength(2);
    expect(roots[0]).toMatchObject({ root, scanned: 1, valid: 1 });
    expect(roots[1]).toMatchObject({ root: other, scanned: 1, valid: 1 });
  });

  it("the verb router: unknown/absent subcommand → usage error, exit 64", () => {
    for (const args of [[], ["frobnicate"]]) {
      const { code, json } = check(args);
      expect(code).toBe(64);
      expect(json).toMatchObject({ verb: "skills", error: expect.stringContaining("unknown subcommand") });
      expect((json.usage as string)).toContain("skills check");
    }
  });

  it("a dir with no SKILL.md is not a skill (loader discovery parity) — scanned counts only real skills", () => {
    skill("atoms", "name: atoms\ndescription: x\n");
    mkdirSync(join(root, "not-a-skill")); // no SKILL.md
    const { code, json } = check(["check", "--roots", root]);
    expect(code).toBe(0);
    expect(rootsOf(json)[0]).toMatchObject({ scanned: 1, valid: 1, invalid: 0 });
  });
});

describe("amico skills check — the default fleet surfaces (no --roots)", () => {
  // Hermetic discipline (the profile verb's): the no-arg defaults read the REAL
  // fleet surfaces — the repo checkout, the armonissima vault mount, the server
  // staging tree — so every test here points all three env seams at fixture
  // paths under the temp root.
  let repo: string;
  let vault: string;
  let staging: string;
  beforeEach(() => {
    repo = join(root, "repo");
    vault = join(root, "vault");
    staging = join(root, "staging");
    process.env.AMICO_SKILLS_REPO = repo;
    process.env.AMICO_SKILLS_VAULT = vault;
    process.env.AMICO_SKILLS_STAGING = staging;
  });
  afterEach(() => {
    delete process.env.AMICO_SKILLS_REPO;
    delete process.env.AMICO_SKILLS_VAULT;
    delete process.env.AMICO_SKILLS_STAGING;
  });

  it("validates the three default roots — repo library, armonissima vault, server staging — with per-root labels", () => {
    for (const [base, name] of [[repo, "r1"], [vault, "v1"], [staging, "s1"]] as const) {
      mkdirSync(join(base, name), { recursive: true });
      writeFileSync(join(base, name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\n`);
    }
    const { code, json } = check(["check"]);
    expect(code).toBe(0);
    const roots = rootsOf(json);
    expect(roots.map((r) => r.label)).toEqual(["public", "internal", "staging"]);
    expect(roots[0]).toMatchObject({ root: repo, status: "ok", scanned: 1, valid: 1 });
    expect(roots[1]).toMatchObject({ root: vault, status: "ok", scanned: 1 });
    expect(roots[2]).toMatchObject({ root: staging, status: "ok", scanned: 1 });
    expect(json).toMatchObject({ ok: true, scanned: 3, valid: 3, invalid: 0 });
  });

  it("absent roots are reported as skipped, never a crash — and a clean present root still exits 0 (honest degradation)", () => {
    mkdirSync(join(repo, "r1"), { recursive: true });
    writeFileSync(join(repo, "r1", "SKILL.md"), "---\nname: r1\ndescription: x\n---\n");
    // vault + staging dirs stay absent
    const { code, json } = check(["check"]);
    expect(code).toBe(0);
    const roots = rootsOf(json);
    expect(roots[0]).toMatchObject({ root: repo, status: "ok", scanned: 1 });
    expect(roots[1]).toMatchObject({ status: "skipped" });
    expect((roots[1].reason as string)).toContain("absent");
    expect(roots[2]).toMatchObject({ status: "skipped" });
  });

  it("a repeated name ACROSS roots is not an error — that is the typed revision-selection case, not a defect", () => {
    for (const base of [repo, vault]) {
      mkdirSync(join(base, "atoms"), { recursive: true });
      writeFileSync(join(base, "atoms", "SKILL.md"), "---\nname: atoms\ndescription: x\nsurface: public\n---\n");
    }
    const { code, json } = check(["check", "--roots", repo, vault]);
    expect(code).toBe(0);
    expect(json).toMatchObject({ ok: true, scanned: 2, valid: 2, invalid: 0 });
  });

  it("an invalid skill in ANY default root fails the exit code (1), the report names the root", () => {
    mkdirSync(join(repo, "bad"), { recursive: true });
    writeFileSync(join(repo, "bad", "SKILL.md"), "---\nname: mismatch\ndescription: x\n---\n");
    const { code, json } = check(["check"]);
    expect(code).toBe(1);
    const pub = rootsOf(json).find((r) => r.label === "public");
    expect(pub).toMatchObject({ status: "ok", scanned: 1, invalid: 1 });
  });
});

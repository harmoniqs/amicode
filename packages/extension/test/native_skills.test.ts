// #1949 §1 — skills reach every engine: the public + entitlement-permitted
// skill set is staged into opencode's NATIVE user skill dir
// (<Global.Path.config>/skills/<name>/SKILL.md — the engine's
// `{skill,skills}/**/SKILL.md` scan over config.directories()), so a plain
// `opencode` started from a terminal resolves director-core / develop /
// implement-issue / tdd without the extension-generated `skills.paths`.
// Ownership discipline mirrors agent staging: only receipt-recorded dirs are
// managed; a user-authored skill dir is never touched.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  stageNativeUserSkills,
  nativeUserSkillsDir,
  NATIVE_SKILLS_RECEIPT_NAME,
  readNativeSkillsOwned,
} from "../src/native_skills";
import { discoverExternalSkillPaths } from "../src/scores/user_skill_providers";

const IN_REPO_LIBRARY = path.resolve(__dirname, "..", "skills");

let home: string;
let savedHome: string | undefined;
let savedXdg: string | undefined;

function writeSkill(root: string, name: string, surface: string, extra = ""): void {
  fs.mkdirSync(path.join(root, name), { recursive: true });
  fs.writeFileSync(
    path.join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\nsurface: ${surface}\n${extra}---\nbody\n`,
  );
}

function stage(extra: Partial<Parameters<typeof stageNativeUserSkills>[0]> = {}) {
  return stageNativeUserSkills({
    skillLibraryRoots: [
      { path: IN_REPO_LIBRARY, surfaces: ["public", "entitled"] },
      { path: path.join(home, ".amico", "vaults", "armonissima", "skills"), surfaces: ["internal"] },
    ],
    skillRoots: [path.join(home, "harmoniqs", "packages")],
    entitlementsDir: path.join(home, ".amico", "amicode"),
    ...extra,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "native-skills-home-"));
  savedHome = process.env.HOME;
  savedXdg = process.env.XDG_CONFIG_HOME;
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("nativeUserSkillsDir (#1949 §1)", () => {
  it("is <opencode config dir>/skills — the dir the engine's {skill,skills}/**/SKILL.md scan reads", () => {
    expect(nativeUserSkillsDir()).toBe(path.join(home, ".config", "opencode", "skills"));
    process.env.XDG_CONFIG_HOME = path.join(home, "xdg");
    expect(nativeUserSkillsDir()).toBe(path.join(home, "xdg", "opencode", "skills"));
  });
});

describe("stageNativeUserSkills (#1949 §1)", () => {
  it("stages director-core, develop, implement-issue, tdd under the native dir of a temp HOME", () => {
    const r = stage();
    const dir = path.join(home, ".config", "opencode", "skills");
    expect(r.dir).toBe(dir);
    for (const name of ["director-core", "develop", "implement-issue", "tdd"]) {
      expect(fs.existsSync(path.join(dir, name, "SKILL.md")), name).toBe(true);
      expect(r.staged).toContain(name);
    }
    // companions ride along (tdd's craft docs resolve from the native copy)
    const tddSrc = fs.readdirSync(path.join(IN_REPO_LIBRARY, "tdd"));
    expect(fs.readdirSync(path.join(dir, "tdd")).sort()).toEqual(tddSrc.sort());
    // the receipt records exactly what the extension owns
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, NATIVE_SKILLS_RECEIPT_NAME), "utf8"));
    expect(receipt.receipt_version).toBe(1);
    expect(receipt.owned.sort()).toEqual([...r.staged].sort());
  });

  it("does not stage an entitled skill without its entitlement", () => {
    const r = stage();
    // piccolissimo is surface: entitled — no entitlements.toml in the temp HOME
    expect(r.staged).not.toContain("piccolissimo");
    expect(fs.existsSync(path.join(r.dir, "piccolissimo"))).toBe(false);
  });

  it("re-staging is idempotent", () => {
    const first = stage();
    const snapshot = (d: string): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (p: string) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const abs = path.join(p, e.name);
          if (e.isDirectory()) walk(abs);
          else if (e.name !== NATIVE_SKILLS_RECEIPT_NAME) out[path.relative(d, abs)] = fs.readFileSync(abs, "utf8");
        }
      };
      walk(d);
      return out;
    };
    const before = snapshot(first.dir);
    const second = stage();
    expect(second.staged).toEqual(first.staged);
    expect(second.removed).toEqual([]);
    expect(snapshot(second.dir)).toEqual(before);
    expect(readNativeSkillsOwned(second.dir).sort()).toEqual([...first.staged].sort());
  });

  it("never touches a user-authored skill dir — not even one sharing a shipped name", () => {
    const dir = nativeUserSkillsDir();
    writeSkill(dir, "my-own-skill", "public");
    fs.writeFileSync(path.join(dir, "my-own-skill", "notes.md"), "mine\n");
    // a user-authored `tdd` predates the extension: not ours, never overwritten
    fs.mkdirSync(path.join(dir, "tdd"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: my tdd\n---\nmine\n");
    const r = stage();
    stage(); // and again
    expect(fs.readFileSync(path.join(dir, "my-own-skill", "notes.md"), "utf8")).toBe("mine\n");
    expect(fs.readFileSync(path.join(dir, "tdd", "SKILL.md"), "utf8")).toContain("my tdd");
    expect(r.skippedUserOwned).toContain("tdd");
    expect(r.staged).not.toContain("tdd");
    expect(readNativeSkillsOwned(dir)).not.toContain("my-own-skill");
    expect(readNativeSkillsOwned(dir)).not.toContain("tdd");
  });

  it("removes only extension-owned dirs that left the set", () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), "native-lib-"));
    writeSkill(lib, "alpha", "public");
    writeSkill(lib, "beta", "public");
    const roots = [{ path: lib, surfaces: ["public", "entitled"] }];
    const dir = nativeUserSkillsDir();
    writeSkill(dir, "user-thing", "public");
    stage({ skillLibraryRoots: roots });
    expect(fs.existsSync(path.join(dir, "beta", "SKILL.md"))).toBe(true);
    fs.rmSync(path.join(lib, "beta"), { recursive: true });
    const r = stage({ skillLibraryRoots: roots });
    expect(r.removed).toEqual(["beta"]);
    expect(fs.existsSync(path.join(dir, "beta"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "alpha", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "user-thing", "SKILL.md"))).toBe(true);
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it("an internal-surface skill is not staged without its mount", () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), "native-lib-"));
    writeSkill(lib, "secret-sauce", "internal");
    writeSkill(lib, "open-thing", "public");
    // the public root never admits internal; the vault mount is absent
    const r = stage({
      skillLibraryRoots: [
        { path: lib, surfaces: ["public", "entitled"] },
        { path: path.join(home, ".amico", "vaults", "armonissima", "skills"), surfaces: ["internal"] },
      ],
    });
    expect(r.staged).toContain("open-thing");
    expect(r.staged).not.toContain("secret-sauce");
    expect(fs.existsSync(path.join(r.dir, "secret-sauce"))).toBe(false);
    // with the mount present, the same admission the session staging uses applies
    const vault = path.join(home, ".amico", "vaults", "armonissima", "skills");
    writeSkill(vault, "secret-sauce", "internal");
    const r2 = stage({
      skillLibraryRoots: [
        { path: lib, surfaces: ["public", "entitled"] },
        { path: vault, surfaces: ["internal"] },
      ],
    });
    expect(r2.staged).toContain("secret-sauce");
    fs.rmSync(lib, { recursive: true, force: true });
  });

  it("the native dir is not offered back as an external provider when every skill there is extension-owned", () => {
    stage();
    expect(discoverExternalSkillPaths(home)).not.toContain(nativeUserSkillsDir());
    writeSkill(nativeUserSkillsDir(), "my-own-skill", "public");
    expect(discoverExternalSkillPaths(home)).toContain(nativeUserSkillsDir());
  });
});

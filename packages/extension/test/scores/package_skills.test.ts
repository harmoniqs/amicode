import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePackageSkills,
  resolveLibrarySkills,
  isProductSkillEntitled,
  buildSkillIndexSection,
  stageOpencodeSkills,
} from "../../src/scores/package_skills";
import { DEFAULT_LIBRARY_ROOTS, DEFAULT_PLATFORM_SKILLS } from "../../src/opencode_config";

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amicode-skillroot-"));
}
function writeSkill(root: string, pkg: string, name: string, description = "desc"): string {
  const dir = path.join(root, `${pkg}.jl`, "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: ${description}\nagents: [experimenter]\n---\n\n# body\n`);
  return p;
}
/** Write a library skill. `surface` is one of "product" | "internal" | null
 *  (null = untagged frontmatter, the pre-tagging state). */
function writeLibSkill(root: string, name: string, surface: "product" | "internal" | null = "product"): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  const surfaceLine = surface === null ? "" : `surface: ${surface}\n`;
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: ${name} physics\nagents: [experimenter]\n${surfaceLine}---\n\n# body\n`);
  return p;
}

describe("resolvePackageSkills (spec-20260704-113005 §3)", () => {
  it("indexes skills only for allowlisted packages", () => {
    const root = mkRoot();
    writeSkill(root, "Piccolissimo", "authoring");
    writeSkill(root, "SecretPkg", "authoring");
    const idx = resolvePackageSkills(["Piccolissimo"], [root]);
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatchObject({ source: "package", package: "Piccolissimo", name: "authoring" });
    expect(fs.existsSync(idx[0].path)).toBe(true);
  });
  it("missing roots and packages without skills/ are silently skipped", () => {
    expect(resolvePackageSkills(["Piccolo"], ["/nonexistent-root", mkRoot()])).toEqual([]);
  });
  it("malformed frontmatter skips that skill, keeps the rest", () => {
    const root = mkRoot();
    const bad = path.join(root, "Piccolissimo.jl", "skills", "broken");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "SKILL.md"), "no frontmatter here");
    writeSkill(root, "Piccolissimo", "authoring");
    const idx = resolvePackageSkills(["Piccolissimo"], [root]);
    expect(idx.map((e) => e.name)).toEqual(["authoring"]);
  });
  it("first root containing <P>.jl/skills wins", () => {
    const r1 = mkRoot(),
      r2 = mkRoot();
    writeSkill(r1, "Piccolissimo", "authoring", "from r1");
    writeSkill(r2, "Piccolissimo", "authoring", "from r2");
    const idx = resolvePackageSkills(["Piccolissimo"], [r1, r2]);
    expect(idx).toHaveLength(1);
    expect(idx[0].description).toBe("from r1");
  });
  it("duplicate names across packages both survive (identity is package/name)", () => {
    const root = mkRoot();
    writeSkill(root, "Piccolissimo", "authoring");
    writeSkill(root, "Piccolo", "authoring");
    expect(resolvePackageSkills(["Piccolissimo", "Piccolo"], [root])).toHaveLength(2);
  });
});

describe("resolveLibrarySkills (spec-20260708-112732 §4.5/§7.1 — surface-tag discovery)", () => {
  it("stages ONLY surface:product skills — internal + untagged in the same root must NOT leak", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "product");
    writeLibSkill(root, "transmon", "product");
    writeLibSkill(root, "pr", "internal"); // process skill tagged internal — the leak hazard
    writeLibSkill(root, "debugging", "internal");
    writeLibSkill(root, "legacy", null); // untagged (pre-tagging) — also excluded
    const idx = resolveLibrarySkills([root]);
    expect(idx.map((e) => e.name).sort()).toEqual(["atoms", "transmon"]);
    for (const e of idx) {
      expect(e.source).toBe("library");
      expect(e.package).toBeUndefined();
    }
  });
  it("EXCLUDES a known internal skill explicitly (the least-privilege leak guard)", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "product");
    writeLibSkill(root, "pr", "internal");
    writeLibSkill(root, "dream", "internal");
    const names = resolveLibrarySkills([root]).map((e) => e.name);
    expect(names).toContain("atoms");
    expect(names).not.toContain("pr");
    expect(names).not.toContain("dream");
  });
  it("EXCLUDES an untagged skill (no surface frontmatter)", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "product");
    writeLibSkill(root, "mystery", null);
    expect(resolveLibrarySkills([root]).map((e) => e.name)).toEqual(["atoms"]);
  });
  it("missing library root → empty, no throw (session proceeds)", () => {
    expect(resolveLibrarySkills(["/nonexistent-lib"])).toEqual([]);
  });
  it("malformed frontmatter skips that skill, keeps the product ones", () => {
    const root = mkRoot();
    const bad = path.join(root, "broken");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "SKILL.md"), "no frontmatter here");
    writeLibSkill(root, "atoms", "product");
    expect(resolveLibrarySkills([root]).map((e) => e.name)).toEqual(["atoms"]);
  });
  it("first root containing a product skill wins", () => {
    const r1 = mkRoot(),
      r2 = mkRoot();
    writeLibSkill(r1, "atoms", "product");
    const p2 = path.join(r2, "atoms");
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(
      path.join(p2, "SKILL.md"),
      `---\nname: atoms\ndescription: from r2\nsurface: product\n---\n# body\n`,
    );
    const idx = resolveLibrarySkills([r1, r2]);
    expect(idx).toHaveLength(1);
    expect(idx[0].description).toBe("atoms physics"); // r1's copy
  });
  describe("entitlement seam (§7.1)", () => {
    it("default predicate admits every product skill (public today)", () => {
      const root = mkRoot();
      writeLibSkill(root, "atoms", "product");
      writeLibSkill(root, "transmon", "product");
      expect(resolveLibrarySkills([root]).map((e) => e.name).sort()).toEqual(["atoms", "transmon"]);
    });
    it("a predicate can gate a product skill without touching discovery", () => {
      const root = mkRoot();
      writeLibSkill(root, "atoms", "product");
      writeLibSkill(root, "premium", "product");
      const idx = resolveLibrarySkills([root], (name) => name !== "premium");
      expect(idx.map((e) => e.name)).toEqual(["atoms"]); // product-tagged but not entitled → dropped
    });
    it("isProductSkillEntitled: public product skills (empty GATED_PRODUCT_SKILLS) always admitted", () => {
      expect(isProductSkillEntitled("atoms", [])).toBe(true);
      expect(isProductSkillEntitled("solve", ["some-code"])).toBe(true);
    });
  });
  it("discovers exactly the product-skill set from the real amico-plugin library root", () => {
    const root = DEFAULT_LIBRARY_ROOTS[0];
    if (!fs.existsSync(root)) {
      // machine without the amico-plugin checkout (e.g. CI) — the hermetic tests
      // above cover the discovery logic; skip the real-root assertion.
      return;
    }
    const names = resolveLibrarySkills(DEFAULT_LIBRARY_ROOTS).map((e) => e.name).sort();
    expect(names).toEqual([...DEFAULT_PLATFORM_SKILLS].sort());
    expect(names).toHaveLength(10);
    // explicit leak-guard on real data: known internal skills must be absent
    for (const internal of ["pr", "debugging", "dream", "meeting", "tdd"]) {
      expect(names).not.toContain(internal);
    }
  });
});

describe("buildSkillIndexSection", () => {
  it("empty index → empty string (no section at all)", () => {
    expect(buildSkillIndexSection([])).toBe("");
  });
  it("renders both entry kinds, the heading, and the invoke-before-authoring instruction", () => {
    const s = buildSkillIndexSection([
      { source: "library", name: "atoms", description: "Rydberg physics", path: "/lib/atoms/SKILL.md" },
      {
        source: "package",
        package: "Piccolissimo",
        name: "authoring",
        description: "Author solves",
        path: "/abs/SKILL.md",
      },
    ]);
    expect(s).toContain("## Skill index"); // registered opencode skills (platform + package)
    expect(s).toContain("atoms");
    expect(s).toMatch(/physics reference/i); // platform-entry instruction (inline constants, self-contained)
    expect(s).toContain("package: Piccolissimo"); // package entry shows its invocable name + owning package
    // These are opencode-native skills now → invoke by name, NOT read a path.
    expect(s).toMatch(/invoke .*BEFORE authoring/i);
    expect(s).not.toContain("/abs/SKILL.md"); // no file path in the prose (agent invokes, doesn't read)
  });
  it("orders platform entries before package entries", () => {
    const s = buildSkillIndexSection([
      { source: "package", package: "Piccolissimo", name: "authoring", description: "d", path: "/a" },
      { source: "library", name: "atoms", description: "d", path: "/b" },
    ]);
    expect(s.indexOf("atoms")).toBeLessThan(s.indexOf("package: Piccolissimo"));
  });
});

describe("stageOpencodeSkills", () => {
  it("copies ONLY the resolved set into <root>/<name>/SKILL.md and returns the root", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "skillsrc-"));
    fs.mkdirSync(path.join(src, "atoms"));
    fs.writeFileSync(path.join(src, "atoms", "SKILL.md"), "---\nname: atoms\ndescription: d\nagents: [x]\n---\nbody\n");
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    const out = stageOpencodeSkills(stageRoot, [
      { source: "library", name: "atoms", description: "d", path: path.join(src, "atoms", "SKILL.md") },
    ]);
    expect(out).toBe(stageRoot);
    const staged = path.join(stageRoot, "atoms", "SKILL.md");
    expect(fs.existsSync(staged)).toBe(true);
    // folder name == frontmatter name (opencode's rule); content copied verbatim (agents: kept — opencode ignores it)
    expect(fs.readFileSync(staged, "utf8")).toContain("agents: [x]");
    // nothing else staged — only the one resolved entry's dir exists
    expect(fs.readdirSync(stageRoot).sort()).toEqual(["atoms"]);
  });
  it("empty set → '' (no skills.paths registered)", () => {
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    expect(stageOpencodeSkills(stageRoot, [])).toBe("");
  });
});

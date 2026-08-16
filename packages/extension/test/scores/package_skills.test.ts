import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolvePackageSkills,
  resolveLibrarySkills,
  buildSkillIndexSection,
  stageOpencodeSkills,
  parseLibraryRootSpecs,
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
/** Write a library skill. `surface` is one of "public" | "internal" | null
 *  (null = untagged frontmatter, the pre-tagging state). */
function writeLibSkill(root: string, name: string, surface: "public" | "internal" | null = "public"): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  const surfaceLine = surface === null ? "" : `surface: ${surface}\n`;
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: ${name} physics\nagents: [experimenter]\n${surfaceLine}---\n\n# body\n`);
  return p;
}

/** The real in-repo public library root (packages/extension/skills/). Post-amico-plugin
 *  this ALWAYS exists in a checkout — it is the shipped source of truth — so the real-root
 *  assertions run unconditionally, on CI included. Returns null only if the tree is broken
 *  (a missing skills/ dir), in which case the assertions skip rather than false-fail. */
function inRepoLibraryRoot(): string | null {
  const root = DEFAULT_LIBRARY_ROOTS[0].path; // the in-repo library (typed root, ADR-0003)
  return fs.existsSync(root) ? root : null;
}
/** The team-vault internal library root (armonissima mount). Present only on machines
 *  that sync the team vault — CI does not — so internal-tier assertions skip cleanly. */
function vaultInternalRoot(): string | null {
  const root = DEFAULT_LIBRARY_ROOTS[1].path; // the armonissima mount (typed root, ADR-0003)
  return fs.existsSync(root) ? root : null;
}
/** Count on-disk library skills carrying an explicit admitted tag, mirroring the
 *  resolver's tolerance (well-formed frontmatter carrying name+description;
 *  malformed dirs skipped). The in-repo root admits {public} only, so the expected
 *  real-root set is every public-tagged skill. */
function countTaggedSkills(root: string, surfaces: RegExp = /(public|internal)/): number {
  let n = 0;
  for (const name of fs.readdirSync(root)) {
    const p = path.join(root, name, "SKILL.md");
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = m[1];
    const ok = /^name:\s*\S/m.test(fm) && /^description:\s*\S/m.test(fm);
    if (ok && new RegExp(`^surface:\\s*${surfaces.source}\\b`, "m").test(fm)) n++;
  }
  return n;
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

describe("resolveLibrarySkills (spec-20260713-003804 — surface:public discovery)", () => {
  it("stages ONLY surface:public skills — internal + untagged in the same root must NOT leak", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "public");
    writeLibSkill(root, "transmon", "public");
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
    writeLibSkill(root, "atoms", "public");
    writeLibSkill(root, "pr", "internal");
    writeLibSkill(root, "dream", "internal");
    const names = resolveLibrarySkills([root]).map((e) => e.name);
    expect(names).toContain("atoms");
    expect(names).not.toContain("pr");
    expect(names).not.toContain("dream");
  });
  it("EXCLUDES an untagged skill (no surface frontmatter) — dropped WITH a logged warning from every root (AC3)", () => {
    for (const spec of ["string-root", { path: "typed-root", surfaces: ["public", "internal"] }]) {
      const root = mkRoot();
      writeLibSkill(root, "atoms", "public");
      writeLibSkill(root, "mystery", null); // untagged — default-deny at BOTH tiers
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const roots = typeof spec === "string" ? [root] : [{ ...spec, path: root }];
        expect(resolveLibrarySkills(roots).map((e) => e.name)).toEqual(["atoms"]);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("mystery"));
      } finally {
        warn.mockRestore();
      }
    }
  });
  it("missing library root → empty, no throw (session proceeds)", () => {
    expect(resolveLibrarySkills(["/nonexistent-lib"])).toEqual([]);
  });
  it("malformed frontmatter skips that skill WITH a logged warning, keeps the public ones (AC3)", () => {
    const root = mkRoot();
    const bad = path.join(root, "broken");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, "SKILL.md"), "no frontmatter here");
    writeLibSkill(root, "atoms", "public");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLibrarySkills([root]).map((e) => e.name)).toEqual(["atoms"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("malformed"));
    } finally {
      warn.mockRestore();
    }
  });
  it("first root containing a public skill wins", () => {
    const r1 = mkRoot(),
      r2 = mkRoot();
    writeLibSkill(r1, "atoms", "public");
    const p2 = path.join(r2, "atoms");
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(
      path.join(p2, "SKILL.md"),
      `---\nname: atoms\ndescription: from r2\nsurface: public\n---\n# body\n`,
    );
    const idx = resolveLibrarySkills([r1, r2]);
    expect(idx).toHaveLength(1);
    expect(idx[0].description).toBe("atoms physics"); // r1's copy
  });

  // Two-tier surfaces (ADR-0003, amicode#242): a typed root carries the surface
  // tags it admits. The team-vault root admits {internal} — mount presence IS
  // the eligibility proof (the content exists only in the private vault).
  it("a typed root admitting {public, internal} stages BOTH tiers (the legacy combined root)", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "public");
    writeLibSkill(root, "implement-issue", "internal"); // dev-workflow skill — the AC1 payload
    const idx = resolveLibrarySkills([{ path: root, surfaces: ["public", "internal"] }]);
    expect(idx.map((e) => e.name).sort()).toEqual(["atoms", "implement-issue"]);
  });
  it("with ONLY a public-only typed root (the in-repo library form), internal skills resolve to nothing (AC2)", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "public");
    writeLibSkill(root, "implement-issue", "internal");
    const idx = resolveLibrarySkills([{ path: root, surfaces: ["public"] }]);
    expect(idx.map((e) => e.name)).toEqual(["atoms"]);
  });
  it("the first root wins over a later root for the same skill name, across tiers", () => {
    const checkout = mkRoot(),
      bundle = mkRoot();
    writeLibSkill(checkout, "atoms", "public");
    writeLibSkill(bundle, "atoms", "public"); // the later copy must lose (first-root-wins)
    writeLibSkill(checkout, "implement-issue", "internal");
    const idx = resolveLibrarySkills([
      { path: checkout, surfaces: ["public", "internal"] },
      { path: bundle, surfaces: ["public"] },
    ]);
    expect(idx.map((e) => e.name).sort()).toEqual(["atoms", "implement-issue"]);
    expect(idx.find((e) => e.name === "atoms")!.path.startsWith(checkout)).toBe(true);
  });
  it("DEFAULT_LIBRARY_ROOTS is typed: the in-repo library admits public only; the armonissima vault root admits internal only", () => {
    expect(DEFAULT_LIBRARY_ROOTS).toHaveLength(2);
    const [inRepo, vault] = DEFAULT_LIBRARY_ROOTS;
    expect(inRepo.path).toMatch(/packages\/extension\/skills$/);
    expect(inRepo.surfaces).toEqual(["public"]); // repo boundary, never internal
    expect(vault.path).toMatch(/armonissima/);
    expect(vault.surfaces).toEqual(["internal"]); // team-vault content, never public
  });

  // Real-library-root assertions. The in-repo root always exists (it ships), so these run
  // everywhere. DEFAULT_PLATFORM_SKILLS is retained as a documentation anchor of the
  // physics/opt subset but is NOT the selection input — discovery is by tag, and the
  // in-repo root admits {public} only (ADR-0003): internal skills resolve only from the
  // armonissima vault root, where mount presence is the eligibility proof.
  it("discovers every public-tagged skill from the real in-repo library", () => {
    const root = inRepoLibraryRoot();
    if (!root) return;
    const expected = countTaggedSkills(root, /public/); // tag-derived, same tolerance as the resolver
    const names = resolveLibrarySkills(DEFAULT_LIBRARY_ROOTS).map((e) => e.name).sort();
    // every physics/opt anchor is public → present in the discovered set (superset check)
    for (const p of DEFAULT_PLATFORM_SKILLS) expect(names).toContain(p);
    // the public set is exactly the in-repo public tags, PLUS anything the vault root
    // contributes on team machines — so assert containment, not equality, when the
    // vault is mounted; exact equality otherwise.
    if (vaultInternalRoot()) {
      expect(names.length).toBeGreaterThanOrEqual(expected);
    } else {
      expect(names).toHaveLength(expected);
    }
    expect(expected).toBeGreaterThan(0);
  });
  it("internal skills resolve from the armonissima mount when it is present (team machines only)", () => {
    const vault = vaultInternalRoot();
    if (!vault) return; // CI / fresh installs have no team vault — skip
    const names = resolveLibrarySkills(DEFAULT_LIBRARY_ROOTS).map((e) => e.name);
    // AC1 on real data: a genuinely internal skill resolves from the vault root
    // (the in-repo root can never provide it — repo-boundary least privilege).
    expect(names).toContain("write-an-issue");
    // and the internal count tracks the vault's tagged set
    expect(names.length).toBeGreaterThanOrEqual(countTaggedSkills(vault, /internal/));
  });

  // spec-20260713-003804 §6 tag-required check. The tag-derived count above is near-tautological
  // (an untagged skill is invisible to BOTH sides), so it cannot catch a public-intended skill
  // left untagged — which under default-deny silently fails to ship. This is that regression guard:
  // every real in-repo library skill MUST carry an explicit surface: public.
  it("every real in-repo library skill carries an explicit surface: public", () => {
    const root = inRepoLibraryRoot();
    if (!root) return;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(root).sort()) {
      const p = path.join(root, name, "SKILL.md");
      if (!fs.existsSync(p)) continue;
      const m = fs.readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
      const surface = m?.[1].match(/^surface:\s*(\S+)/m)?.[1];
      if (surface !== "public") offenders.push(`${name} (surface=${surface ?? "MISSING"})`);
    }
    expect(offenders, `untagged/mis-tagged in-repo library skills: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("parseLibraryRootSpecs (settings back-compat, ADR-0003)", () => {
  it("passes bare strings through as public-only roots (pre-ADR overrides keep working)", () => {
    expect(parseLibraryRootSpecs(["/a", "~/b"])).toEqual(["/a", "~/b"]);
  });
  it("accepts typed {path, surfaces} objects verbatim", () => {
    const typed = [{ path: "/x", surfaces: ["public", "internal"] }];
    expect(parseLibraryRootSpecs(typed)).toEqual(typed);
  });
  it("drops malformed entries with a logged warning; keeps the valid ones", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = parseLibraryRootSpecs([
        "/ok",
        { path: "/no-surfaces" },
        { path: "", surfaces: ["public"] },
        { path: "/bad-surfaces", surfaces: "public" },
        { path: "/empty-surfaces", surfaces: [] },
        42,
        null,
      ]);
      expect(out).toEqual(["/ok"]);
      expect(warn).toHaveBeenCalledTimes(6);
    } finally {
      warn.mockRestore();
    }
  });
  it("non-array / empty → []", () => {
    expect(parseLibraryRootSpecs(undefined)).toEqual([]);
    expect(parseLibraryRootSpecs("nope")).toEqual([]);
    expect(parseLibraryRootSpecs([])).toEqual([]);
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
  it("copies ONLY the resolved set into <root>/<name>/ and returns the root", () => {
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
  it("stages companion files so SKILL.md relative links resolve (amicode#393)", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "skillsrc-"));
    fs.mkdirSync(path.join(src, "tdd"));
    fs.mkdirSync(path.join(src, "tdd", "references"));
    fs.writeFileSync(path.join(src, "tdd", "SKILL.md"), "---\nname: tdd\ndescription: d\n---\nSee [tests.md](tests.md).\n");
    fs.writeFileSync(path.join(src, "tdd", "tests.md"), "# tests\n");
    fs.writeFileSync(path.join(src, "tdd", "references", "r.md"), "# r\n");
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    stageOpencodeSkills(stageRoot, [
      { source: "library", name: "tdd", description: "d", path: path.join(src, "tdd", "SKILL.md") },
    ]);
    expect(fs.existsSync(path.join(stageRoot, "tdd", "tests.md"))).toBe(true);
    expect(fs.existsSync(path.join(stageRoot, "tdd", "references", "r.md"))).toBe(true);
    // still only the resolved set at the stage root
    expect(fs.readdirSync(stageRoot)).toEqual(["tdd"]);
  });
  it("empty set → '' (no skills.paths registered)", () => {
    const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
    expect(stageOpencodeSkills(stageRoot, [])).toBe("");
  });
});

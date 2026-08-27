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
import { DEFAULT_LIBRARY_ROOTS, QUANTUM_CONTROL_SKILLS } from "../../src/opencode_config";

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
/** Write a library skill. `surface` is one of "public" | "internal" | "entitled" | null
 *  (null = untagged frontmatter, the pre-tagging state). `entitlement` pairs with
 *  surface:entitled (spec §Amendment A1) — the code a session must hold to stage it. */
function writeLibSkill(
  root: string,
  name: string,
  surface: "public" | "internal" | "entitled" | null = "public",
  entitlement?: string,
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  const surfaceLine = surface === null ? "" : `surface: ${surface}\n`;
  const entLine = entitlement === undefined ? "" : `entitlement: ${entitlement}\n`;
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: ${name} physics\nagents: [experimenter]\n${surfaceLine}${entLine}---\n\n# body\n`);
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
  it("DEFAULT_LIBRARY_ROOTS is typed: the in-repo library admits public + entitled (three-tier, ADR-0011); the armonissima vault root admits internal only", () => {
    expect(DEFAULT_LIBRARY_ROOTS).toHaveLength(2);
    const [inRepo, vault] = DEFAULT_LIBRARY_ROOTS;
    expect(inRepo.path).toMatch(/packages\/extension\/skills$/);
    expect(inRepo.surfaces).toEqual(["public", "entitled"]); // repo boundary, never internal — entitled is a staging gate, not a location
    expect(vault.path).toMatch(/armonissima/);
    expect(vault.surfaces).toEqual(["internal"]); // team-vault content, never public
  });

  // Real-library-root assertions. The in-repo root always exists (it ships), so these run
  // everywhere. QUANTUM_CONTROL_SKILLS moved to armonissima (surface: internal, ADR 0008)
  // so the public set no longer contains them — they resolve only from the vault root.
  it("discovers every public-tagged skill from the real in-repo library", () => {
    const root = inRepoLibraryRoot();
    if (!root) return;
    const expected = countTaggedSkills(root, /public/); // tag-derived, same tolerance as the resolver
    // Resolve from the PUBLIC root only to verify quantum-control skills aren't there
    const publicOnly = resolveLibrarySkills([DEFAULT_LIBRARY_ROOTS[0]]).map((e) => e.name).sort();
    // quantum-control skills are internal → NOT in the public root (ADR 0008)
    for (const p of QUANTUM_CONTROL_SKILLS) expect(publicOnly).not.toContain(p);
    // the public set is exactly the in-repo public tags
    expect(publicOnly).toHaveLength(expected);
    expect(expected).toBeGreaterThan(0);
    // Full resolution (public + vault) includes internal skills when armonissima is mounted
    const names = resolveLibrarySkills(DEFAULT_LIBRARY_ROOTS).map((e) => e.name).sort();
    if (vaultInternalRoot()) {
      expect(names.length).toBeGreaterThan(publicOnly.length);
    } else {
      expect(names).toHaveLength(expected);
    }
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

  // spec-20260713-003804 §6 tag-required check, three-tier form (ADR-0011). The
  // tag-derived count above is near-tautological (an untagged skill is invisible to
  // BOTH sides), so it cannot catch a shipping-intended skill left untagged — which
  // under default-deny silently fails to ship. This is that regression guard: every
  // real in-repo library skill MUST carry an explicit shipping surface (public, or
  // entitled with its entitlement code) — internal stays vault-only.
  it("every real in-repo library skill carries an explicit surface: public or entitled (entitled needs its code)", () => {
    const root = inRepoLibraryRoot();
    if (!root) return;
    const offenders: string[] = [];
    for (const name of fs.readdirSync(root).sort()) {
      const p = path.join(root, name, "SKILL.md");
      if (!fs.existsSync(p)) continue;
      const m = fs.readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/);
      const surface = m?.[1].match(/^surface:\s*(\S+)/m)?.[1];
      // raw-value capture + quote-strip: `entitlement: ""` must read as EMPTY
      // (the resolver refuses it at runtime; the guard must agree)
      const entitlement = m?.[1].match(/^entitlement:\s*(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
      const ok = surface === "public" || (surface === "entitled" && !!entitlement);
      if (!ok) offenders.push(`${name} (surface=${surface ?? "MISSING"}${surface === "entitled" ? ", entitlement MISSING" : ""})`);
    }
    expect(offenders, `non-shippable in-repo library skills: ${offenders.join(", ")}`).toEqual([]);
  });
});

// Entitled surface tier (spec §Amendment A1, amicode#614; ADR-0011): a THIRD
// surface tier — `surface: entitled` + `entitlement: <code>` — that ships in the
// .vsix (same in-repo library as public; entitled is a STAGING gate, not a
// location) and stages ONLY for sessions whose resolved entitlements include
// the skill's code. Malformed entitlement frontmatter follows the resolver's
// skip+warn philosophy — never throw.
describe("resolveLibrarySkills — entitled surface tier (spec §Amendment A1, amicode#614)", () => {
  /** Typed root admitting the in-repo-library surface set post-amendment. */
  function inRepoFormRoot(root: string): { path: string; surfaces: string[] } {
    return { path: root, surfaces: ["public", "entitled"] };
  }

  it("(a) stages surface:entitled + entitlement:issimo IFF the session entitlements include the code", () => {
    const root = mkRoot();
    writeLibSkill(root, "piccolissimo", "entitled", "issimo");
    const idx = resolveLibrarySkills([inRepoFormRoot(root)], ["issimo"]);
    expect(idx.map((e) => e.name)).toEqual(["piccolissimo"]);
    expect(idx[0].source).toBe("library");
    expect(idx[0].package).toBeUndefined(); // library entries carry no package
    expect(fs.existsSync(idx[0].path)).toBe(true);
  });
  it("(b) does NOT stage an entitled skill when entitlements are empty or lack the code — silently (the normal unentitled session)", () => {
    const root = mkRoot();
    writeLibSkill(root, "piccolissimo", "entitled", "issimo");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLibrarySkills([inRepoFormRoot(root)], []).map((e) => e.name)).toEqual([]);
      expect(resolveLibrarySkills([inRepoFormRoot(root)], ["other-ent"]).map((e) => e.name)).toEqual([]);
      // NOT a malformed frontmatter case — being unentitled is the normal state,
      // so no warn fires (warn is reserved for malformed entitlement CODES).
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
  it("(c) an entitled skill with a MISSING entitlement code is skipped WITH a logged warning (skip+warn, never throw)", () => {
    const root = mkRoot();
    writeLibSkill(root, "piccolissimo", "entitled"); // no entitlement: line
    writeLibSkill(root, "atoms", "public"); // the rest of the library keeps working
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLibrarySkills([inRepoFormRoot(root)], ["issimo"]).map((e) => e.name)).toEqual(["atoms"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("piccolissimo"));
    } finally {
      warn.mockRestore();
    }
  });
  it("(c) an entitled skill with a MALFORMED entitlement code (non-string, empty) is skipped WITH a logged warning", () => {
    const root = mkRoot();
    // non-string entitlement (YAML list) — written raw to bypass the helper's string typing
    const bad = path.join(root, "legatissimo");
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(
      path.join(bad, "SKILL.md"),
      `---\nname: legatissimo\ndescription: legatissimo physics\nsurface: entitled\nentitlement: [issimo]\n---\n\n# body\n`,
    );
    // empty-string entitlement — structurally present but not a code
    writeLibSkill(root, "intonatissimo", "entitled", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolveLibrarySkills([inRepoFormRoot(root)], ["issimo"]).map((e) => e.name)).toEqual([]);
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("legatissimo"))).toBe(true);
      expect(calls.some((c) => c.includes("intonatissimo"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
  it("(d) public entries stage unconditionally — unchanged, with or without entitlements", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "public");
    expect(resolveLibrarySkills([inRepoFormRoot(root)]).map((e) => e.name)).toEqual(["atoms"]);
    expect(resolveLibrarySkills([inRepoFormRoot(root)], []).map((e) => e.name)).toEqual(["atoms"]);
    expect(resolveLibrarySkills([inRepoFormRoot(root)], ["issimo"]).map((e) => e.name)).toEqual(["atoms"]);
  });
  it("(e) a root that does not admit 'entitled' never stages entitled entries — even with the entitlement held (per-root guard)", () => {
    const root = mkRoot();
    writeLibSkill(root, "piccolissimo", "entitled", "issimo");
    expect(resolveLibrarySkills([{ path: root, surfaces: ["public"] }], ["issimo"]).map((e) => e.name)).toEqual([]);
  });
  it("stages entitled + public together from one root (the shipped-library shape)", () => {
    const root = mkRoot();
    writeLibSkill(root, "atoms", "public");
    writeLibSkill(root, "piccolissimo", "entitled", "issimo");
    const idx = resolveLibrarySkills([inRepoFormRoot(root)], ["issimo"]);
    expect(idx.map((e) => e.name).sort()).toEqual(["atoms", "piccolissimo"]);
  });
  it("first-root-wins still applies for entitled entries across roots", () => {
    const r1 = mkRoot(),
      r2 = mkRoot();
    writeLibSkill(r1, "piccolissimo", "entitled", "issimo");
    writeLibSkill(r2, "piccolissimo", "entitled", "issimo");
    const idx = resolveLibrarySkills([inRepoFormRoot(r1), inRepoFormRoot(r2)], ["issimo"]);
    expect(idx).toHaveLength(1);
    expect(idx[0].path.startsWith(r1)).toBe(true);
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

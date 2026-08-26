import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  resolveUserSkills,
  resolveWorkspaceSkills,
  mergeSkillEntries,
  discoverExternalSkillPaths,
  resolveUrlProvider,
  readSkillProviders,
  addSkillProvider,
  removeSkillProvider,
  type SkillProvider,
  type SkillProvidersConfig,
  type MergedSkillEntry,
} from "../../src/scores/user_skill_providers";
import { buildSkillIndexSection, type SkillIndexEntry } from "../../src/scores/package_skills";
import { prepareOpencodeProject } from "../../src/opencode_config";

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "amicode-userskill-"));
}

/** Write a minimal valid user skill (name + description only — no surface tag). */
function writeUserSkill(root: string, name: string, description = "user skill desc"): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "SKILL.md");
  fs.writeFileSync(p, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  return p;
}

/** Write a skill-providers.json file with the given providers. */
function writeProvidersJson(dir: string, providers: SkillProvider[]): string {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, "skill-providers.json");
  const config: SkillProvidersConfig = { version: 1, providers };
  fs.writeFileSync(p, JSON.stringify(config, null, 2));
  return p;
}

describe("resolveUserSkills (issue #573 — user skill providers)", () => {
  it("resolves skills from a directory provider listed in skill-providers.json", () => {
    const configDir = mkRoot();
    const skillDir = mkRoot();
    writeUserSkill(skillDir, "my-analysis", "Custom analysis tools");
    writeUserSkill(skillDir, "lab-protocols", "Lab automation protocols");

    writeProvidersJson(configDir, [
      { id: "my-lab", type: "directory", path: skillDir, added: "2026-08-26T09:00:00Z" },
    ]);

    const providersPath = path.join(configDir, "skill-providers.json");
    const entries = resolveUserSkills(providersPath);

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["lab-protocols", "my-analysis"]);
    for (const e of entries) {
      expect(e.source).toBe("custom");
      expect(fs.existsSync(e.path)).toBe(true);
    }
    expect(entries.find((e) => e.name === "my-analysis")!.description).toBe("Custom analysis tools");
  });

  it("returns [] when providers.json is missing (no throw, session proceeds)", () => {
    expect(resolveUserSkills("/nonexistent/skill-providers.json")).toEqual([]);
  });

  it("returns [] when providers.json is malformed JSON", () => {
    const configDir = mkRoot();
    const p = path.join(configDir, "skill-providers.json");
    fs.writeFileSync(p, "not { valid json!");
    expect(resolveUserSkills(p)).toEqual([]);
  });

  it("returns [] when providers.json has no providers array", () => {
    const configDir = mkRoot();
    const p = path.join(configDir, "skill-providers.json");
    fs.writeFileSync(p, JSON.stringify({ version: 1 }));
    expect(resolveUserSkills(p)).toEqual([]);
  });

  it("skips a directory provider whose path does not exist (no throw)", () => {
    const configDir = mkRoot();
    const skillDir = mkRoot();
    writeUserSkill(skillDir, "good-skill", "works");

    writeProvidersJson(configDir, [
      { id: "missing", type: "directory", path: "/nonexistent/skills", added: "2026-08-26T09:00:00Z" },
      { id: "exists", type: "directory", path: skillDir, added: "2026-08-26T09:00:00Z" },
    ]);

    const entries = resolveUserSkills(path.join(configDir, "skill-providers.json"));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("good-skill");
  });

  it("resolves user skills WITHOUT a surface tag (only name + description required)", () => {
    const configDir = mkRoot();
    const skillDir = mkRoot();
    // Write a skill with extra fields that should be ignored
    const dir = path.join(skillDir, "my-tool");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: my-tool\ndescription: A useful tool\nagents: [researcher]\nsurface: internal\n---\n\n# body\n`,
    );
    // Also one with truly minimal frontmatter (no surface, no agents)
    writeUserSkill(skillDir, "minimal", "bare minimum");

    writeProvidersJson(configDir, [
      { id: "test", type: "directory", path: skillDir, added: "2026-08-26T09:00:00Z" },
    ]);

    const entries = resolveUserSkills(path.join(configDir, "skill-providers.json"));
    expect(entries).toHaveLength(2);
    // Both resolve regardless of surface/agents — user skills sidestep the surface model
    expect(entries.map((e) => e.name).sort()).toEqual(["minimal", "my-tool"]);
  });

  it("skips skills with malformed frontmatter, keeps the valid ones", () => {
    const configDir = mkRoot();
    const skillDir = mkRoot();
    writeUserSkill(skillDir, "good", "valid skill");
    // Bad: no frontmatter at all
    const bad1 = path.join(skillDir, "bad-no-fm");
    fs.mkdirSync(bad1, { recursive: true });
    fs.writeFileSync(path.join(bad1, "SKILL.md"), "just some text");
    // Bad: frontmatter missing description
    const bad2 = path.join(skillDir, "bad-no-desc");
    fs.mkdirSync(bad2, { recursive: true });
    fs.writeFileSync(path.join(bad2, "SKILL.md"), "---\nname: bad-no-desc\n---\n");

    writeProvidersJson(configDir, [
      { id: "mixed", type: "directory", path: skillDir, added: "2026-08-26T09:00:00Z" },
    ]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries = resolveUserSkills(path.join(configDir, "skill-providers.json"));
      expect(entries).toHaveLength(1);
      expect(entries[0].name).toBe("good");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("resolveWorkspaceSkills (issue #573 — .opencode/skills/ auto-load)", () => {
  it("resolves skills from a workspace skills directory as source 'workspace'", () => {
    const wsSkillsDir = mkRoot();
    writeUserSkill(wsSkillsDir, "team-lint", "Team linting rules");
    writeUserSkill(wsSkillsDir, "deploy", "Deployment automation");

    const entries = resolveWorkspaceSkills(wsSkillsDir);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.name).sort()).toEqual(["deploy", "team-lint"]);
    for (const e of entries) {
      expect(e.source).toBe("workspace");
    }
  });

  it("returns [] when the workspace skills directory does not exist", () => {
    expect(resolveWorkspaceSkills("/nonexistent/.opencode/skills")).toEqual([]);
  });
});

describe("mergeSkillEntries (issue #573 — shadow semantics: custom > workspace > shipped)", () => {
  it("custom skill shadows a shipped (library) skill of the same name", () => {
    const custom: SkillIndexEntry[] = [
      { source: "custom", name: "atoms", description: "My custom atoms", path: "/user/atoms/SKILL.md" },
    ];
    const workspace: SkillIndexEntry[] = [];
    const shipped: SkillIndexEntry[] = [
      { source: "library", name: "atoms", description: "Rydberg physics", path: "/lib/atoms/SKILL.md" },
      { source: "library", name: "transmon", description: "Transmon physics", path: "/lib/transmon/SKILL.md" },
    ];

    const merged = mergeSkillEntries(custom, workspace, shipped);
    // atoms from custom wins, transmon passes through
    expect(merged).toHaveLength(2);
    const atoms = merged.find((e) => e.name === "atoms")!;
    expect(atoms.source).toBe("custom");
    expect(atoms.description).toBe("My custom atoms");
    // transmon unaffected
    expect(merged.find((e) => e.name === "transmon")!.source).toBe("library");
  });

  it("workspace skill shadows a shipped skill", () => {
    const custom: SkillIndexEntry[] = [];
    const workspace: SkillIndexEntry[] = [
      { source: "workspace", name: "tdd", description: "Team TDD rules", path: "/ws/tdd/SKILL.md" },
    ];
    const shipped: SkillIndexEntry[] = [
      { source: "library", name: "tdd", description: "Standard TDD", path: "/lib/tdd/SKILL.md" },
    ];

    const merged = mergeSkillEntries(custom, workspace, shipped);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("workspace");
    expect(merged[0].description).toBe("Team TDD rules");
  });

  it("custom beats workspace for the same name", () => {
    const custom: SkillIndexEntry[] = [
      { source: "custom", name: "deploy", description: "My deploy", path: "/user/deploy/SKILL.md" },
    ];
    const workspace: SkillIndexEntry[] = [
      { source: "workspace", name: "deploy", description: "Team deploy", path: "/ws/deploy/SKILL.md" },
    ];
    const shipped: SkillIndexEntry[] = [];

    const merged = mergeSkillEntries(custom, workspace, shipped);
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe("custom");
  });

  it("tracks which shipped skills were shadowed (for labeling)", () => {
    const custom: SkillIndexEntry[] = [
      { source: "custom", name: "atoms", description: "Override", path: "/user/atoms/SKILL.md" },
    ];
    const shipped: SkillIndexEntry[] = [
      { source: "library", name: "atoms", description: "Original", path: "/lib/atoms/SKILL.md" },
    ];

    const merged = mergeSkillEntries(custom, [], shipped);
    const atoms = merged.find((e) => e.name === "atoms")!;
    // The entry should carry a flag indicating it overrides a platform skill
    expect((atoms as any).overridesShipped).toBe(true);
  });
});

describe("buildSkillIndexSection labels user/workspace skills (issue #573)", () => {
  it("labels custom skills as '(custom)' in the index", () => {
    const entries: MergedSkillEntry[] = [
      { source: "custom", name: "my-analysis", description: "Custom analysis", path: "/a" },
    ];
    const s = buildSkillIndexSection(entries);
    expect(s).toContain("my-analysis");
    expect(s).toContain("(custom)");
    expect(s).not.toContain("(platform reference)");
  });

  it("labels workspace skills as '(workspace)' in the index", () => {
    const entries: MergedSkillEntry[] = [
      { source: "workspace", name: "team-lint", description: "Linting rules", path: "/b" },
    ];
    const s = buildSkillIndexSection(entries);
    expect(s).toContain("team-lint");
    expect(s).toContain("(workspace)");
  });

  it("labels a custom skill that shadows a shipped skill as '(custom, overrides platform)'", () => {
    const entries: MergedSkillEntry[] = [
      { source: "custom", name: "atoms", description: "My atoms override", path: "/c", overridesShipped: true },
      { source: "library", name: "transmon", description: "Transmon physics", path: "/d" },
    ];
    const s = buildSkillIndexSection(entries);
    expect(s).toContain("(custom, overrides platform)");
    // transmon still has normal platform label
    expect(s).toMatch(/transmon.*\(platform reference\)/);
  });

  it("renders all source types in correct order: platform, custom, workspace, package", () => {
    const entries: MergedSkillEntry[] = [
      { source: "library", name: "transmon", description: "Transmon physics", path: "/a" },
      { source: "custom", name: "my-tool", description: "Custom tool", path: "/b" },
      { source: "workspace", name: "team-lint", description: "Team lint", path: "/c" },
      { source: "package", package: "Piccolissimo", name: "pkg-auth", description: "Authoring", path: "/d" },
    ];
    const s = buildSkillIndexSection(entries);
    // Platform first, then custom/workspace, then package
    const iTransmon = s.indexOf("**transmon**");
    const iMyTool = s.indexOf("**my-tool**");
    const iTeamLint = s.indexOf("**team-lint**");
    const iPkgAuth = s.indexOf("**pkg-auth**");
    expect(iTransmon).toBeGreaterThan(-1);
    expect(iMyTool).toBeGreaterThan(-1);
    expect(iTeamLint).toBeGreaterThan(-1);
    expect(iPkgAuth).toBeGreaterThan(-1);
    expect(iTransmon).toBeLessThan(iMyTool);
    expect(iMyTool).toBeLessThan(iTeamLint);
    expect(iTeamLint).toBeLessThan(iPkgAuth);
  });
});

describe("engine suppression (issue #573 — OPENCODE_DISABLE_EXTERNAL_SKILLS)", () => {
  it("buildServerSpawnEnv sets OPENCODE_DISABLE_EXTERNAL_SKILLS=true to prevent engine auto-load", async () => {
    const { buildServerSpawnEnv } = await import("../../src/server_auth");
    const env = buildServerSpawnEnv({
      amicoRunBinDir: "/ext/bin",
      configContent: "{}",
      serverPassword: "test",
    });
    expect(env.OPENCODE_DISABLE_EXTERNAL_SKILLS).toBe("true");
  });
});

describe("prepareOpencodeProject integration — user skills in Skill Index (issue #573)", () => {
  // Hermeticity: point problems + authoring at temp dirs
  const PROBLEMS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "usp-problems-"));
  const AUTHORING_TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usp-authoring-")), "authoring.json");
  let prevProblemsDir: string | undefined;
  let prevAuthoringFile: string | undefined;
  beforeAll(() => {
    prevProblemsDir = process.env.AMICODE_PROBLEMS_DIR;
    process.env.AMICODE_PROBLEMS_DIR = PROBLEMS_TMP;
    prevAuthoringFile = process.env.AMICO_AUTHORING_FILE;
    process.env.AMICO_AUTHORING_FILE = AUTHORING_TMP;
  });
  afterAll(() => {
    if (prevProblemsDir === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
    else process.env.AMICODE_PROBLEMS_DIR = prevProblemsDir;
    if (prevAuthoringFile === undefined) delete process.env.AMICO_AUTHORING_FILE;
    else process.env.AMICO_AUTHORING_FILE = prevAuthoringFile;
  });

  it("user skills from providers.json appear in the staged AGENTS.md Skill Index as (custom)", () => {
    const configDir = mkRoot();
    const skillDir = mkRoot();
    writeUserSkill(skillDir, "my-quantum-tool", "Quantum analysis toolkit");

    writeProvidersJson(configDir, [
      { id: "my-lab", type: "directory", path: skillDir, added: "2026-08-26T09:00:00Z" },
    ]);

    const proj = prepareOpencodeProject({
      agentsSrc: path.resolve(__dirname, "..", "..", "AGENTS.md"),
      templateSrc: path.resolve(__dirname, "..", "..", "templates", "solve_template.jl"),
      juliaProject: "/abs/julia",
      entitlementsDir: mkRoot(),
      skillRoots: [],
      skillLibraryRoots: [],
      vaultDir: "",
      userSkillProvidersPath: path.join(configDir, "skill-providers.json"),
    });

    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("my-quantum-tool");
    expect(agents).toContain("(custom)");
    expect(fs.existsSync(path.join(proj.skillsStageDir, "my-quantum-tool", "SKILL.md"))).toBe(true);
  });

  it("workspace skills appear labeled (workspace) in the Skill Index", () => {
    const wsSkillsDir = mkRoot();
    writeUserSkill(wsSkillsDir, "team-linter", "Team lint rules");

    const proj = prepareOpencodeProject({
      agentsSrc: path.resolve(__dirname, "..", "..", "AGENTS.md"),
      templateSrc: path.resolve(__dirname, "..", "..", "templates", "solve_template.jl"),
      juliaProject: "/abs/julia",
      entitlementsDir: mkRoot(),
      skillRoots: [],
      skillLibraryRoots: [],
      vaultDir: "",
      workspaceSkillsDir: wsSkillsDir,
    });

    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("team-linter");
    expect(agents).toContain("(workspace)");
  });
});

describe("discoverExternalSkillPaths (issue #573 — Autodiscover)", () => {
  it("returns directories that exist and contain at least one skill", () => {
    // Create a fake home with known engine paths
    const fakeHome = mkRoot();
    const claudeSkills = path.join(fakeHome, ".claude", "skills");
    fs.mkdirSync(claudeSkills, { recursive: true });
    writeUserSkill(claudeSkills, "my-claude-skill", "A Claude skill");

    const agentsSkills = path.join(fakeHome, ".agents", "skills");
    fs.mkdirSync(agentsSkills, { recursive: true });
    // Empty dir — no skills inside

    const discovered = discoverExternalSkillPaths(fakeHome);
    expect(discovered).toContain(claudeSkills);
    // Empty dir should NOT be returned
    expect(discovered).not.toContain(agentsSkills);
  });

  it("returns [] when no known paths exist", () => {
    const fakeHome = mkRoot(); // empty
    expect(discoverExternalSkillPaths(fakeHome)).toEqual([]);
  });

  it("filters out paths that are already registered as providers", () => {
    const fakeHome = mkRoot();
    const claudeSkills = path.join(fakeHome, ".claude", "skills");
    fs.mkdirSync(claudeSkills, { recursive: true });
    writeUserSkill(claudeSkills, "my-skill", "exists");

    const existingProviders: SkillProvider[] = [
      { id: "claude-skills", type: "directory", path: claudeSkills, added: "2026-08-26T09:00:00Z" },
    ];

    const discovered = discoverExternalSkillPaths(fakeHome, existingProviders);
    expect(discovered).toEqual([]);
  });
});

describe("resolveUrlProvider (issue #573 — URL providers with cache + offline fallback)", () => {
  it("reads skills from a populated cache directory (simulating a previous fetch)", () => {
    const cacheDir = mkRoot();
    writeUserSkill(cacheDir, "remote-tool", "Fetched from URL");

    const entries = resolveUrlProvider(cacheDir);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("remote-tool");
    expect(entries[0].source).toBe("custom");
    expect(entries[0].description).toBe("Fetched from URL");
  });

  it("returns [] when cache directory does not exist (URL unreachable, no prior cache)", () => {
    expect(resolveUrlProvider("/nonexistent/cache/dir")).toEqual([]);
  });

  it("returns [] when cache directory is empty (URL reachable but yielded nothing)", () => {
    const cacheDir = mkRoot();
    expect(resolveUrlProvider(cacheDir)).toEqual([]);
  });

  it("resolveUserSkills handles URL-type providers via their cache_path", () => {
    const configDir = mkRoot();
    const cacheDir = mkRoot();
    writeUserSkill(cacheDir, "cloud-lint", "Cloud linting rules");

    writeProvidersJson(configDir, [
      {
        id: "team-remote",
        type: "url",
        url: "https://lab.example.com/skills/",
        added: "2026-08-26T09:00:00Z",
        cache_path: cacheDir,
      },
    ]);

    const entries = resolveUserSkills(path.join(configDir, "skill-providers.json"));
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("cloud-lint");
    expect(entries[0].source).toBe("custom");
  });

  it("resolveUserSkills skips URL providers with missing cache gracefully", () => {
    const configDir = mkRoot();
    writeProvidersJson(configDir, [
      {
        id: "unreachable",
        type: "url",
        url: "https://down.example.com/skills/",
        added: "2026-08-26T09:00:00Z",
        cache_path: "/nonexistent/cache",
      },
    ]);

    const entries = resolveUserSkills(path.join(configDir, "skill-providers.json"));
    expect(entries).toEqual([]);
  });
});

describe("skill-providers.json CRUD (issue #573 — persistence for the Settings bridge)", () => {
  it("readSkillProviders returns the providers array from a valid file", () => {
    const configDir = mkRoot();
    writeProvidersJson(configDir, [
      { id: "my-lab", type: "directory", path: "/abs/skills", added: "2026-08-26T09:00:00Z" },
    ]);
    const config = readSkillProviders(path.join(configDir, "skill-providers.json"));
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0].id).toBe("my-lab");
    expect(config.version).toBe(1);
  });

  it("addSkillProvider appends to an existing file and removeSkillProvider deletes by id", () => {
    const configDir = mkRoot();
    const p = path.join(configDir, "skill-providers.json");

    // Add first provider (creates file)
    addSkillProvider(p, { id: "first", type: "directory", path: "/a", added: "2026-01-01T00:00:00Z" });
    expect(readSkillProviders(p).providers).toHaveLength(1);

    // Add second provider
    addSkillProvider(p, { id: "second", type: "directory", path: "/b", added: "2026-01-02T00:00:00Z" });
    expect(readSkillProviders(p).providers).toHaveLength(2);

    // Remove first
    removeSkillProvider(p, "first");
    const after = readSkillProviders(p);
    expect(after.providers).toHaveLength(1);
    expect(after.providers[0].id).toBe("second");
  });

  it("readSkillProviders returns empty config when file is missing", () => {
    const config = readSkillProviders("/nonexistent/skill-providers.json");
    expect(config).toEqual({ version: 1, providers: [] });
  });
});

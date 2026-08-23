import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { prepareOpencodeProject, buildOpencodeConfigContent, DEFAULT_SCORES_ROOT } from "../../src/opencode_config";

// Hermeticity: prepareOpencodeProject writes the plugin's manifest transport to
// the problems root, which defaults into $HOME — point it at a tmp dir for the run.
const PROBLEMS_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prep-problems-"));
const AUTHORING_TMP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prep-authoring-")), "authoring.json");
let prevProblemsDir: string | undefined;
let prevAuthoringFile: string | undefined;
beforeAll(() => {
  prevProblemsDir = process.env.AMICODE_PROBLEMS_DIR;
  process.env.AMICODE_PROBLEMS_DIR = PROBLEMS_TMP;
  prevAuthoringFile = process.env.AMICO_AUTHORING_FILE;
  process.env.AMICO_AUTHORING_FILE = AUTHORING_TMP; // isolate authoring.json from $HOME
});
afterAll(() => {
  if (prevProblemsDir === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
  else process.env.AMICODE_PROBLEMS_DIR = prevProblemsDir;
  if (prevAuthoringFile === undefined) delete process.env.AMICO_AUTHORING_FILE;
  else process.env.AMICO_AUTHORING_FILE = prevAuthoringFile;
});

const AGENTS_SRC = path.resolve(__dirname, "..", "..", "AGENTS.md");
const TEMPLATE_SRC = path.resolve(__dirname, "..", "..", "templates", "solve_template.jl");

function prep(overrides: Partial<Parameters<typeof prepareOpencodeProject>[0]> = {}) {
  return prepareOpencodeProject({
    agentsSrc: AGENTS_SRC,
    templateSrc: TEMPLATE_SRC,
    juliaProject: "/abs/julia",
    // isolate from any real ~/.amico/amicode/entitlements.toml on this machine
    entitlementsDir: fs.mkdtempSync(path.join(os.tmpdir(), "no-ents-")),
    // hermetic by default: no skill index unless a test opts in (otherwise these
    // default to the machine's ~/harmoniqs/packages + the in-repo/vault library
    // roots in DEFAULT_LIBRARY_ROOTS).
    skillRoots: [],
    skillLibraryRoots: [],
    // hermetic: personalization off (else auto-resolve hits the machine's real
    // personal vault and, absent a profile there, routes to the overture score —
    // these tests assert pure pulse-designer compilation). Onboarding routing
    // has its own suite (overture_routing.test.ts).
    vaultDir: "",
    ...overrides,
  });
}

// ── skill-index fixtures (spec §3) ──
function mkPkgSkillRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgskill-"));
  const d = path.join(root, "Piccolissimo.jl", "skills", "authoring");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(
    path.join(d, "SKILL.md"),
    "---\nname: piccolissimo-authoring\ndescription: author piccolissimo solves\nagents: [experimenter]\n---\n# body\n",
  );
  return root;
}
function mkLibRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libskill-"));
  // atoms is surface:public → staged; pr is surface:internal → the leak hazard
  // that surface-tag discovery must drop (spec-20260713-003804).
  const atoms = path.join(root, "atoms");
  fs.mkdirSync(atoms, { recursive: true });
  fs.writeFileSync(
    path.join(atoms, "SKILL.md"),
    "---\nname: atoms\ndescription: rydberg physics\nagents: [experimenter]\nsurface: public\n---\n# body\n",
  );
  const pr = path.join(root, "pr");
  fs.mkdirSync(pr, { recursive: true });
  fs.writeFileSync(
    path.join(pr, "SKILL.md"),
    "---\nname: pr\ndescription: open a PR\nagents: [engineer]\nsurface: internal\n---\n# body\n",
  );
  return root;
}
function entitledDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ents-"));
  fs.writeFileSync(path.join(d, "entitlements.toml"), 'codes = ["issimo"]\n');
  return d;
}

describe("prepareOpencodeProject × scores (spec §6)", () => {
  it("splices router + on-demand stub over the hardcoded interview section", () => {
    const proj = prep();
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Onset router");
    expect(agents).toContain("general-purpose autoresearch copilot"); // stub injected
    expect(agents).not.toContain("Stages, in order:"); // hardcoded body replaced
    expect(agents).toContain("## Identity"); // engine sections intact
    expect(agents).toContain("AMICODE_ITER"); // run-dir contract intact
    expect(agents).not.toMatch(/\{\{[A-Z_]+\}\}/); // substitution complete, incl. compiled content
  });

  it("writes the score_manifest.json plugin transport (projectDir record + problems-root copy)", () => {
    const proj = prep();
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("pulse-designer");
    expect(manifest.manifest.version).toBeGreaterThanOrEqual(1); // tracks SCORE.md frontmatter
    expect(manifest.project_dir).toBe(proj.projectDir);
    expect(manifest.score_dir).toBe(path.join(DEFAULT_SCORES_ROOT, "pulse-designer"));
    // the copy the Bun-side guard actually reads as its manifestDir (problems root)
    const guardCopy = JSON.parse(fs.readFileSync(path.join(PROBLEMS_TMP, "score_manifest.json"), "utf8"));
    expect(guardCopy.manifest.id).toBe("pulse-designer");
  });

  it("FALLBACK: a corrupt repertoire source (pack AND scores root) leaves the substituted AGENTS.md unchanged (never brick the boot)", () => {
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bad-scores-"));
    fs.mkdirSync(path.join(badRoot, "pulse-designer"));
    fs.writeFileSync(path.join(badRoot, "pulse-designer", "SCORE.md"), "---\ntype: junk\n---\n");
    // WS1 #369: the pack is the repertoire source — breaking only the legacy
    // scores root must NOT degrade boot (the pack still compiles). The
    // never-brick fallback holds when BOTH sources are broken.
    const packOnly = prep({ scoresRoot: badRoot });
    expect(fs.readFileSync(packOnly.agentsPath, "utf8")).toContain("## Onset router"); // pack carried the boot

    const proj = prep({ scoresRoot: badRoot, packsRoot: "/nonexistent/packs" });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("Stages, in order:"); // hardcoded interview kept as fallback
    expect(agents).not.toContain("## Onset router");
    expect(fs.existsSync(path.join(proj.projectDir, "score_manifest.json"))).toBe(false);
  });

  it("missing scores root behaves like fallback (no throw)", () => {
    const proj = prep({ scoresRoot: "/nonexistent/scores", packsRoot: "/nonexistent/packs" });
    expect(fs.readFileSync(proj.agentsPath, "utf8")).toContain("Stages, in order:");
  });

  it("writes authoring.json (spec C) — public allowlist, support set, existing bundled asset paths, tolerance", () => {
    prep(); // entitlementsDir is a fresh empty dir → public entitlements
    const authoring = JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8"));
    expect(authoring.schema_version).toBe(1);
    expect(authoring.allowlist).toEqual(["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"]);
    expect(authoring.support_set).toEqual(expect.arrayContaining(["JLD2", "CairoMakie", "TOML"]));
    expect(authoring.verify_tolerance).toBe(0.001); // spec-20260704-113005 §6 (resolves spec-C open q1)
    // the paths point at REAL bundled assets (Task 9 shipped them)
    expect(path.isAbsolute(authoring.registry) && fs.existsSync(authoring.registry)).toBe(true);
    expect(path.isAbsolute(authoring.exemplars) && fs.existsSync(authoring.exemplars)).toBe(true);
    expect(path.isAbsolute(authoring.verify_harness) && fs.existsSync(authoring.verify_harness)).toBe(true);
  });
});

describe("buildOpencodeConfigContent × scores", () => {
  it("grants external_directory on the scores root (templates + memory hooks)", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigContent("/abs/AGENTS.md", "/abs/templates/solve_template.jl", "/home/u/.amico/runs/default"),
    );
    expect(cfg.permission.external_directory[`${DEFAULT_SCORES_ROOT}/**`]).toBe("allow");
  });
  it("grant follows a custom scores root", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        "/abs/templates/solve_template.jl",
        "/home/u/.amico/runs/default",
        "/p/plugin.ts",
        "/custom/scores",
      ),
    );
    expect(cfg.permission.external_directory["/custom/scores/**"]).toBe("allow");
  });
  it("grants each indexed skill's OWN dir only — NOT a library root (spec §3, least-privilege)", () => {
    const cfg = JSON.parse(
      buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        "/abs/templates/solve_template.jl",
        "/home/u/.amico/runs/default",
        undefined,
        undefined,
        ["/lib/atoms/SKILL.md", "/pkgs/Piccolissimo.jl/skills/authoring/SKILL.md"],
      ),
    );
    expect(cfg.permission.external_directory["/lib/atoms/**"]).toBe("allow");
    expect(cfg.permission.external_directory["/pkgs/Piccolissimo.jl/skills/authoring/**"]).toBe("allow");
    expect(cfg.permission.external_directory["/lib/**"]).toBeUndefined(); // library root stays unreadable
  });
});

describe("prepareOpencodeProject × Armonia mount stack (spec-20260707-002846 C1–C4, three-state vaultDir)", () => {
  it('vaultDir "" → personalization disabled: empty mount stack, no mount/memory content, recovery pointer only', () => {
    const proj = prep({ vaultDir: "" });
    expect(proj.mounts).toEqual([]);
    expect(proj.vaultDir).toBe("");
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).not.toMatch(/^## Mount stack \(Armonia/m); // only prose mentions survive
    expect(agents).not.toMatch(/^## Memory index/m);
    expect(agents).toContain("amicode_context plugin"); // live-injection recovery pointer
  });

  it("vaultDir path → single forced personal mount at that path; returns mounts; sections live-injected, not spliced", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "forced-vault-"));
    fs.mkdirSync(path.join(vault, "amicode", "memory"), { recursive: true });
    fs.writeFileSync(
      path.join(vault, "amicode", "memory", "MEMORY.md"),
      "# Memory index\n- [user-role](user_role.md) — Aaron is CEO\n",
    );
    const proj = prep({ vaultDir: vault });
    expect(proj.mounts).toHaveLength(1);
    expect(proj.mounts[0]).toMatchObject({ kind: "personal", path: vault, writable: true });
    expect(proj.vaultDir).toBe(vault); // vaultDir === personalMount path
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    // The mount stack + memory index are injected per-prompt by the
    // amicode_context plugin (their live builders are pinned in
    // test/stack_state.test.ts) — the prepared file must NOT carry them as
    // sections (only the recovery pointer's prose mentions may appear).
    expect(agents).not.toMatch(/^## Mount stack \(Armonia/m);
    expect(agents).not.toMatch(/^## Memory index/m);
    expect(agents).not.toContain("- [user-role](user_role.md) — Aaron is CEO");
    expect(agents).toContain("amicode_context plugin"); // recovery pointer present
  });

  it("vaultDir undefined → auto-resolves the full stack from ~/.amico/vaults; vaultDir === personal mount", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    const vaults = path.join(home, ".amico", "vaults");
    const personal = path.join(vaults, "armonia-me");
    fs.mkdirSync(path.join(personal, "amicode"), { recursive: true });
    fs.writeFileSync(path.join(personal, ".amico-vault.toml"), 'kind = "personal"\nname = "armonia-me"\n');
    // a PROFILE.md suppresses the overture routing predicate (keeps this a plain
    // pulse-designer compile — onboarding routing has its own suite).
    fs.writeFileSync(path.join(personal, "amicode", "PROFILE.md"), "# Profile — A\n- Role: CEO\n");
    const team = path.join(vaults, "armonissima");
    fs.mkdirSync(team, { recursive: true });
    fs.writeFileSync(path.join(team, ".amico-vault.toml"), 'kind = "team"\nname = "armonissima"\n');

    const prevHome = process.env.HOME;
    const prevProfile = process.env.AMICO_PROFILE_FILE;
    process.env.HOME = home;
    process.env.AMICO_PROFILE_FILE = path.join(home, "no-profile.json"); // wizard gate off
    try {
      const proj = prep({ vaultDir: undefined });
      expect(proj.mounts.map((m) => m.name)).toEqual(["armonia-me", "armonissima"]); // kind-rank: personal(0) < team(4)
      expect(proj.vaultDir).toBe(personal);
      const agents = fs.readFileSync(proj.agentsPath, "utf8");
      // Sections live-injected (see test/stack_state.test.ts), not spliced:
      expect(agents).not.toMatch(/^## Mount stack \(Armonia/m);
      expect(agents).not.toContain(`- armonia-me · kind=personal · rw · ${personal}`);
      expect(agents).toContain("amicode_context plugin"); // recovery pointer present
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.AMICO_PROFILE_FILE;
      else process.env.AMICO_PROFILE_FILE = prevProfile;
    }
  });
});

describe("prepareOpencodeProject × skill index (spec §3, Rev 2 — dual-source)", () => {
  // NOTE: presence/absence is asserted on the STRUCTURED authoring.json skills
  // array (source/name/package), not raw prompt text — the author-first prose
  // now mentions "atoms" and "Piccolissimo/piccolissimo-authoring" as routing
  // examples, so whole-prompt string matching can't distinguish the index.
  type SkillRec = { source: "library" | "package"; package?: string; name: string };
  const readSkills = (): SkillRec[] => JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8")).skills;
  const libNames = (s: SkillRec[]) => s.filter((e) => e.source === "library").map((e) => e.name);
  const pkgNames = (s: SkillRec[]) => s.filter((e) => e.source === "package").map((e) => e.package);

  it("entitled: indexes platform (public) + package (gated), platform first + authoring.json records both", () => {
    const proj = prep({
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      skillLibraryRoots: [mkLibRoot()],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Skill index");
    // Pulse-designer content no longer compiled into session — verify skill index works independently
    expect(proj.skillPaths.some((p) => p.endsWith("/atoms/SKILL.md"))).toBe(true);
    const skills = readSkills();
    expect(libNames(skills)).toContain("atoms");
    expect(libNames(skills)).not.toContain("pr"); // surface:internal never stages (leak guard, §4.5)
    expect(pkgNames(skills)).toContain("Piccolissimo");
    expect(skills[0].source).toBe("library"); // platform entries first (spec §3)
  });

  // Two-tier surfaces (ADR-0003, amicode#242 AC1): with the private plugin
  // checkout present (a typed root admitting internal), a session's skill index
  // includes surface:internal skills AND stages them into the session skill dir.
  it("typed checkout root: internal library skills index AND stage into the session skill dir", () => {
    const proj = prep({
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      skillLibraryRoots: [{ path: mkLibRoot(), surfaces: ["public", "internal"] }],
    });
    const skills = readSkills();
    expect(libNames(skills)).toContain("atoms");
    expect(libNames(skills)).toContain("pr"); // internal, admitted from the checkout root
    // ...and staged into the per-session dir opencode actually loads (skills.paths)
    expect(fs.existsSync(path.join(proj.skillsStageDir, "pr", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(proj.skillsStageDir, "atoms", "SKILL.md"))).toBe(true);
  });

  it("skill index survives a score-compile failure (independent splice, spec §3)", () => {
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bad-scores-"));
    fs.mkdirSync(path.join(badRoot, "pulse-designer"));
    fs.writeFileSync(path.join(badRoot, "pulse-designer", "SCORE.md"), "---\ntype: junk\n---\n");
    // keep a VALID entitlements table in the scores root so the package allowlist
    // still resolves — independence is from score COMPILE failure, not a missing root.
    fs.copyFileSync(path.join(DEFAULT_SCORES_ROOT, "entitlements.toml"), path.join(badRoot, "entitlements.toml"));
    const proj = prep({
      scoresRoot: badRoot,
      packsRoot: "/nonexistent/packs", // WS1: break the pack source too — independence is from repertoire failure
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      skillLibraryRoots: [mkLibRoot()],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("Stages, in order:"); // score compile failed → fallback interview
    expect(agents).toContain("## Skill index"); // yet the skill index is STILL present
    const skills = readSkills();
    expect(libNames(skills)).toContain("atoms");
    expect(pkgNames(skills)).toContain("Piccolissimo");
  });

  it("unentitled: platform skills still index (public); package skills do not (acceptance D, prep half)", () => {
    const proj = prep({
      entitlementsDir: fs.mkdtempSync(path.join(os.tmpdir(), "no-ents-")), // public
      skillRoots: [mkPkgSkillRoot()],
      skillLibraryRoots: [mkLibRoot()],
    });
    expect(fs.readFileSync(proj.agentsPath, "utf8")).toContain("## Skill index");
    const authoring = JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8"));
    const skills: SkillRec[] = authoring.skills;
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((e) => e.source === "library")).toBe(true); // platform only, no package
    expect(libNames(skills)).toContain("atoms");
    expect(libNames(skills)).not.toContain("pr"); // surface:internal never stages (leak guard, §4.5)
    expect(authoring.allowlist).not.toContain("Piccolissimo");
  });

  it("missing library root: platform absent, package still indexed, no throw", () => {
    const proj = prep({
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      skillLibraryRoots: ["/nonexistent-lib"],
    });
    expect(fs.readFileSync(proj.agentsPath, "utf8")).toContain("## Skill index");
    const skills = readSkills();
    expect(skills.every((e) => e.source === "package")).toBe(true); // no platform entries
    expect(pkgNames(skills)).toContain("Piccolissimo");
  });
});

// ── pack-manifest boot selection (WS1 #369) ──
// The repertoire loads through the default pack's manifest: a fixture pack
// root (via packsRoot) with a distinct onboarding primary DRIVES the compiled
// AGENTS.md and the manifest transport — no loader code per pack.
describe("prepareOpencodeProject — pack-manifest repertoire (WS1)", () => {
  const SCORE_MD = `---
type: score
schema_version: 1
id: custom-interview
version: 1
derived_from: null
name: "Custom"
outcome: "A custom outcome"
audience: [testers]
entitlements: []
stages:
  - id: only
    questions:
      - {id: q1, prompt: "Pick?", choices: [a, b], default: a}
---

PACKDRIVEN-BODY-MARKER.
`;
  function fixturePacksRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "packs-prep-"));
    const dir = path.join(root, "quantum-control");
    fs.mkdirSync(path.join(dir, "scores", "custom"), { recursive: true });
    fs.mkdirSync(path.join(dir, "gates"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scores", "custom", "SCORE.md"), SCORE_MD);
    fs.writeFileSync(path.join(dir, "gates", "verify.sh"), "#!/bin/sh\nexit 0\n");
    // the load-time corrector contract (#369): coverage key = corrector.paths string
    const gateSha = createHash("sha256").update(fs.readFileSync(path.join(dir, "gates", "verify.sh"))).digest("hex");
    fs.writeFileSync(
      path.join(dir, "gates", "integrity.toml"),
      `[files]\n"gates/verify.sh" = "${gateSha}"\n`,
    );
    fs.writeFileSync(
      path.join(dir, "PACK.toml"),
      [
        'schema_version = "1"',
        'id = "quantum-control"',
        'name = "Quantum Control"',
        "version = 1",
        'scores = ["scores/custom"]',
        "[onboarding]",
        'primary = "custom-interview"',
        "[corrector]",
        'name = "fixture gate"',
        'paths = ["gates/verify.sh"]',
        'integrity = "gates/integrity.toml"',
      ].join("\n") + "\n",
    );
    return root;
  }

  it("the default pack's manifest drives the manifest transport", () => {
    const packsRoot = fixturePacksRoot();
    const proj = prep({ packsRoot });
    const md = fs.readFileSync(proj.agentsPath, "utf8");
    expect(md).toContain("## Onset router"); // router is always spliced
    expect(md).toContain("general-purpose autoresearch copilot"); // stub present
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("custom-interview");
    expect(manifest.score_dir).toBe(path.join(packsRoot, "quantum-control", "scores", "custom"));
  });

  it("missing packs root falls back to the bundled scores repertoire exactly as today", () => {
    const proj = prep({ packsRoot: "/nonexistent/packs" });
    const md = fs.readFileSync(proj.agentsPath, "utf8");
    // Today: on-demand stub, no compiled score content
    expect(md).toContain("## Onset router");
    expect(md).toContain("general-purpose autoresearch copilot");
  });
});

// ── studio-manifest root adoption (#402) ──
// The ladder: hermetic env override → MANIFEST → legacy ~/.amico. Absent
// manifest = exactly today's behavior; the hermetic escapes still win.
describe("prepareOpencodeProject — studio manifest roots (#402)", () => {
  function studioCfg(root: string, over: Record<string, string> = {}): string {
    const file = path.join(root, "config.toml");
    const lines = [`schema_version = "1"`, `studio_root = "${path.join(root, "studio")}"`];
    for (const [k, v] of Object.entries(over)) lines.push(`${k} = "${v}"`);
    fs.writeFileSync(file, lines.join("\n") + "\n");
    return file;
  }

  it("a manifest redirects the problems root (grants + manifest transport)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-studio-"));
    const cfg = studioCfg(root, { problems: path.join(root, "elsewhere", "problems") });
    const prevProblems = process.env.AMICODE_PROBLEMS_DIR; // the suite sets it in beforeAll — env must NOT mask the manifest here
    delete process.env.AMICODE_PROBLEMS_DIR;
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    try {
      prep({});
      const cfgJson = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", "/abs/tpl", "/runs"));
      const grant = Object.keys(cfgJson.permission.external_directory).find((k) => k.includes("problems"));
      expect(grant).toContain(path.join(root, "elsewhere", "problems"));
      expect(fs.existsSync(path.join(root, "elsewhere", "problems", "score_manifest.json"))).toBe(true);
    } finally {
      delete process.env.AMICODE_STUDIO_CONFIG;
      if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
      else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
    }
  });

  it("AMICODE_PROBLEMS_DIR still outranks the manifest (hermetic escape)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-studio-"));
    const cfg = studioCfg(root, { problems: path.join(root, "manifest-problems") });
    const envDir = path.join(root, "env-problems");
    process.env.AMICODE_STUDIO_CONFIG = cfg;
    process.env.AMICODE_PROBLEMS_DIR = envDir;
    try {
      prep({});
      const cfgJson = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", "/abs/tpl", "/runs"));
      const grant = Object.keys(cfgJson.permission.external_directory).find((k) => k.includes("problems"));
      expect(grant).toContain("env-problems");
    } finally {
      delete process.env.AMICODE_STUDIO_CONFIG;
      delete process.env.AMICODE_PROBLEMS_DIR; // the suite's beforeAll value is restored by its own afterAll contract
    }
  });

  it("absent manifest = legacy problems root exactly (parity)", () => {
    const prevProblems = process.env.AMICODE_PROBLEMS_DIR;
    delete process.env.AMICODE_PROBLEMS_DIR;
    process.env.AMICODE_STUDIO_CONFIG = path.join(os.tmpdir(), `no-such-studio-${Date.now()}.toml`);
    try {
      prep({});
      const cfgJson = JSON.parse(buildOpencodeConfigContent("/abs/AGENTS.md", "/abs/tpl", "/runs"));
      const grant = Object.keys(cfgJson.permission.external_directory).find((k) => k.includes("problems"));
      expect(grant).toContain(path.join(os.homedir(), ".amico", "problems"));
    } finally {
      delete process.env.AMICODE_STUDIO_CONFIG;
      if (prevProblems === undefined) delete process.env.AMICODE_PROBLEMS_DIR;
      else process.env.AMICODE_PROBLEMS_DIR = prevProblems;
    }
  });
});

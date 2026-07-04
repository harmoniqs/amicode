import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
    // default to the machine's ~/harmoniqs/{packages,amico-plugin/skills}).
    skillRoots: [],
    platformSkills: [],
    skillLibraryRoots: [],
    ...overrides,
  });
}

// ── skill-index fixtures (spec §3) ──
function mkPkgSkillRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pkgskill-"));
  const d = path.join(root, "Piccolissimo.jl", "skills", "authoring");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"),
    "---\nname: piccolissimo-authoring\ndescription: author piccolissimo solves\nagents: [experimenter]\n---\n# body\n");
  return root;
}
function mkLibRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "libskill-"));
  const d = path.join(root, "atoms");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"),
    "---\nname: atoms\ndescription: rydberg physics\nagents: [experimenter]\n---\n# body\n");
  return root;
}
function entitledDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ents-"));
  fs.writeFileSync(path.join(d, "entitlements.toml"), 'codes = ["issimo"]\n');
  return d;
}

describe("prepareOpencodeProject × scores (spec §6)", () => {
  it("splices router + compiled score #0 over the hardcoded interview section", () => {
    const proj = prep();
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Onset router");
    expect(agents).toMatch(/Compiled from score `pulse-designer` v\d+/); // version-agnostic: content bumps must not red this suite
    expect(agents).toContain("## Pulse-designer interview"); // heading preserved for the agent prompt
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
    // the compiled banner and the manifest must agree on the version (no drift)
    const agentsForVersion = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agentsForVersion).toContain(`Compiled from score \`pulse-designer\` v${manifest.manifest.version}`);
    expect(manifest.project_dir).toBe(proj.projectDir);
    expect(manifest.score_dir).toBe(path.join(DEFAULT_SCORES_ROOT, "pulse-designer"));
    // the copy the Bun-side guard actually reads as its manifestDir (problems root)
    const guardCopy = JSON.parse(fs.readFileSync(path.join(PROBLEMS_TMP, "score_manifest.json"), "utf8"));
    expect(guardCopy.manifest.id).toBe("pulse-designer");
  });

  it("FALLBACK: a corrupt scores root leaves the substituted AGENTS.md unchanged (never brick the boot)", () => {
    const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bad-scores-"));
    fs.mkdirSync(path.join(badRoot, "pulse-designer"));
    fs.writeFileSync(path.join(badRoot, "pulse-designer", "SCORE.md"), "---\ntype: junk\n---\n");
    const proj = prep({ scoresRoot: badRoot });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("Stages, in order:"); // hardcoded interview kept as fallback
    expect(agents).not.toContain("## Onset router");
    expect(fs.existsSync(path.join(proj.projectDir, "score_manifest.json"))).toBe(false);
  });

  it("missing scores root behaves like fallback (no throw)", () => {
    const proj = prep({ scoresRoot: "/nonexistent/scores" });
    expect(fs.readFileSync(proj.agentsPath, "utf8")).toContain("Stages, in order:");
  });

  it("writes authoring.json (spec C) — public allowlist, support set, existing bundled asset paths, tolerance", () => {
    prep(); // entitlementsDir is a fresh empty dir → public entitlements
    const authoring = JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8"));
    expect(authoring.schema_version).toBe(1);
    expect(authoring.allowlist).toEqual(["Piccolo", "Legato", "Intonato", "NamedTrajectories", "DirectTrajOpt"]);
    expect(authoring.support_set).toEqual(expect.arrayContaining(["JLD2", "CairoMakie", "TOML"]));
    expect(authoring.verify_tolerance).toBe(0.001);   // spec-20260704-113005 §6 (resolves spec-C open q1)
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
        "/abs/AGENTS.md", "/abs/templates/solve_template.jl", "/home/u/.amico/runs/default",
        undefined, undefined,
        ["/lib/atoms/SKILL.md", "/pkgs/Piccolissimo.jl/skills/authoring/SKILL.md"],
      ),
    );
    expect(cfg.permission.external_directory["/lib/atoms/**"]).toBe("allow");
    expect(cfg.permission.external_directory["/pkgs/Piccolissimo.jl/skills/authoring/**"]).toBe("allow");
    expect(cfg.permission.external_directory["/lib/**"]).toBeUndefined(); // library root stays unreadable
  });
});

describe("prepareOpencodeProject × skill index (spec §3, Rev 2 — dual-source)", () => {
  it("entitled: indexes platform (public) + package (gated), platform first + authoring.json records both", () => {
    const proj = prep({
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      platformSkills: ["atoms"],
      skillLibraryRoots: [mkLibRoot()],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Skill index");
    expect(agents).toContain("atoms");
    expect(agents).toContain("Piccolissimo/piccolissimo-authoring");
    expect(agents.indexOf("atoms")).toBeLessThan(agents.indexOf("Piccolissimo/piccolissimo-authoring"));
    expect(proj.skillPaths.some((p) => p.endsWith("/atoms/SKILL.md"))).toBe(true);
    const authoring = JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8"));
    const sources = authoring.skills.map((s: { source: string }) => s.source);
    expect(sources).toContain("library");
    expect(sources).toContain("package");
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
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      platformSkills: ["atoms"],
      skillLibraryRoots: [mkLibRoot()],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("Stages, in order:"); // score compile failed → fallback interview
    expect(agents).toContain("## Skill index");     // yet the skill index is STILL present
    expect(agents).toContain("atoms");
    expect(agents).toContain("Piccolissimo/piccolissimo-authoring");
  });

  it("unentitled: platform skills still index (public); package skills do not (acceptance D, prep half)", () => {
    const proj = prep({
      entitlementsDir: fs.mkdtempSync(path.join(os.tmpdir(), "no-ents-")), // public
      skillRoots: [mkPkgSkillRoot()],
      platformSkills: ["atoms"],
      skillLibraryRoots: [mkLibRoot()],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Skill index");
    expect(agents).toContain("atoms");
    expect(agents).not.toContain("Piccolissimo/piccolissimo-authoring");
    const authoring = JSON.parse(fs.readFileSync(AUTHORING_TMP, "utf8"));
    expect(authoring.skills.every((s: { source: string }) => s.source === "library")).toBe(true);
    expect(authoring.allowlist).not.toContain("Piccolissimo");
  });

  it("missing library root: platform absent, package still indexed, no throw", () => {
    const proj = prep({
      entitlementsDir: entitledDir(),
      skillRoots: [mkPkgSkillRoot()],
      platformSkills: ["atoms"],
      skillLibraryRoots: ["/nonexistent-lib"],
    });
    const agents = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agents).toContain("## Skill index");
    expect(agents).toContain("Piccolissimo/piccolissimo-authoring");
    expect(agents).not.toContain("atoms");
  });
});

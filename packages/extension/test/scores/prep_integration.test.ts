import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareOpencodeProject, buildOpencodeConfigContent, DEFAULT_SCORES_ROOT } from "../../src/opencode_config";

// Hermeticity: prepareOpencodeProject writes the plugin's manifest transport to
// entitiesDir(), which defaults into $HOME — point it at a tmp dir for the test run.
const ENTITIES_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "prep-entities-"));
let prevEntitiesDir: string | undefined;
beforeAll(() => {
  prevEntitiesDir = process.env.AMICODE_ENTITIES_DIR;
  process.env.AMICODE_ENTITIES_DIR = ENTITIES_TMP;
});
afterAll(() => {
  if (prevEntitiesDir === undefined) delete process.env.AMICODE_ENTITIES_DIR;
  else process.env.AMICODE_ENTITIES_DIR = prevEntitiesDir;
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
    ...overrides,
  });
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

  it("writes the score_manifest.json plugin transport (projectDir record + entitiesDir copy)", () => {
    const proj = prep();
    const manifest = JSON.parse(fs.readFileSync(path.join(proj.projectDir, "score_manifest.json"), "utf8"));
    expect(manifest.manifest.id).toBe("pulse-designer");
    expect(manifest.manifest.version).toBeGreaterThanOrEqual(1); // tracks SCORE.md frontmatter
    // the compiled banner and the manifest must agree on the version (no drift)
    const agentsForVersion = fs.readFileSync(proj.agentsPath, "utf8");
    expect(agentsForVersion).toContain(`Compiled from score \`pulse-designer\` v${manifest.manifest.version}`);
    expect(manifest.project_dir).toBe(proj.projectDir);
    expect(manifest.score_dir).toBe(path.join(DEFAULT_SCORES_ROOT, "pulse-designer"));
    // the copy the Bun-side guard actually reads (entitiesDir contract)
    const guardCopy = JSON.parse(fs.readFileSync(path.join(ENTITIES_TMP, "score_manifest.json"), "utf8"));
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
});

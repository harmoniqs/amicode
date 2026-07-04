import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import { loadRepertoire } from "./scores/loader";
import { readLocalEntitlements, filterRepertoire, packageAllowlist } from "./scores/entitlements";
import { buildRouterSection } from "./scores/router";
import { compileScore, spliceIntoAgentsMd } from "./scores/compiler";

// ============================================================================
// Prepare a per-session opencode project directory.
//
// opencode invokes amico-run via its built-in `bash` tool — no MCP, no
// callback HTTP. The amico solve workflow (AGENTS.md) reaches the agent via
// opencode's `instructions` config (see buildOpencodeConfigContent + the
// OPENCODE_CONFIG_CONTENT spawn env in extension.ts), which is loaded for
// every session regardless of the session's working directory. opencode's web
// UI runs the session in the VS Code workspace folder, NOT this temp dir, so
// the temp dir exists only to hold the substituted AGENTS.md — the absolute
// path `instructions` points at. PATH augmentation (so `amico-run` resolves)
// happens at spawn time in extension.ts.
//
// LIFETIME INVARIANT: opencode reads the `instructions` file lazily, per
// message — and a missing file fails *silently* (empty instruction set →
// regression to vanilla opencode). The temp dir is created at activate() and
// is never cleaned by the extension, so it persists for the server's lifetime.
// Do NOT add temp-dir cleanup without moving AGENTS.md somewhere equally durable.
// ============================================================================

/** Resolve the Julia project (--project) the agent should pass. A configured,
 *  non-empty value wins (trimmed); otherwise default to the β.4-provisioned
 *  project at ~/.amico/julia. (The VS Code config default is "", which `??`
 *  does NOT catch — hence an explicit empty check rather than a nullish one.)
 *  A leading `~` is expanded, mirroring resolveRunsRoot — so `~/foo` doesn't
 *  reach `--project` literally. */
export function resolveJuliaProject(configValue: string): string {
  const v = configValue.trim();
  if (v === "") return path.join(os.homedir(), ".amico", "julia");
  if (v === "~") return os.homedir();
  if (v.startsWith("~/")) return path.join(os.homedir(), v.slice(2));
  return v;
}

/** Build the OPENCODE_CONFIG_CONTENT value: a config object that injects the
 *  amico AGENTS.md as a top-level `instructions` entry AND auto-allows the
 *  permissions the solve workflow needs. opencode MERGES this over the user's
 *  global config (model/provider preserved) for every session, independent of
 *  the session's working directory.
 *
 *  Why the `permission` block: the agent reads the bundled template at an
 *  absolute path *outside* the session's working dir and writes scratch to
 *  /tmp/amicode-work, then runs amico-run via bash. opencode defaults
 *  `external_directory` to "ask" — which, with no interactive approver, makes
 *  the turn hang forever (headless) and nags the user on every solve (GUI).
 *
 *  `external_directory` is the only load-bearing line, and it's SCOPED (least
 *  privilege) to the three roots the agent's file tools actually touch:
 *    - the bundled templates dir — the agent READS the solve template there;
 *    - /tmp/amicode-work — the scratch dir it WRITES solve.jl into;
 *    - the runs root — AGENTS.md tells the agent to READ a run's
 *      FINISHED/result.toml for results and run.log for failure tracebacks;
 *      without the grant each such read is an "ask" prompt (one per solve,
 *      worse on failures — the nag the 2026-07-03 live test hit).
 *  (amico-run's own writes to ~/.amico/runs|julia are the subprocess's, not the
 *  agent's file tools, so they need no grant — only the agent's read-backs do.)
 *  The path-scoped object form is accepted by opencode 1.17.3 (verified via
 *  `opencode debug config`).
 *
 *  Merge safety: opencode DEEP-merges this `permission` object over the user's
 *  global config — verified against 1.17.3 (a global `permission.doom_loop`
 *  survives alongside our injected keys; see opencode_config.test.ts). So we ADD
 *  keys, we don't replace the user's permission settings.
 *
 *  `bash`/`edit` are left at "allow" (both already default to allow; bash runs
 *  the compound `mkdir … && nohup amico-run …` launch, not worth scoping).
 *  `webfetch` is intentionally NOT set — the solve flow never fetches a URL.
 *
 *  L0 pulse-designer additions (night build 2026-07-03; registration mechanism
 *  probed on the stock vendored 1.17.3 — see opencode-plugin/amicode_tools.ts
 *  header for the full T8 decision record):
 *    - `plugin: [<abs path to opencode-plugin/amicode_tools.ts>]` — the
 *      amicode_* tool pack, executed by opencode's embedded Bun runtime (it is
 *      NOT part of the extension bundle). The path defaults from __dirname
 *      (works from both src/ under vitest and dist/ in the cjs bundle — the
 *      plugin dir is a sibling of both). TODO(follow-up): extension.ts should
 *      pass this explicitly once .vsix packaging of opencode-plugin/ is
 *      verified; the default keeps existing call sites working unchanged.
 *    - `agent: {"pulse-designer": …}` — the interview agent; its prompt defers
 *      to the "Pulse-designer interview" section of the injected AGENTS.md so
 *      the interview script lives in ONE place.
 *    - an `external_directory` grant for the Problem-workspaces root, so the
 *      AGENT's file tools can read back system/formulation/run/event TOML the
 *      plugin wrote (the plugin's own fs writes are host-process calls and need
 *      no grant). Must stay derivation-identical to problemsDir() in
 *      opencode-plugin/problems.ts. */
const SCRATCH_DIR = "/tmp/amicode-work";   // matches AGENTS.md step 2/3

/** Root of the amicode_* Problem workspaces — MUST match problemsDir() in
 *  opencode-plugin/problems.ts ($AMICODE_PROBLEMS_DIR override included, so the
 *  permission grant AND the score-manifest transport follow the plugin wherever
 *  it is pointed). */
function problemsRoot(): string {
  const env = process.env.AMICODE_PROBLEMS_DIR;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "problems");
}

/** Default location of the amicode_* opencode plugin: a sibling directory of
 *  both src/ (vitest) and dist/ (the bundled extension), so __dirname/.. works
 *  from either. */
const DEFAULT_PLUGIN_PATH = path.resolve(__dirname, "..", "opencode-plugin", "amicode_tools.ts");

/** Default scores repertoire root — same sibling-of-src-and-dist trick as the
 *  plugin path. Holds SCORE.md manifests, score-local templates, memory hooks. */
export const DEFAULT_SCORES_ROOT = path.resolve(__dirname, "..", "scores");

/** Bundled spec-C authoring assets (absolute), resolved relative to this module.
 *  At runtime __dirname is the extension's dist/src dir; the assets ship one
 *  level up under templates/, exemplars/, julia/. */
export const AUTHORING_ASSETS = {
  registry: path.resolve(__dirname, "..", "templates", "registry.toml"),
  exemplars: path.resolve(__dirname, "..", "exemplars", "index.json"),
  verifyHarness: path.resolve(__dirname, "..", "julia", "verify_rollout.jl"),
};

/** The entitlement→package table ships with the scores repertoire (spec C put
 *  it in scores/entitlements.toml). NOT registry.toml — that file has no
 *  [packages] table (the §3 mis-wire this fixes: reading registry meant holding
 *  `issimo` never allowlisted Piccolissimo in production). */
export function entitlementsTablePath(scoresRoot: string = DEFAULT_SCORES_ROOT): string {
  return path.join(scoresRoot, "entitlements.toml");
}

/** Where amico-run reads the authoring config (spec C seam). $AMICO_AUTHORING_FILE
 *  overrides (tests + parity with amico-run's own reader). */
export function authoringFilePath(): string {
  const env = process.env.AMICO_AUTHORING_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "authoring", "authoring.json");
}

/** Assemble + write authoring.json at session prep. Reads verify_tolerance from
 *  the bundled registry.toml (falls back to 0.01). Never throws — a write
 *  failure logs and leaves amico-run to use its built-in conservative defaults. */
export function writeAuthoringConfig(entitlementsDir: string, scoresRoot: string = DEFAULT_SCORES_ROOT): void {
  try {
    const ents = readLocalEntitlements(entitlementsDir);
    const registry = AUTHORING_ASSETS.registry;
    const allowlist = packageAllowlist(entitlementsTablePath(scoresRoot), ents.entitlements);
    let tolerance = 0.01;
    let support: string[] = ["JLD2", "CairoMakie", "Makie", "TOML", "Printf", "LinearAlgebra", "Random", "Statistics", "SparseArrays"];
    try {
      const reg = parseToml(fs.readFileSync(registry, "utf8")) as { verify_tolerance?: number; support?: { packages?: string[] } };
      if (typeof reg.verify_tolerance === "number") tolerance = reg.verify_tolerance;
      if (Array.isArray(reg.support?.packages)) support = reg.support!.packages!;
    } catch { /* keep defaults */ }
    const file = authoringFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          schema_version: 1,
          allowlist,
          support_set: support,
          registry,
          exemplars: AUTHORING_ASSETS.exemplars,
          verify_harness: AUTHORING_ASSETS.verifyHarness,
          verify_tolerance: tolerance,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (e) {
    console.warn(`amicode: failed to write authoring.json (amico-run will use built-in defaults): ${e}`);
  }
}

export function buildOpencodeConfigContent(
  agentsPath: string,
  templatePath: string,
  runsRoot: string,
  pluginPath: string = DEFAULT_PLUGIN_PATH,
  scoresRoot: string = DEFAULT_SCORES_ROOT,
): string {
  const templatesDir = path.dirname(templatePath);
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    instructions: [agentsPath],
    plugin: [pluginPath],
    agent: {
      "pulse-designer": {
        description: "Guided quantum pulse design interview",
        prompt:
          "You are Amico's pulse-designer. Follow the 'Pulse-designer interview' section of " +
          "the project instructions exactly: one question at a time, record each stage with " +
          "the amicode_* tools, and use the solve workflow for launches.",
      },
    },
    permission: {
      bash: "allow",
      edit: "allow",
      external_directory: {
        [templatePath]: "allow",            // exact template file the agent reads
        [`${templatesDir}/**`]: "allow",    // (belt-and-suspenders for the dir)
        [`${SCRATCH_DIR}/**`]: "allow",     // solve.jl + solve.log it writes
        [`/private${SCRATCH_DIR}/**`]: "allow",   // macOS: /tmp → /private/tmp
        [`${runsRoot}/**`]: "allow",        // run read-backs: FINISHED/result.toml/run.log
        [`${problemsRoot()}/**`]: "allow",   // amicode_* problem workspaces the agent reads back
        [`${scoresRoot}/**`]: "allow",      // score templates + memory hooks ([Why?]) the agent reads
      },
    },
  });
}


export interface OpencodeConfigOptions {
  /** Absolute path to packages/extension/AGENTS.md to substitute + write into the project dir. */
  agentsSrc: string;
  /** Absolute path to the vetted solve_template.jl. Substituted into AGENTS.md
   *  as {{TEMPLATE_PATH}} (the agent reads it there; it is not copied). */
  templateSrc: string;
  /** Julia project (--project) the agent should use; already resolved (see
   *  resolveJuliaProject). Substituted into AGENTS.md as {{JULIA_PROJECT}}. */
  juliaProject: string | undefined;
  /** Scores repertoire root (SCORE.md manifests). Default: the bundled scores/. */
  scoresRoot?: string;
  /** Dir holding the user's entitlements.toml (access-code stub). Default: ~/.amico/amicode. */
  entitlementsDir?: string;
}

export interface OpencodeProject {
  projectDir: string;
  agentsPath: string;
  /** The vetted template the agent reads — the bundled source (absolute), not a copy. */
  templatePath: string;
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "amicode-v2-"));

  // AGENTS.md: read → substitute {{JULIA_PROJECT}} + {{TEMPLATE_PATH}} → write.
  // This file is the target of opencode's `instructions` config (absolute path).
  const agentsPath = path.join(projectDir, "AGENTS.md");
  const raw = fs.existsSync(opts.agentsSrc)
    ? fs.readFileSync(opts.agentsSrc, "utf8")
    : "# Amicode\nRead the template at {{TEMPLATE_PATH}}, fill params, run `amico-run <script>`.\n";
  const filled = raw
    .replaceAll("{{JULIA_PROJECT}}", opts.juliaProject ?? resolveJuliaProject(""))
    .replaceAll("{{TEMPLATE_PATH}}", opts.templateSrc);

  // Score runtime ("data-defined, prompt-executed", scores spec §6): compile the
  // selected score (v1: boot-time selection of score #0, pulse-designer) over the
  // hardcoded interview section, prefix the onset router, and drop the manifest
  // transport for the Bun-side plugin. FALLBACK: any failure leaves the substituted
  // AGENTS.md exactly as before — the hardcoded section IS the fallback content;
  // score trouble must never brick the boot.
  let finalContent = filled;
  try {
    const scoresRoot = opts.scoresRoot ?? DEFAULT_SCORES_ROOT;
    const load = loadRepertoire(scoresRoot);
    const ents = readLocalEntitlements(opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode"));
    const visible = filterRepertoire(load.scores, ents.entitlements);
    const score0 = visible.find((s) => s.manifest.id === "pulse-designer");
    if (score0) {
      finalContent = spliceIntoAgentsMd(filled, buildRouterSection(visible), compileScore(score0));
      // Manifest transport: the opencode plugin (Bun runtime, separate process tree)
      // reads score_manifest.json from the problems ROOT — that is the guard's
      // session-scoped manifestDir (per-problem interview state lives in each
      // workspace; see opencode-plugin/score_guard.ts header). The projectDir copy
      // is the extension-side record of what this session was prepared with.
      const manifestJson =
        JSON.stringify({ manifest: score0.manifest, score_dir: score0.dir, project_dir: projectDir }, null, 2) + "\n";
      fs.writeFileSync(path.join(projectDir, "score_manifest.json"), manifestJson);
      fs.mkdirSync(problemsRoot(), { recursive: true });
      fs.writeFileSync(path.join(problemsRoot(), "score_manifest.json"), manifestJson);
    }
  } catch (e) {
    console.warn(`amicode: score compilation failed, using built-in interview fallback: ${e}`);
    finalContent = filled;
  }
  fs.writeFileSync(agentsPath, finalContent, "utf8");

  // spec C: write the authoring.json seam amico-run reads (allowlist resolved
  // from the same entitlements the score filter used + the bundled asset paths).
  writeAuthoringConfig(
    opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode"),
    opts.scoresRoot ?? DEFAULT_SCORES_ROOT,
  );

  // The agent reads the template from its bundled absolute path (the session
  // cwd is the workspace, not this temp dir — so no copy is made here).
  return { projectDir, agentsPath, templatePath: opts.templateSrc };
}

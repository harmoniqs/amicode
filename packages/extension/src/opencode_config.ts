import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import { loadRepertoire } from "./scores/loader";
import { readLocalEntitlements, filterRepertoire, packageAllowlist } from "./scores/entitlements";
import { buildRouterSection } from "./scores/router";
import { compileScore, spliceIntoAgentsMd, compileChainedScore, chainManifest } from "./scores/compiler";
import {
  resolveLibrarySkills,
  resolvePackageSkills,
  buildSkillIndexSection,
  stageOpencodeSkills,
  type SkillIndexEntry,
} from "./scores/package_skills";
import {
  resolvePersonalVault,
  defaultVaultsRoot,
  readProfileMd,
  readKnowledgeLines,
  readDemoLines,
  hasOnboardingCompleted,
  onboardingDir,
} from "./substrate/vault_store";
import { buildAboutUserSection, buildRecentProblemsSection, buildReferenceDemosSection } from "./substrate/user_splice";

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
const SCRATCH_DIR = "/tmp/amicode-work"; // matches AGENTS.md step 2/3

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

/** Skill-index roots (spec-20260704-113005 §3). Package skills are co-located
 *  in the workspace package repos; platform skills are the configured names in
 *  the central amico-plugin library. Overridable via settings (Task 6). */
export const DEFAULT_SKILL_ROOTS = [path.join(os.homedir(), "harmoniqs", "packages")];
export const DEFAULT_PLATFORM_SKILLS = ["atoms", "transmon", "fluxonium", "ions", "bosonic"];
export const DEFAULT_LIBRARY_ROOTS = [path.join(os.homedir(), "harmoniqs", "amico-plugin", "skills")];

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
/** True when ~/.amico/profile.json already carries identity — the onboarding
 *  WIZARD (or the About-You card) saved it, so the chat overture must not
 *  re-ask session-zero questions. Complements hasOnboardingCompleted (which
 *  tracks the conversational path's marker). */
export function profileHasIdentity(
  profilePath: string = process.env.AMICO_PROFILE_FILE?.trim() || path.join(os.homedir(), ".amico", "profile.json"),
): boolean {
  try {
    const p = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    return ["name", "affiliation", "focus", "scholar"].some(
      (k) => typeof p[k] === "string" && (p[k] as string).trim() !== "",
    );
  } catch {
    return false;
  }
}

export function authoringFilePath(): string {
  const env = process.env.AMICO_AUTHORING_FILE;
  if (env && env.trim() !== "") return env;
  return path.join(os.homedir(), ".amico", "authoring", "authoring.json");
}

/** Assemble + write authoring.json at session prep. Reads verify_tolerance from
 *  the bundled registry.toml (falls back to 0.01). Never throws — a write
 *  failure logs and leaves amico-run to use its built-in conservative defaults. */
export function writeAuthoringConfig(
  entitlementsDir: string,
  scoresRoot: string = DEFAULT_SCORES_ROOT,
  skills: SkillIndexEntry[] = [],
): void {
  try {
    const ents = readLocalEntitlements(entitlementsDir);
    const registry = AUTHORING_ASSETS.registry;
    const allowlist = packageAllowlist(entitlementsTablePath(scoresRoot), ents.entitlements);
    let tolerance = 0.01;
    let support: string[] = [
      "JLD2",
      "CairoMakie",
      "Makie",
      "TOML",
      "Printf",
      "LinearAlgebra",
      "Random",
      "Statistics",
      "SparseArrays",
    ];
    try {
      const reg = parseToml(fs.readFileSync(registry, "utf8")) as {
        verify_tolerance?: number;
        support?: { packages?: string[] };
      };
      if (typeof reg.verify_tolerance === "number") tolerance = reg.verify_tolerance;
      if (Array.isArray(reg.support?.packages)) support = reg.support!.packages!;
    } catch {
      /* keep defaults */
    }
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
          // Additive session record (spec §3): the dual-source skill index the
          // agent was given. amico-run ignores unknown fields; schema_version stays 1.
          skills,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (e) {
    console.warn(`amicode: failed to write authoring.json (amico-run will use built-in defaults): ${e}`);
  }
}

/** Default model pin for the generated config. Without one, opencode's
 *  default-resolution gambles on provider ordering and (with Google creds)
 *  lands on preview variants — gemini-3.1-pro-preview-customtools rejected or
 *  HUNG every turn. Preference: Anthropic if the user has creds for it, else
 *  the boring-but-available GA Gemini flash (the newest flash is capacity-throttled at peak; 2.5 answered in 1.4s while 3.5 returned overloaded). The app's
 *  model picker still overrides per session; undefined leaves opencode's own
 *  default (no creds yet — nothing sane to pin). */
export function preferredModel(
  authPath: string = path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
): string | undefined {
  try {
    const providers = Object.keys(JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, unknown>);
    if (providers.includes("anthropic")) return "anthropic/claude-sonnet-5";
  } catch {
    /* no auth.json — the free default below still works */
  }
  // Creds-free default: the zen free tier rides no user quota — Gemini keys
  // kept hitting capacity throttles ("model overloaded" → failed turns render
  // as "model undefined" stubs), while this answered a tool-bearing turn in ~3s.
  return "opencode/deepseek-v4-flash-free";
}

/** The model pin to inject, or undefined. FALLBACK-only: a model in the user's
 *  global opencode config wins (our injected config would override it in the
 *  merge — the 1.17.3 preserve-user-model contract), so we pin nothing then. */
export function resolveModelPin(
  globalConfigPath: string = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "opencode",
    "opencode.json",
  ),
  authPath?: string,
): string | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(globalConfigPath, "utf8")) as { model?: unknown };
    if (typeof cfg.model === "string" && cfg.model) return undefined; // user chose — never override
  } catch {
    /* no global config — fall through to the creds-based pin */
  }
  return authPath === undefined ? preferredModel() : preferredModel(authPath);
}

export function buildOpencodeConfigContent(
  agentsPath: string,
  templatePath: string,
  runsRoot: string,
  pluginPath: string = DEFAULT_PLUGIN_PATH,
  scoresRoot: string = DEFAULT_SCORES_ROOT,
  skillPaths: string[] = [],
  skillsStageDir: string = "",
  vaultDir: string = "",
  modelPin?: string,
): string {
  const templatesDir = path.dirname(templatePath);
  // Least-privilege read grants for the skill index (spec §3): each indexed
  // skill's OWN directory only — NOT a library root (the ~50 process skills stay
  // unreadable; the grants agree with the index guard).
  const skillGrants: Record<string, string> = {};
  for (const p of skillPaths) skillGrants[`${path.dirname(p)}/**`] = "allow";
  // Register the staged skills as opencode-native skills (spec §3 fix,
  // 2026-07-04): an ABSOLUTE per-session dir holding ONLY the resolved set, so
  // `atoms`/`piccolissimo-authoring`/… are invocable by name. Absolute path (not
  // a `.opencode/skills` under cwd) sidesteps the session-cwd=workspace pollution
  // and the worktree-walk; the dir holds only the guarded set (stageOpencodeSkills).
  const skills = skillsStageDir ? { paths: [skillsStageDir] } : undefined;
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    ...(modelPin ? { model: modelPin } : {}),
    instructions: [agentsPath],
    plugin: [pluginPath],
    ...(skills ? { skills } : {}),
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
        [templatePath]: "allow", // exact template file the agent reads
        [`${templatesDir}/**`]: "allow", // (belt-and-suspenders for the dir)
        [`${SCRATCH_DIR}/**`]: "allow", // solve.jl + solve.log it writes
        [`/private${SCRATCH_DIR}/**`]: "allow", // macOS: /tmp → /private/tmp
        [`${runsRoot}/**`]: "allow", // run read-backs: FINISHED/result.toml/run.log
        [`${path.join(os.homedir(), ".amico", "library")}/**`]: "allow", // uploaded papers ("read my latest paper" — home Library card)
        [`${problemsRoot()}/**`]: "allow", // amicode_* problem workspaces the agent reads back
        [`${scoresRoot}/**`]: "allow", // score templates + memory hooks ([Why?]) the agent reads
        ...skillGrants, // per-indexed-skill dirs (spec §3, least-privilege)
        // User-memory substrate (spec-20260705-002847 §6): the interview reads
        // problem/environment cards on demand. Read-only BY CONTRACT — vault
        // writes are distiller-only (its own config); the permission surface
        // has no read/write split, so this is posture, documented in spec §10.
        ...(vaultDir ? { [`${vaultDir}/amicode/**`]: "allow" } : {}),
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
  /** Roots to search for co-located package skills (spec §3). Default: DEFAULT_SKILL_ROOTS. */
  skillRoots?: string[];
  /** Configured platform-skill names to index from the library (spec §3). Default: DEFAULT_PLATFORM_SKILLS. */
  platformSkills?: string[];
  /** Roots for the central platform-skill library (spec §3). Default: DEFAULT_LIBRARY_ROOTS. */
  skillLibraryRoots?: string[];
  /** Personal vault dir for the user-memory substrate (spec-20260705-002847).
   *  undefined → auto-resolve (kind=personal marker scan under ~/.amico/vaults);
   *  "" → personalization disabled; a path → used as-is. */
  vaultDir?: string;
}

export interface OpencodeProject {
  projectDir: string;
  agentsPath: string;
  /** The vetted template the agent reads — the bundled source (absolute), not a copy. */
  templatePath: string;
  /** Absolute SKILL.md paths indexed this session — thread into buildOpencodeConfigContent for grants. */
  skillPaths: string[];
  /** Absolute dir holding the staged opencode-native skills — thread into
   *  buildOpencodeConfigContent as `skills.paths`. "" if none staged. */
  skillsStageDir: string;
  /** Resolved personal vault ("" when personalization is off) — thread into
   *  buildOpencodeConfigContent for the read grant. */
  vaultDir: string;
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
  // User-memory substrate (spec-20260705-002847): resolve the personal vault
  // ONCE, up front — the routing predicate (§3) and the splice (§6) both need
  // it. undefined → auto-resolve (kind=personal marker scan); "" → off.
  const vaultDir = opts.vaultDir !== undefined ? opts.vaultDir : resolvePersonalVault(defaultVaultsRoot(), "");

  let finalContent = filled;
  try {
    const scoresRoot = opts.scoresRoot ?? DEFAULT_SCORES_ROOT;
    const load = loadRepertoire(scoresRoot);
    const ents = readLocalEntitlements(opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode"));
    const visible = filterRepertoire(load.scores, ents.entitlements);
    const score0 = visible.find((s) => s.manifest.id === "pulse-designer");
    const overture = visible.find((s) => s.manifest.id === "overture");
    // Routing predicate (spec §3): onboard (chain overture → pulse-designer)
    // ONLY when there is a vault to remember into AND the user has neither a
    // materialized profile NOR a completion marker (the second disjunct closes
    // the ~2-min materialization window; an empty/whitespace PROFILE.md counts
    // as absent via readProfileMd). No vault ⇒ never onboard (nowhere to
    // materialize) — just run pulse-designer.
    const shouldOnboard =
      !!overture &&
      !!score0 &&
      vaultDir !== "" &&
      readProfileMd(vaultDir) === "" &&
      !hasOnboardingCompleted(onboardingDir()) &&
      !profileHasIdentity(); // the welcome WIZARD already collected identity — don't re-interview
    if (shouldOnboard && overture && score0) {
      // Chained: ONE compiled section, ONE manifest (id `overture`, stages =
      // overture ++ pulse-designer) so the score guard sees the whole flow.
      finalContent = spliceIntoAgentsMd(filled, buildRouterSection(visible), compileChainedScore(overture, score0));
      const manifestJson =
        JSON.stringify(
          { manifest: chainManifest(overture, score0), score_dir: overture.dir, project_dir: projectDir },
          null,
          2,
        ) + "\n";
      fs.writeFileSync(path.join(projectDir, "score_manifest.json"), manifestJson);
      fs.mkdirSync(problemsRoot(), { recursive: true });
      fs.writeFileSync(path.join(problemsRoot(), "score_manifest.json"), manifestJson);
    } else if (score0) {
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
  // Package + platform skill index (spec-20260704-113005 §3) — deliberately
  // OUTSIDE the score try/catch above: score-compile trouble must not drop
  // entitled skills, nor vice versa. Platform (library, PUBLIC) entries first,
  // then entitlement-gated package skills. Read on demand — the content is never
  // baked into the prompt or the .vsix; only the lean index is spliced.
  let skillEntries: SkillIndexEntry[] = [];
  try {
    const entsDir = opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode");
    const scoresRoot = opts.scoresRoot ?? DEFAULT_SCORES_ROOT;
    const allow = packageAllowlist(entitlementsTablePath(scoresRoot), readLocalEntitlements(entsDir).entitlements);
    skillEntries = [
      ...resolveLibrarySkills(
        opts.platformSkills ?? DEFAULT_PLATFORM_SKILLS,
        opts.skillLibraryRoots ?? DEFAULT_LIBRARY_ROOTS,
      ),
      ...resolvePackageSkills(allow, opts.skillRoots ?? DEFAULT_SKILL_ROOTS),
    ];
    const section = buildSkillIndexSection(skillEntries);
    if (section) finalContent = finalContent + "\n\n" + section;
  } catch (e) {
    console.warn(`amicode: skill index failed (session continues without it): ${e}`);
  }

  fs.writeFileSync(agentsPath, finalContent, "utf8");

  // spec C: write the authoring.json seam amico-run reads (allowlist resolved
  // from the same entitlements the score filter used + the bundled asset paths).
  // The skill index rides along as an additive session record (spec §3).
  writeAuthoringConfig(
    opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode"),
    opts.scoresRoot ?? DEFAULT_SCORES_ROOT,
    skillEntries,
  );

  // Register the resolved skills as opencode-native skills: stage ONLY this set
  // into an absolute per-session dir, pointed at by config `skills.paths` (see
  // buildOpencodeConfigContent). Makes them invocable by name (the agent's
  // instinct — observed 2026-07-04); the guard holds because we stage the
  // resolved set, never a whole library root.
  const skillsStageDir = stageOpencodeSkills(path.join(projectDir, "skills"), skillEntries);

  // User-memory splice (spec-20260705-002847 §6): About-this-user + Your-recent-
  // problems, appended to the compiled content — own try/catch, personalization
  // trouble must never brick the boot. `vaultDir` was resolved up front (above).
  // When we routed to the overture (no profile yet) these read empty and add
  // nothing — correct: there is no memory to splice on the very first session.
  if (vaultDir) {
    try {
      const about = buildAboutUserSection(readProfileMd(vaultDir));
      const recent = buildRecentProblemsSection(readKnowledgeLines(vaultDir));
      const demos = buildReferenceDemosSection(readDemoLines(vaultDir)); // L1 §3
      for (const section of [about, recent, demos]) {
        if (section) finalContent = finalContent + "\n\n" + section;
      }
    } catch (e) {
      console.warn(`amicode: user-memory splice failed (session continues unpersonalized): ${e}`);
    }
  }

  fs.writeFileSync(agentsPath, finalContent, "utf8");

  // The agent reads the template from its bundled absolute path (the session
  // cwd is the workspace, not this temp dir — so no copy is made here).
  return {
    projectDir,
    agentsPath,
    templatePath: opts.templateSrc,
    skillPaths: skillEntries.map((e) => e.path),
    skillsStageDir,
    vaultDir,
  };
}

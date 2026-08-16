import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseToml } from "smol-toml";
import { loadRepertoire } from "./scores/loader";
import { loadPacks } from "./scores/packs";
import { readLocalEntitlements, filterRepertoire, packageAllowlist } from "./scores/entitlements";
import { buildRouterSection } from "./scores/router";
import { compileScore, spliceIntoAgentsMd, compileChainedScore, chainManifest } from "./scores/compiler";
import {
  resolveLibrarySkills,
  resolvePackageSkills,
  buildSkillIndexSection,
  stageOpencodeSkills,
  type SkillIndexEntry,
  type LibraryRoot,
  type LibraryRootSpec,
} from "./scores/package_skills";
import { readSolverModeState } from "./solver_mode";
import { buildRoutingSection, readRoutingContext } from "./routing";
import {
  readProfileMd,
  readKnowledgeLines,
  readDemoLines,
  readMemoryIndexLines,
  hasOnboardingCompleted,
  onboardingDir,
} from "./substrate/vault_store";
import { resolveMountStack, personalMount, type Mount, type MountStack } from "./substrate/mount_store";
import {
  buildAboutUserSection,
  buildRecentProblemsSection,
  buildReferenceDemosSection,
  buildMountStackSection,
  buildMemoryIndexSection,
} from "./substrate/user_splice";

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
// Pack-manifest repertoire (WS1 #369): the bundled packs root + the default
// pack id. The pack's manifest is the source of the repertoire; the legacy
// scores-dir scan remains the fallback until WS2 folds scores/ into the pack.
export const DEFAULT_PACKS_ROOT = path.resolve(__dirname, "..", "packs");
export const DEFAULT_PACK_ID = "quantum-control";

/** Skill-index roots (spec-20260704-113005 §3). Package skills are co-located
 *  in the workspace package repos; library (public) skills ship IN this repo
 *  at packages/extension/skills/ (moved out of the retired amico-plugin repo —
 *  they are product content, versioned with the extension). Overridable
 *  via settings (Task 6). */
export const DEFAULT_SKILL_ROOTS = [path.join(os.homedir(), "harmoniqs", "packages")];
/** Library roots scanned (first-root-wins), TYPED by admitted surface set
 *  (ADR-0003, amicode#242; roots re-homed after the amico-plugin dissolution):
 *   1. the in-repo public library (packages/extension/skills/, sibling of
 *      src/ and dist/ — same __dirname trick as DEFAULT_SCORES_ROOT) — admits
 *      {public} ONLY. This is the single source of truth for public skills and
 *      the ONLY root a Marketplace user has; the public/private boundary is
 *      now the repo boundary, not an extract pipeline.
 *   2. the team's armonissima vault mount — admits {internal}. Mount presence
 *      IS the eligibility proof: internal SKILL.md content exists only in the
 *      private team vault (synced by the armonia sync), so nobody stages
 *      skills they do not already possess. This is what gives brainstorming's
 *      publish/decompose steps (write-an-issue, break-into-subissues —
 *      surface:internal) their path to Amicode. Missing roots are silently
 *      skipped (resolveLibrarySkills). */
export const DEFAULT_LIBRARY_ROOTS: LibraryRoot[] = [
  { path: path.resolve(__dirname, "..", "skills"), surfaces: ["public"] },
  { path: path.join(os.homedir(), ".amico", "vaults", "armonissima", "skills"), surfaces: ["internal"] },
];
/** The physics/optimization skill subset (formerly `surface: product`, now `public`) —
 *  a documentation/reference anchor, NOT a selection input (selection is purely by
 *  frontmatter `surface: public`, see resolveLibrarySkills). The discovery test uses it
 *  as a superset check: each of these must appear in the discovered public set. */
export const DEFAULT_PLATFORM_SKILLS = [
  "atoms",
  "pasqal", // the neutral-atom DEVICE path (solve -> Pulser -> emulator/QPU)
  "bosonic",
  "fluxonium",
  "ions",
  "transmon",
  "setup",
  "solve",
  "plot",
  "objectives",
  "demo",
];

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

/** Solver-mode section for AGENTS.md: in HP mode the agent authors with the
 *  Piccolissimo stack AND routes the solve to the cloud. "High-Performance +
 *  Cloud" (tier=hpc) is the PAID tier — it runs in the cloud only, never
 *  locally (the runner AMI has Piccolissimo/Altissimo pre-baked; a local run
 *  can't even instantiate the private package). Routing is enforced durably by
 *  the amico-run gate (tier=hpc ⇒ executor=remote + env=provisioned + a cloud
 *  connection, else exit 64); this section makes the agent do the right thing
 *  and, crucially, BLOCK-WITH-PROMPT when no cloud key is connected. */
export function solverModeSection(): string {
  if (readSolverModeState().mode !== "hp") return "";
  const cloudConnected =
    !!process.env.AMICO_CLOUD_URL || fs.existsSync(path.join(os.homedir(), ".amico", "cloud.json"));
  const routing = cloudConnected
    ? "Harmoniqs Cloud is CONNECTED, and EVERY solve on this solver runs there — this tier has no local " +
      "mode, so never ask the user where a solve should run. Author it as: " +
      '`tier="hpc"`, `executor="remote"`, `env.kind="provisioned"` (via `amico-run --spec <spec> ' +
      "<script.jl> --executor remote`). The runner image has Piccolissimo/Altissimo pre-baked, so there " +
      "is NO local precompile and NO sandbox — never author a sandbox env for HP. A local launch is " +
      "REFUSED by amico-run while this solver is selected (exit 64), so attempting one only wastes a turn. " +
      "Live iteration frames stream to the Inspector; note that per-iteration AMICODE_ITER stats + the " +
      "cooperative Stop are not yet available on the cloud bundle, and re-rollout verification is skipped " +
      "for cloud runs (say so). Only claim cloud execution when the launch actually used `--executor remote`."
    : "Harmoniqs Cloud is NOT connected (no API key). Piccolissimo + Altissimo is a PAID cloud tier and " +
      "CANNOT run locally — do NOT attempt a local Piccolissimo solve (it will fail three ways: amico-run " +
      "refuses a local launch in this mode, the private package can't be instantiated in a sandbox, and " +
      "the gate rejects a local hpc run). Instead, STOP and tell the user: " +
      '"Piccolissimo + Altissimo needs a Harmoniqs Cloud connection — click **Piccolissimo + Altissimo** ' +
      "in the model · solver control on the dashboard and connect your API key there (or run **Amico: " +
      'Connect Cloud**, which opens the same flow)." Offer to switch back to the free local Piccolo solver ' +
      "if they'd rather not connect now.";
  return (
    "\n\n## Solver mode\n" +
    "**HIGH-PERFORMANCE + CLOUD (Piccolissimo + Altissimo).** The user selected the paid " +
    '"High-Performance + Cloud" solver. Author solves with the **Piccolissimo** stack ' +
    "(SplinePulseProblem, free-phase paths, `using Piccolissimo`) rather than plain Piccolo, falling back " +
    "to Piccolo only when Piccolissimo cannot express the problem (say so when you do). " +
    "**Import BOTH: `using Piccolo` AND `using Piccolissimo`.** Piccolissimo does NOT re-export Piccolo's " +
    "symbols, so a script with only `using Piccolissimo` dies on the first `GATES[:X]`, `TransmonSystem`, " +
    "`EmbeddedOperator`, `UnitaryTrajectory` — every problem-setup name comes from Piccolo. The failure is " +
    "an UndefVarError at load time, before any solve starts, and on a cloud run you pay the full queue and " +
    "instance-boot wait before seeing it. " +
    "**Solver backend:** the default remains IPOPT (`IpoptOptions`), which is what streams per-iteration " +
    "telemetry — its `intermediate_callback` produces the Inspector's frames and the `AMICODE_ITER` lines. " +
    "If the researcher asks for the **Altissimo** backend (the augmented-Lagrangian GPU solver, " +
    "`AltissimoOptions`), switch it by setting **`SOLVER = :altissimo`** in the template's FILL-IN block — that " +
    "one line is the whole change. Do NOT hand-roll the solve call: the template already re-hangs BOTH telemetry " +
    "channels onto Altissimo's `(x, info)` hook (the frames come off `IpoptOptions.intermediate_callback`, which " +
    "`AltissimoOptions` does not have, so a hand-written call loses the Inspector's frames as well as its " +
    "numbers), passes the budget as `AltissimoOptions(max_outer_iter = max_iter)` (a `max_iter` given to " +
    "`solve!` is silently DROPPED on that path — the solve would quietly run 20 outer iterations), and derives " +
    "`inf_pr`/`inf_du` on older Altissimo builds. " +
    "Also TELL THEM that live iterations depend on the INSTALLED version. " +
    "Current Piccolissimo main accepts a `callback` on `solve!(::AltissimoOptions)` and forwards it to " +
    "`Altissimo.optimize!`, which fires it every outer iteration; older builds swallow `kwargs...` and forward " +
    "nothing, so an Altissimo run there emits NO AMICODE_ITER lines and the Run Inspector stays dark until the " +
    "solve finishes. Do not promise live iterations you have not seen: run it, and if no AMICODE_ITER line " +
    "appears in the first iterations, say so plainly rather than implying the solve is stuck. Never switch to " +
    "Altissimo silently. " +
    routing +
    "\n"
  );
}

/** Δ10 (#63): the per-solve routing guidance appended to the agent's AGENTS.md.
 *  Reads the live solver mode + Company Compute connection status (both
 *  token-free — status only, never the token) and renders the remote-routing
 *  offer only when both admit it (mode = hp AND connection connected); "" in
 *  every other case, so piccolo / disconnected sessions stay byte-identical to
 *  before. The estimate SUGGESTS the confirm's default; the researcher always
 *  confirms, per-solve, never auto-routed. */
export function routingSection(): string {
  return buildRoutingSection(readRoutingContext(readSolverModeState().mode));
}

/** The model pin to inject into the generated config, or undefined.
 *
 *  We deliberately DO NOT force a fallback model here. `config.model` is the
 *  authoritative default in opencode's resolution — it outranks the user's
 *  recent-model pick (local.tsx: `configuredModel() ?? recentModel() ?? …`).
 *  A hardcoded fallback in that slot therefore OVERRODE the user's own
 *  selection permanently (report: "set to qwen but defaults to deepseek").
 *
 *  So: the only explicit default is `amicode.defaultModel` (handled by the
 *  caller, which passes it ahead of this). With no explicit default we return
 *  undefined and let opencode resolve it — the user's recent pick, else the
 *  provider default. A user who wants a fixed default sets amicode.defaultModel
 *  (or a model in their global opencode.json, which opencode reads natively). */
export function resolveModelPin(): string | undefined {
  return undefined;
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
  mounts: Mount[] = [],
  modelPin?: string,
  /** Run-corpus telemetry gate (server_auth telemetryGateOpen). opencode gates
   *  AI-SDK span GENERATION on `cfg.experimental?.openTelemetry` (session/llm.ts,
   *  agent/agent.ts) — the OTLP endpoint env only arms the EXPORTER, so without
   *  this flag opencode emits zero spans and the pipe carries nothing. Set it
   *  true ONLY when the gate is open (enabled+consent+endpoint+key): no point
   *  paying span overhead when we are not capturing, and never before consent.
   *  When false we OMIT the key entirely (rather than force it false) so a user's
   *  own global `experimental.openTelemetry` is never clobbered by the deep-merge. */
  telemetryOpen: boolean = false,
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
    // Enable AI-SDK span generation ONLY behind the telemetry gate — deep-merges
    // into cfg.experimental alongside any user keys (see telemetryOpen above).
    ...(telemetryOpen ? { experimental: { openTelemetry: true } } : {}),
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
        // Armonia mount stack (spec-20260707-002846 C1): a READ grant per mount
        // so the agent can read cards/notes on demand across the WHOLE stack.
        // The permission surface has no read/write split, so even a read-only
        // mount gets a grant here (read posture); write discipline stays
        // distiller-side (its own config), same contract as the vault grant below.
        ...Object.fromEntries(mounts.map((m) => [`${m.path}/**`, "allow"])),
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
  /** Scores repertoire root (SCORE.md manifests). Legacy fallback when no
   *  pack loads (WS1 #369); default: the bundled scores/. */
  scoresRoot?: string;
  /** Packs root (PACK.toml manifests, precedence order). Default: the
   *  bundled packs/. The default pack's manifest drives the repertoire. */
  packsRoot?: string;
  /** Dir holding the user's entitlements.toml (access-code stub). Default: ~/.amico/amicode. */
  entitlementsDir?: string;
  /** Roots to search for co-located package skills (spec §3). Default: DEFAULT_SKILL_ROOTS. */
  skillRoots?: string[];
  /** Roots for the central library, scanned under per-root surface eligibility
   *  (ADR-0003, amicode#242). Typed `{path, surfaces}` roots; a bare string
   *  admits public only (pre-ADR settings overrides keep working).
   *  Default: DEFAULT_LIBRARY_ROOTS. */
  skillLibraryRoots?: LibraryRootSpec[];
  /** Personal vault dir for the user-memory substrate (spec-20260705-002847),
   *  three-state (spec-20260707-002846 C1):
   *    undefined → auto-resolve the full Armonia mount stack under
   *                ~/.amico/vaults; vaultDir = the personal mount ("" if none);
   *    ""        → personalization disabled (empty stack, no grants, no splice);
   *    a path    → a single forced personal mount at that path (dev escape hatch). */
  vaultDir?: string;
  /** Stable project dir to (re)use across activations; created if missing and
   *  safe to re-prepare (every write below is overwrite-idempotent). Default:
   *  a fresh mkdtemp — but note the app PERSISTS the selected project per
   *  server workspace, so an ephemeral dir dangles after the next activation
   *  and its bootstrap failure leaves the agent list empty (the fresh-profile
   *  "Select an agent and model" dead-end). Installed extensions must pass a
   *  stable dir. */
  projectDir?: string;
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
   *  buildOpencodeConfigContent for the read grant. Equals `personalMount(mounts)`
   *  path (unchanged behavior for the distiller + onboarding consumers). */
  vaultDir: string;
  /** The resolved Armonia mount stack (spec-20260707-002846 C1) — thread into
   *  buildOpencodeConfigContent for the per-mount read grants. [] when
   *  personalization is disabled ("" vaultDir). */
  mounts: Mount[];
}

export function prepareOpencodeProject(opts: OpencodeConfigOptions): OpencodeProject {
  const projectDir = opts.projectDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "amicode-"));
  if (opts.projectDir) fs.mkdirSync(projectDir, { recursive: true });

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
  // Armonia mount stack (spec-20260707-002846 C1) + user-memory substrate
  // (spec-20260705-002847): resolve ONCE, up front — the routing predicate (§3),
  // the per-mount read grants, and the splice (§6, C3/C4) all need it. The
  // three-state opts.vaultDir contract is preserved EXACTLY:
  //   undefined → auto-resolve the FULL stack (personal mount → vaultDir);
  //   ""        → personalization OFF (empty stack, no grants, no splice);
  //   a path    → a single forced personal mount at that path (dev escape hatch).
  let stack: MountStack;
  if (opts.vaultDir === undefined) {
    stack = resolveMountStack();
  } else if (opts.vaultDir === "") {
    stack = { mounts: [], warnings: [] };
  } else {
    stack = {
      mounts: [{ name: path.basename(opts.vaultDir), kind: "personal", path: opts.vaultDir, writable: true }],
      warnings: [],
    };
  }
  // vaultDir === the personal mount path (unchanged behavior for the distiller +
  // onboarding predicate consumers); "" when there is no personal mount.
  const vaultDir = personalMount(stack)?.path ?? "";

  let finalContent = filled;
  try {
    // Pack-manifest repertoire (WS1 #369): the default pack's manifest is the
    // source — the score is one field of the pack. A missing or broken pack
    // root falls back to the legacy scores-dir scan, so boot behaves exactly
    // as today in every degenerate case (never brick).
    const packsLoad = loadPacks([opts.packsRoot ?? DEFAULT_PACKS_ROOT], {
      // The agent-editable trees at boot (#369): a corrector path resolving
      // under any of these breaks the pack — the gate must live where the
      // agent cannot write. The staging dir hosts the agent's own project.
      agentTrees: [
        problemsRoot(),
        SCRATCH_DIR,
        path.join(os.homedir(), ".amico", "server", "opencode-project-staging"),
        ...(vaultDir ? [path.join(vaultDir, "amicode")] : []),
      ],
    });
    const pack = packsLoad.packs.find((p) => p.manifest.id === DEFAULT_PACK_ID) ?? packsLoad.packs[0];
    if (!pack && packsLoad.errors.length > 0) {
      console.warn(`amicode: pack load failed, falling back to scores root: ${JSON.stringify(packsLoad.errors)}`);
    }
    const ents = readLocalEntitlements(opts.entitlementsDir ?? path.join(os.homedir(), ".amico", "amicode"));
    const repertoire = pack ? pack.scores : loadRepertoire(opts.scoresRoot ?? DEFAULT_SCORES_ROOT).scores;
    const visible = filterRepertoire(repertoire, ents.entitlements);
    const score0 = visible.find((s) => s.manifest.id === (pack?.manifest.onboarding.primary ?? "pulse-designer"));
    const overture = visible.find((s) => s.manifest.id === (pack?.manifest.onboarding.head ?? "overture"));
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
    const ents = readLocalEntitlements(entsDir).entitlements;
    const allow = packageAllowlist(entitlementsTablePath(scoresRoot), ents);
    skillEntries = [
      // Library (public) skills by `surface: public` tag (spec-20260713-003804) — the
      // OSS-shippable surface (Armonia vault layer + physics/opt + generic craft). The
      // private tier is package-gated below (resolvePackageSkills), never here.
      ...resolveLibrarySkills(opts.skillLibraryRoots ?? DEFAULT_LIBRARY_ROOTS),
      ...resolvePackageSkills(allow, opts.skillRoots ?? DEFAULT_SKILL_ROOTS),
    ];
    const section = buildSkillIndexSection(skillEntries);
    if (section) finalContent = finalContent + "\n\n" + section;
  } catch (e) {
    console.warn(`amicode: skill index failed (session continues without it): ${e}`);
  }

  fs.writeFileSync(agentsPath, finalContent + solverModeSection() + routingSection(), "utf8");

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
  // resolved set, never a whole library root. Clear first: a STABLE projectDir
  // re-prepares, and skills staged under a previous (wider) entitlement set
  // must not survive into this session's guarded set.
  fs.rmSync(path.join(projectDir, "skills"), { recursive: true, force: true });
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

  // Mount-stack + memory-index splice (spec-20260707-002846 C3/C4 read side):
  // its OWN try/catch — mount-parity trouble must never brick the boot. The
  // mount-stack section renders whenever the stack has mounts (mounts can exist
  // without a personal vault — e.g. a team-only stack); the typed-memory index
  // is read from the personal mount, so it is gated on vaultDir. Empty stack
  // ("" vaultDir) → both builders return "" → nothing is spliced.
  try {
    const mountSection = buildMountStackSection(stack);
    if (mountSection) finalContent = finalContent + "\n\n" + mountSection;
    if (vaultDir) {
      const memorySection = buildMemoryIndexSection(readMemoryIndexLines(vaultDir));
      if (memorySection) finalContent = finalContent + "\n\n" + memorySection;
    }
  } catch (e) {
    console.warn(`amicode: mount-stack/memory-index splice failed (session continues): ${e}`);
  }

  fs.writeFileSync(agentsPath, finalContent + solverModeSection() + routingSection(), "utf8");

  // The agent reads the template from its bundled absolute path (the session
  // cwd is the workspace, not this temp dir — so no copy is made here).
  return {
    projectDir,
    agentsPath,
    templatePath: opts.templateSrc,
    skillPaths: skillEntries.map((e) => e.path),
    skillsStageDir,
    vaultDir,
    mounts: stack.mounts,
  };
}

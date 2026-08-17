// `amico profile` — the capability-profile resolver (fleet spec §2/§3.1; the CLI half
// of "the extension resolves the profile via `amico profile resolve`").
//
//   amico profile resolve (--name <preset> | --profile <file.toml>)
//                         [--mode spool-up|dispatch]
//                         [--profiles-dir D] [--skills-dir D (repeatable)] [--gates-dir D]
//                         [--entitlements a,b | --entitlements-dir D]
//       → validate the profile, entitlement-filter its `skills`, apply the spool-up
//         composition rule, and print the resolved loadout as JSON (plus the lossy
//         Claude-Code tool-set preview the compiler must match). Exit 64 with
//         field-precise errors when the profile is unresolvable — §3.1's failure path
//         is "fail loudly PRE-injection, then land on `default`", never a blocked
//         chat, so the error payload names that fallback explicitly.
//
// THE SCHEMA THIS VALIDATES lives (with the presets and the gate registry) in the
// armonissima team vault: `profiles/*.toml` + `profiles/SCHEMA.md` + `gates/*.toml`
// (re-homed from the retired amico-plugin repo). The rules below are a deliberate
// port of that tree's lint — same vocabularies, same error/warning split — so a
// profile that passes the vault's CI resolves here and vice versa. When the lint
// changes, change this too.
//
// SPOOL-UP COMPOSITION RULE (§2.2/§3.1, the one rule easiest to get wrong): spool-up
// ALWAYS instantiates the `resident` shell. A referenced preset contributes only
// `skills`, `model`, `variant`, `permissions`, `gates`, `task_type` — its `base` is
// IGNORED, because a chat is never an `executor` or `headless` shell. A preset's
// `base` applies when it is DISPATCHED, not when it is WORN. `--mode spool-up`
// enforces that and reports the ignored value rather than silently dropping it.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { TASK_TYPES } from "./ledger.js";
import { FRONTIER_MODELS, LADDER } from "./ledger_dispatch.js";
import type { VerbResult } from "./verbs.js";
import { profilesVaultDir, opsDir } from "./paths.js";

// ── vocabularies (closed sets, extensible only by schema revision — §2.1) ─────────
const BASES = ["resident", "executor", "headless"] as const;
const RESOURCES = ["vault", "packages", "ops", "work", "device"] as const;
// `device` is DELIBERATELY absent: it governs lab hardware, has no path root, and
// compiles to TOOL-LAYER enforcement only. It must never count toward the
// any-resource-rw test that decides filesystem write permission, so a
// {work = "ro", device = "rw"} profile never gains Claude Code's Write/Edit through
// it (§2.1 Rev 4.1 boundary rule; mirrors PATH_RESOURCES in lint_profiles.sh).
const PATH_RESOURCES = ["vault", "packages", "ops", "work"] as const;
const RES_VALUES = ["rw", "ro", "none"] as const;
const SURFACES = ["public", "internal"] as const;
const RUNTIMES = ["claude-code", "opencode"] as const;
const KNOWN_VARIANTS = ["low", "medium", "high", "xhigh", "max", "default"] as const;
/** §2.3 preset → base shell. A known preset naming the wrong shell is an error. */
const PRESET_BASES: Record<string, string> = {
  researcher: "executor",
  experimenter: "executor",
  engineer: "executor",
  "librarian-insight": "executor",
  dreamer: "headless",
  default: "resident",
};
/** §2.1 runtime defaults. They exist for PLAN-STEP OVERLAYS and composed (triage)
 *  profiles — a saved preset stamps every resource explicitly and is held to that. */
const PERMISSION_DEFAULTS: Record<string, string> = {
  vault: "ro",
  packages: "ro",
  ops: "ro",
  work: "rw",
  device: "none",
  task: "deny",
};
const MODEL_ID = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export type ResolveMode = "spool-up" | "dispatch";

interface Profile {
  schema?: unknown;
  name?: unknown;
  description?: unknown;
  surface?: unknown;
  base?: unknown;
  skills?: unknown;
  model?: unknown;
  variant?: unknown;
  task_type?: unknown;
  gates?: unknown;
  plan?: unknown;
  runtimes?: unknown;
  permissions?: unknown;
  task_grant_justification?: unknown;
  [k: string]: unknown;
}

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/** Repeatable-flag collector (unlike flagValue): every occurrence, in order. */
function flagValues(argv: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;

// ── roots ────────────────────────────────────────────────────────────────────────
/** The profiles/gates/skills tree: the armonissima vault mount, which is also where
 *  the extension looks for internal library skills (DEFAULT_LIBRARY_ROOTS). Overridable
 *  per-flag and per-env so CI and tests point at a fixture tree. */
function profilesDir(argv: string[]): string {
  return flagValue(argv, "--profiles-dir") ?? process.env.AMICO_PROFILES_DIR ?? profilesVaultDir();
}
function siblingDir(argv: string[], flag: string, env: string, name: string): string {
  const explicit = flagValue(argv, flag) ?? process.env[env];
  if (explicit) return explicit;
  return join(profilesDir(argv), "..", name);
}

/** The skills roots a profile's skills are validated against. Post-amico-plugin the
 *  library is SPLIT ACROSS TWO ROOTS: the armonissima vault's skills/ (internal tier)
 *  and the public library shipped INSIDE the amicode extension (packages/extension/
 *  skills/), resolvable from the installed CLI bundle (bin/dist/amico.js → ../../skills).
 *  A profile legitimately composes both tiers, so existence must be a union check.
 *  `--skills-dir` is REPEATABLE and any explicit flag(s) replace the defaults outright
 *  (tests always pass them); the in-repo default self-disables wherever the bundle
 *  layout is absent (dev checkouts of amico-run alone, CI). */
function skillsDirs(argv: string[]): string[] {
  const explicit = flagValues(argv, "--skills-dir");
  if (explicit.length > 0) return explicit;
  const env = process.env.AMICO_SKILLS_DIR;
  if (env && env.trim() !== "") return [env];
  const dirs = [join(profilesDir(argv), "..", "skills")];
  const script = process.argv[1];
  if (script) {
    const inRepo = resolve(dirname(script), "..", "..", "skills");
    if (existsSync(inRepo)) dirs.push(inRepo);
  }
  return dirs;
}

// ── entitlements ─────────────────────────────────────────────────────────────────
/** The held entitlement codes. Precedence: `--entitlements a,b` (an empty string means
 *  "none"), then `$AMICO_ENTITLEMENTS`, then `<dir>/entitlements.toml`'s `codes` —
 *  the same file and default dir the extension's readLocalEntitlements() reads.
 *  Missing file → public only, silently. Malformed → public only WITH a warning: an
 *  entitlement failure must never dead-end a session. */
function readEntitlements(argv: string[], warnings: string[]): { codes: string[]; source: string } {
  const inline = flagValue(argv, "--entitlements") ?? process.env.AMICO_ENTITLEMENTS;
  if (inline !== undefined) {
    return { codes: inline.split(",").map((c) => c.trim()).filter((c) => c.length > 0), source: "flag/env" };
  }
  const dir = flagValue(argv, "--entitlements-dir") ?? process.env.AMICO_ENTITLEMENTS_DIR ?? opsDir();
  const file = join(dir, "entitlements.toml");
  if (!existsSync(file)) return { codes: [], source: "none (no entitlements.toml — public only)" };
  try {
    const parsed = parseToml(readFileSync(file, "utf8")) as { codes?: unknown };
    return { codes: strList(parsed.codes) ?? [], source: file };
  } catch {
    warnings.push(`could not parse ${file} — treating the session as public-only (an entitlement failure must not dead-end a session)`);
    return { codes: [], source: `${file} (malformed)` };
  }
}

// ── skills ───────────────────────────────────────────────────────────────────────
/** A skill's `surface:` tag, read from its SKILL.md frontmatter — searched across the
 *  skills roots in order, first hit wins. undefined = the file exists but carries no
 *  tag; null = no such skill in ANY root. */
function skillSurface(skillsDirs: string[], name: string): string | undefined | null {
  for (const dir of skillsDirs) {
    const file = join(dir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    return skillSurfaceIn(file);
  }
  return null;
}
function skillSurfaceIn(file: string): string | undefined {
  const lines = readFileSync(file, "utf8").split("\n");
  let fences = 0;
  for (const line of lines) {
    if (/^---\s*$/.test(line)) {
      fences++;
      if (fences === 2) break;
      continue;
    }
    if (fences !== 1) continue;
    const m = /^surface:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1].replace(/["']/g, "");
  }
  return undefined;
}

/** Is a gate runnable today? Only `status = "available"` counts — a `pending-impl` or
 *  `hil-gated` entry cannot catch anything yet, so it does not satisfy the
 *  verifiability rule (§2.4/§6.1). */
function gateStatus(gatesDir: string, name: string): string | null {
  const file = join(gatesDir, `${name}.toml`);
  if (!existsSync(file)) return null;
  try {
    return str((parseToml(readFileSync(file, "utf8")) as { status?: unknown }).status) ?? "";
  } catch {
    return "";
  }
}

// ── resolve ──────────────────────────────────────────────────────────────────────
export function profileResolve(argv: string[]): VerbResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const modeRaw = flagValue(argv, "--mode") ?? "dispatch";
  if (modeRaw !== "spool-up" && modeRaw !== "dispatch") {
    return {
      json: {
        verb: "profile",
        subcommand: "resolve",
        ok: false,
        errors: [`--mode must be "spool-up" or "dispatch" (got "${modeRaw}")`],
        fallback_preset: "default",
      },
      code: 64,
    };
  }
  const mode: ResolveMode = modeRaw;

  // ── locate ───────────────────────────────────────────────────────────────────
  const explicit = flagValue(argv, "--profile");
  const wanted = flagValue(argv, "--name");
  const dir = profilesDir(argv);
  const path = explicit ?? (wanted ? join(dir, `${wanted}.toml`) : undefined);
  const fail = (errs: string[]): VerbResult => ({
    json: { verb: "profile", subcommand: "resolve", ok: false, mode, path: path ?? null, errors: errs, warnings, fallback_preset: "default" },
    code: 64,
  });
  if (!path) return fail(["one of --name <preset> or --profile <file.toml> is required"]);
  if (!existsSync(path)) return fail([`profile does not resolve: ${path}`]);

  let profile: Profile;
  try {
    profile = parseToml(readFileSync(path, "utf8")) as Profile;
  } catch (e) {
    return fail([`${path}: parse error — ${e instanceof Error ? e.message : String(e)}`]);
  }

  const stem = path.replace(/^.*[\\/]/, "").replace(/\.toml$/, "");
  const skillsRoots = skillsDirs(argv);
  const gatesDir = siblingDir(argv, "--gates-dir", "AMICO_GATES_DIR", "gates");

  // ── required fields + identity ───────────────────────────────────────────────
  if (profile.schema !== 1) errors.push(`schema must be 1 (got ${JSON.stringify(profile.schema ?? null)})`);
  const name = str(profile.name);
  if (!name) errors.push(`missing required key "name"`);
  else if (name !== stem) errors.push(`name "${name}" does not equal the filename stem "${stem}"`);
  if (!str(profile.description)) warnings.push("description is empty");

  const surface = str(profile.surface) ?? "internal";
  if (!(SURFACES as readonly string[]).includes(surface)) errors.push(`surface "${surface}" must be one of (${SURFACES.join(", ")})`);

  // ── base + the spool-up composition rule ─────────────────────────────────────
  const declaredBase = str(profile.base);
  if (!declaredBase) errors.push(`missing required key "base"`);
  else if (!(BASES as readonly string[]).includes(declaredBase)) errors.push(`base "${declaredBase}" must be one of (${BASES.join(", ")})`);
  else if (name && PRESET_BASES[name] && PRESET_BASES[name] !== declaredBase) {
    errors.push(`preset "${name}" must declare base = "${PRESET_BASES[name]}" (§2.3), not "${declaredBase}"`);
  }
  // In spool-up mode the declared base is IGNORED — a chat is always the resident
  // shell. Reported, not silently dropped, so the caller can see what it lost.
  const resolvedBase = mode === "spool-up" ? "resident" : (declaredBase ?? "");
  const baseIgnored = mode === "spool-up" && declaredBase && declaredBase !== "resident" ? declaredBase : null;

  // ── model + variant, ALWAYS co-stamped ───────────────────────────────────────
  const model = str(profile.model);
  const variant = str(profile.variant);
  if (!model) errors.push(`missing required key "model"`);
  else if (!MODEL_ID.test(model)) errors.push(`model "${model}" is not a well-formed provider/model-id`);
  if (!variant) errors.push(`missing required key "variant"`);
  // A subagent that pins its own model silently drops the parent's variant, so a model
  // pin without a variant loses effort control with no error anywhere (§2).
  if ((model && !variant) || (variant && !model)) errors.push("model and variant must ALWAYS be co-stamped (§2)");
  if (variant && !(KNOWN_VARIANTS as readonly string[]).includes(variant)) {
    warnings.push(`variant "${variant}" is outside the known effort ladder (${KNOWN_VARIANTS.join(", ")}) — provider catalogs define these, so this is a warning`);
  }

  // ── task_type ────────────────────────────────────────────────────────────────
  const task_type = str(profile.task_type);
  if (!task_type) errors.push(`missing required key "task_type"`);
  else if (!(TASK_TYPES as readonly string[]).includes(task_type)) {
    errors.push(`task_type "${task_type}" must be one of (${TASK_TYPES.join(", ")})`);
  }
  if (name === "default" && task_type !== "converse") {
    errors.push(`preset "default" must stamp task_type = "converse" (§2.3) — the resident's telemetry must not pool into a work-shaped cell`);
  }

  // ── plan is runtime-authored only ────────────────────────────────────────────
  if (profile.plan === undefined) errors.push(`missing required key "plan" (presets carry an empty plan)`);
  else if (str(profile.plan) !== "") errors.push(`plan must be empty in a saved profile — the field is runtime-authored only (§2.3, §5)`);

  // ── runtimes ─────────────────────────────────────────────────────────────────
  const runtimes = profile.runtimes === undefined ? [...RUNTIMES] : strList(profile.runtimes);
  if (!runtimes) errors.push("runtimes must be a list of strings");
  else for (const rt of runtimes) {
    if (!(RUNTIMES as readonly string[]).includes(rt)) errors.push(`unknown runtime "${rt}" (must be one of: ${RUNTIMES.join(", ")})`);
  }

  // ── permissions ──────────────────────────────────────────────────────────────
  const permsRaw = profile.permissions;
  const permissions: Record<string, string> = {};
  const defaulted: string[] = [];
  const isPreset = name !== undefined && PRESET_BASES[name] !== undefined;
  if (permsRaw === undefined || typeof permsRaw !== "object" || Array.isArray(permsRaw)) {
    errors.push(`missing required key "permissions" (a table)`);
  } else {
    for (const [k, v] of Object.entries(permsRaw as Record<string, unknown>)) {
      const val = str(v);
      if (k === "task") {
        if (val !== "allow" && val !== "deny") errors.push(`permissions.task must be "allow" or "deny" (got ${JSON.stringify(v)})`);
        else permissions.task = val;
        continue;
      }
      if (!(RESOURCES as readonly string[]).includes(k)) {
        errors.push(`unknown permission key "${k}" (must be one of: ${RESOURCES.join(", ")}, task)`);
        continue;
      }
      if (val === undefined || !(RES_VALUES as readonly string[]).includes(val)) {
        errors.push(`permissions.${k} must be one of (${RES_VALUES.join(", ")}) (got ${JSON.stringify(v)})`);
        continue;
      }
      permissions[k] = val;
    }
    // A saved PRESET stamps all five resources + task explicitly; a composed (triage)
    // profile may be partial and takes the §2.1 runtime defaults, reported as such.
    for (const k of [...RESOURCES, "task"]) {
      if (permissions[k] !== undefined) continue;
      if (isPreset) errors.push(`preset "${name}" must stamp permissions.${k} explicitly (§2.1 defaults are for runtime overlays, not saved presets)`);
      else {
        permissions[k] = PERMISSION_DEFAULTS[k];
        defaulted.push(k);
      }
    }
  }

  // ── device: the P4 autonomy gate, machine-enforced ───────────────────────────
  if (permissions.device === "rw") {
    errors.push(`permissions.device = "rw" is rejected — calibration write-back is the P4 autonomy gate and it is not open (Rev 4)`);
  } else if (permissions.device && permissions.device !== "none") {
    warnings.push(`permissions.device = "${permissions.device}" — hardware access is opt-in (Rev 4 default is "none")`);
  }

  // ── task grant: flat-by-default, enforced by data (G-8) ──────────────────────
  if (permissions.task === "allow") {
    warnings.push(`permissions.task = "allow" — §8 success criterion (d) is ZERO grants in shipped profiles`);
    if (!str(profile.task_grant_justification)) {
      errors.push(`permissions.task = "allow" requires a non-empty task_grant_justification naming the dynamic-decomposition case`);
    }
    if ((runtimes ?? []).includes("claude-code")) {
      errors.push(`permissions.task = "allow" must never compile to a Claude Code variant — drop "claude-code" from runtimes (§2.1 compiler rule)`);
    }
  }

  // ── skills: exist, tagged, surface-consistent, entitlement-filtered ──────────
  const declaredSkills = strList(profile.skills);
  if (declaredSkills === undefined) errors.push(`missing required key "skills" (a list; may be empty)`);
  const { codes, source: entitlementSource } = readEntitlements(argv, warnings);
  const skills: string[] = [];
  const skillsFiltered: Array<{ name: string; reason: string }> = [];
  for (const sk of declaredSkills ?? []) {
    const sksurface = skillSurface(skillsRoots, sk);
    if (sksurface === null) {
      // §3.1's "missing skill" failure path: loud, pre-injection.
      errors.push(`skill "${sk}" does not exist (no SKILL.md under any skills root: ${skillsRoots.join(", ")})`);
      continue;
    }
    if (sksurface === undefined) {
      errors.push(`skill "${sk}" has no surface: tag`);
      continue;
    }
    if (!(SURFACES as readonly string[]).includes(sksurface)) {
      errors.push(`skill "${sk}" has unknown surface "${sksurface}"`);
      continue;
    }
    if (surface === "public" && sksurface !== "public") {
      errors.push(`surface = public but stages internal skill "${sk}" (a public-ring profile may only stage public skills)`);
      continue;
    }
    // §3.1's "unentitled package" failure path: a private-package dev skill needs the
    // packages root, and that is a PROFILE defect, not a filterable one.
    if (sk.endsWith("-dev") && permissions.packages !== "ro" && permissions.packages !== "rw") {
      errors.push(`stages package-dev skill "${sk}" but permissions.packages = "${permissions.packages ?? ""}" — a private-package dev skill needs at least "ro" on the packages root`);
      continue;
    }
    // ENTITLEMENT FILTER (the resolver's own job, distinct from the errors above):
    // public skills are always visible; the internal ring requires a held entitlement
    // code. Coarse v1 mapping, mirroring the extension's filterRepertoire rule that
    // empty/absent entitlements = the public surface only. Filtering DROPS a skill and
    // records why — it never fails the resolve, or an unentitled user could not open a
    // chat at all.
    if (sksurface !== "public" && codes.length === 0) {
      skillsFiltered.push({ name: sk, reason: "internal skill, no entitlement held" });
      continue;
    }
    skills.push(sk);
  }

  // ── gates + the verifiability rule ───────────────────────────────────────────
  const gates = strList(profile.gates);
  if (gates === undefined) errors.push(`missing required key "gates" (a list; may be empty)`);
  let runnableGates = 0;
  const gatesUnavailable: Array<{ name: string; status: string }> = [];
  for (const g of gates ?? []) {
    const status = gateStatus(gatesDir, g);
    if (status === null) {
      errors.push(`gate "${g}" does not resolve in the gate registry (no ${join(gatesDir, `${g}.toml`)})`);
      continue;
    }
    if (status === "available") runnableGates++;
    else {
      gatesUnavailable.push({ name: g, status });
      warnings.push(`gate "${g}" has registry status "${status}" — it cannot run yet, so it does not satisfy the verifiability rule`);
    }
  }
  // Authority rule 1 (§6.1): a below-frontier stamp is safe ONLY where a deterministic
  // gate catches a wrong answer. Ungated failure is silent failure. A model outside the
  // known ladder is treated as below-frontier — conservative on purpose.
  if (model && runnableGates === 0) {
    if ((FRONTIER_MODELS as readonly string[]).includes(model)) {
      /* a frontier stamp needs no gate */
    } else if ((LADDER as readonly string[]).includes(model)) {
      errors.push(`below-frontier model "${model}" with no runnable gate — the verifiability rule rejects ungated below-frontier stamps (§6.1 rule 1)`);
    } else {
      errors.push(`model "${model}" is not in the known tier ladder and has no runnable gate — unknown models are treated as below frontier (frontier: ${FRONTIER_MODELS.join(", ")})`);
    }
  }

  if (errors.length > 0) return fail(errors);

  // ── the lossy Claude-Code compile preview (§2.1) ─────────────────────────────
  // Write/Edit iff ANY PATH resource is rw — `device` is excluded, so a
  // {work="ro", device="rw"} profile gains no write tools through it. `ro` vs `none`
  // and the out-of-root read-only default cannot be expressed at CC tool level at all
  // and are dropped; CC relies on review + hooks as the backstop.
  const pathRw = PATH_RESOURCES.some((r) => permissions[r] === "rw");
  const tools = ["Read", "Glob", "Grep", "Bash", ...(pathRw ? ["Write", "Edit"] : []), ...(permissions.task === "allow" ? ["Agent"] : [])];

  return {
    json: {
      verb: "profile",
      subcommand: "resolve",
      ok: true,
      mode,
      path,
      name,
      surface,
      base: resolvedBase,
      base_declared: declaredBase,
      base_ignored: baseIgnored,
      spool_up_shell_rule: mode === "spool-up" ? "a chat is always the resident shell; a preset's base is ignored (§3.1)" : null,
      model,
      variant,
      task_type,
      skills,
      skills_declared: declaredSkills ?? [],
      skills_filtered: skillsFiltered,
      entitlements: { held: codes, source: entitlementSource },
      gates: gates ?? [],
      runnable_gates: runnableGates,
      gates_unavailable: gatesUnavailable,
      permissions,
      permissions_defaulted: defaulted,
      runtimes: runtimes ?? [],
      plan: "",
      compiled_preview: { claude_code: { tools: tools.join(", "), path_rw: pathRw, lossy: true } },
      warnings,
    },
    code: 0,
  };
}

// ── subcommand router ────────────────────────────────────────────────────────────
/** The `profile` verb body: route on the subcommand. Backs BOTH the CLI (amico.ts) and
 *  the MCP facade (mcp_serve.ts) — one impl, two transports. */
export function profileVerb(argv: string[]): VerbResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "resolve") return profileResolve(rest);
  return {
    json: {
      verb: "profile",
      error: `unknown subcommand ${sub ? `"${sub}"` : "(none)"}`,
      usage:
        "amico profile resolve (--name <preset> | --profile <file.toml>) [--mode spool-up|dispatch] [--profiles-dir D] [--skills-dir D (repeatable)] [--gates-dir D] [--entitlements a,b]",
    },
    code: 64,
  };
}

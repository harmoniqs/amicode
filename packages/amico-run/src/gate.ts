// The --spec launch gate (spec C) — the ONE enforcement point that is not an
// agent honor system, and it holds under both today's bash launch and the
// future Scheduler. Steps, in spec order: (1) schema validation; (2) import
// scan against the entitlement allowlist; (3) tier/env consistency incl. the
// per-binding Manifest staleness check (#74 extension — a project/sandbox
// env is validated against its OWN Manifest, not the extension-pinned one);
// (4) tier-2 masked-baseline check; (5) capability warrant, ARMED ONLY when a
// WarrantContext is passed (spec-20260727-164748 §5.1); (6) stamp assembly
// (canonical spec + gate-computed spec_hash). Any failure → no Julia process,
// one clear line.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { validate } from "@amicode/schema";
import type { AuthoringConfig } from "./authoring.js";
import { checkImports, scanImports } from "./import_scan.js";
import { maskedHash } from "./baseline.js";
import { loadExemplarsIndex } from "./catalog.js";
import { hasCloudConfig } from "./remote_config.js";
import { checkWarrant, type DeviceAccess, type SizeClass, type WarrantRefusal } from "./warrant.js";
import type { ApprovalRecord, PlanCompiledRecord } from "./ledger.js";

export interface GateStamp {
  tier?: string;
  hashes: Record<string, string>; // spec hashes + gate-computed spec_hash
  specCanonical: string; // stable-key-order JSON, what gets persisted
}

export type GateResult =
  | { ok: true; stamp: GateStamp }
  /** `refusal` is present only for a warrant refusal (step 5) — it carries the §5.2
   *  structured form (offending bound + what a covering warrant must declare), which
   *  a caller can turn into an approval request. `reason` alone stays the one-line
   *  human form every other step returns. */
  | { ok: false; reason: string; demote_to?: "free"; refusal?: WarrantRefusal };

/** Stable key order at every level so spec_hash is insensitive to author key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort())
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Julia Manifest v2 keys deps as [[deps.<Name>]] — the parsed `deps` object's
 *  keys ARE the package names. Every Project [deps] name must appear. */
function staleEnvCheck(projectDir: string): string | undefined {
  const projectFile = join(projectDir, "Project.toml");
  const manifestFile = join(projectDir, "Manifest.toml");
  if (!existsSync(projectFile)) return `env has no Project.toml at ${projectDir}`;
  if (!existsSync(manifestFile))
    return `env at ${projectDir} has no Manifest.toml — instantiate it first (JULIA_PKG_USE_CLI_GIT=true julia --project=${projectDir} -e 'using Pkg; Pkg.instantiate()')`;
  try {
    const project = parseToml(readFileSync(projectFile, "utf8")) as Record<string, unknown>;
    const manifest = parseToml(readFileSync(manifestFile, "utf8")) as Record<string, unknown>;
    const wanted = Object.keys((project.deps as Record<string, unknown>) ?? {});
    const present = new Set(Object.keys((manifest.deps as Record<string, unknown>) ?? {}));
    const missing = wanted.filter((name) => !present.has(name));
    if (missing.length > 0)
      return `stale env: ${missing.join(", ")} in Project.toml but not its Manifest — re-instantiate`;
  } catch (e) {
    return `env at ${projectDir} has an unparseable Project/Manifest: ${(e as Error).message}`;
  }
  return undefined;
}

/** Warrant-check context (spec-20260727-164748 §5.1). PASSING THIS ARMS THE CHECK —
 *  omit it and the warrant step does not run, which is the feature flag. Assembled by
 *  the launch path (it owns the ledger read and the clock); the gate stays pure. */
export interface WarrantContext {
  approvals: readonly ApprovalRecord[];
  now: number;
  /** From estimate.ts. UNDEFINED = unresolved, treated as over-threshold (§4.4). */
  sizeClass?: SizeClass;
  device?: DeviceAccess;
  solvesSoFar?: number;
  /** `plan_compiled` rows — the design_hash -> plan_hash binding the §4.6
   *  "the plan was recompiled" refusal joins on. */
  planCompiled?: readonly PlanCompiledRecord[];
}

export function runGate(
  specRaw: unknown,
  scriptText: string,
  authoring: AuthoringConfig,
  warrant?: WarrantContext,
): GateResult {
  // ── step 1: schema ──
  const validation = validate(specRaw, "solvespec");
  if (!validation.ok) return { ok: false, reason: `solvespec schema: ${validation.errors[0]}` };
  const spec = specRaw as Record<string, unknown>;
  const tier = typeof spec.tier === "string" ? spec.tier : undefined;
  const executor = typeof spec.executor === "string" ? spec.executor : undefined;
  const env = (typeof spec.env === "object" && spec.env !== null ? spec.env : undefined) as
    | { kind?: string; project?: string }
    | undefined;

  // ── step 2: import scan ──
  // A v4 problem_spec solvespec (schema: exactly one of script_path|problem_spec)
  // has no authored script — the ProblemSpec, validated in step 1 against Piccolo's
  // registries, IS the entitlement surface, and it routes to Piccolo.Specs.solve_spec.
  // Skip the script import scan for the scriptless tier.
  const hasScript = typeof spec.script_path === "string";
  if (hasScript) {
    const scanned = scanImports(scriptText);
    if (!scanned.ok) return { ok: false, reason: scanned.reason };
    const checked = checkImports(scanned.roots, authoring);
    if (!checked.ok) return { ok: false, reason: checked.reason };
  }

  // ── step 3: tier/env consistency ──
  if (tier === "free" && env?.kind !== "sandbox")
    return { ok: false, reason: 'free tier requires a sandbox env (env.kind = "sandbox")' };
  // hpc = the paid High-Performance + Cloud tier: cloud-only by construction.
  // It NEVER runs locally and NEVER touches a sandbox (which would try to
  // Pkg.instantiate the private Piccolissimo package against a registry that
  // doesn't have it). This is the durable backstop to the extension's
  // pre-launch key check — an agent or a direct CLI call can't run hpc locally.
  if (tier === "hpc") {
    if (executor !== "remote")
      return {
        ok: false,
        reason: "Piccolissimo + Altissimo runs in Harmoniqs Cloud — set executor = remote (it cannot run locally)",
      };
    if (env?.kind !== "provisioned")
      return {
        ok: false,
        reason:
          'Piccolissimo + Altissimo uses the pre-baked Harmoniqs Cloud environment — set env.kind = "provisioned" (not a local sandbox)',
      };
    if (!hasCloudConfig())
      return {
        ok: false,
        reason:
          "Piccolissimo + Altissimo needs a Harmoniqs Cloud connection — connect your API key (Amico: Connect Cloud) before running",
      };
  }
  if ((env?.kind === "project" || env?.kind === "sandbox") && env.project) {
    const stale = staleEnvCheck(env.project);
    if (stale) return { ok: false, reason: stale };
  }

  // ── step 4: composed → masked baseline vs the exemplar's build-time hash ──
  if (tier === "composed") {
    const exemplarId = (spec.source as Record<string, unknown> | undefined)?.exemplar_id;
    if (typeof exemplarId !== "string") return { ok: false, reason: 'tier "composed" requires source.exemplar_id' };
    const index = loadExemplarsIndex(authoring.exemplars ?? "");
    const entry = index.exemplars.find((e) => e.id === exemplarId);
    if (!entry)
      return { ok: false, reason: `unknown exemplar_id "${exemplarId}" (index: ${authoring.exemplars ?? "absent"})` };
    if (maskedHash(scriptText, entry.fill_begin, entry.fill_end) !== entry.baseline_hash)
      return {
        ok: false,
        reason: `script is no longer the exemplar's physics (edits outside the fill points of "${exemplarId}") — re-assemble as tier "free"`,
        demote_to: "free",
      };
  }

  // ── step 5: capability warrant (spec-20260727-164748 §5.1) ──
  // Ordered AFTER the consistency checks so a malformed or inconsistent spec fails as
  // that, not as "unwarranted", and BEFORE stamp assembly so no hash is minted for a
  // launch that will not run. THE FEATURE FLAG IS THE ABSENCE OF `warrant`: with no
  // context passed, this step does not exist and no existing caller changes behavior.
  if (warrant) {
    const check = checkWarrant(
      {
        plan_hash: typeof spec.plan_hash === "string" ? spec.plan_hash : undefined,
        tier,
        executor,
        sizeClass: warrant.sizeClass,
        device: warrant.device,
        solvesSoFar: warrant.solvesSoFar,
      },
      warrant.approvals,
      warrant.now,
      warrant.planCompiled ?? [],
    );
    if (!check.ok) return { ok: false, reason: check.reason, refusal: check };
  }

  // ── step 6: stamp — canonical spec + gate-computed spec_hash ──
  const specCanonical = JSON.stringify(canonicalize(spec), null, 2);
  const specHash = "sha256:" + createHash("sha256").update(specCanonical).digest("hex");
  const hashes: Record<string, string> = {};
  if (typeof spec.hashes === "object" && spec.hashes !== null)
    for (const [key, value] of Object.entries(spec.hashes as Record<string, unknown>))
      if (typeof value === "string") hashes[key] = value;
  hashes.spec_hash = specHash;
  return { ok: true, stamp: { tier, hashes, specCanonical } };
}

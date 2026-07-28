// packages/amico-run/src/plan_compile.ts — `amico plan compile` (spec-20260728 §4).
//
// Spec -> planner subprocess -> stamped plan -> schema validation -> the §4.2 budget refusals ->
// only THEN a file on disk and one `plan_compiled` row.
//
// ORDERING IS LOAD-BEARING IN TWO PLACES:
//
// 1. Validation comes AFTER stamping. `plan.schema.json` REQUIRES `plan_hash`, `design_hash` and
//    `schema_version`, none of which the planner produces — `plan_hash` is `planHash({goal,
//    steps})`, computed here. Validating the planner's raw output against that schema could only
//    ever fail. (§4.1's prose had validate-then-hash; it is not implementable.)
//
// 2. Refusals come BEFORE any write. A plan that violates its approved budget must not exist on
//    disk, or the next `plan status` reads a plan nobody authorised.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, designHash, planHash, validate } from "@amicode/schema";
import { runAgent, criticModel, resolveAgentBin, type AgentOutcome } from "./agent_spawn.js";
import { parseFrontmatter } from "./frontmatter.js";
import {
  appendRecord,
  readRecords,
  TASK_TYPES,
  type LedgerRecord,
  type PlanCompiledRecord,
  type SpecReviewRecord,
} from "./ledger.js";
import { DEVICE_ORDER } from "./warrant.js";
import type { DeviceAccess } from "./warrant.js";

/** Task types that consume a solve. §4.2 sums these against `budget.max_solves`. */
const SOLVE_BEARING = new Set(["experiment-sim", "experiment-hw"]);

/** Bounds that CANNOT be checked at compile time, disclosed rather than silently skipped.
 *
 *  - `max_size_class` comes from `estimate.ts` resolving a SOLVESPEC, which does not exist yet.
 *  - `tier` is the same story and it took three revisions to see it. `bounds.tier` speaks the
 *    solvespec TRUST vocabulary (`free|composed|vetted|hpc` — solvespec.schema.json), while a
 *    plan step's tier field is `model`, holding a model id (fleet §5.1: "no `tier` alias; the
 *    feature is called tier dispatch, the field is called `model`"). A model id can never equal
 *    `hpc`, so comparing them — by order OR by equality — is a category error, not a strictness
 *    choice. It is a first-launch refusal, where `LaunchFacts.tier` actually exists.
 *
 *  Disclosure is the point: "we checked everything we could and here is what we could not" is a
 *  different claim from "checked", and only one of them is true. */
export const UNCHECKED_BOUNDS = ["max_size_class", "tier"] as const;

export interface CompiledStep {
  id: string;
  model: string;
  task_type: string;
  variant?: string;
  gates?: string[];
  needs?: string[];
  optional?: boolean;
  permissions?: { device?: DeviceAccess };
}

export interface CompileRefusal {
  ok: false;
  exit_code: 64 | 65;
  /** One line per exceeded bound. Each bound names ITSELF and its margin, matching the
   *  convention `warrant.test.ts` established for the launch gate — a caller fixing three
   *  problems should not have to re-run three times to discover them. */
  errors: string[];
}

export interface CompileSuccess {
  ok: true;
  plan_hash: string;
  design_hash: string;
  spec_id: string;
  plan_path: string;
  step_count: number;
  advisory_count: number;
  suggested_ttl_s: number;
  allow_unreviewed: boolean;
  unchecked: readonly string[];
  compiled_by?: { model: string; variant: string };
}

export type CompileResult = CompileSuccess | CompileRefusal;

const refuse = (exit_code: 64 | 65, ...errors: string[]): CompileRefusal => ({ ok: false, exit_code, errors });

/** One hour per step, floor 1h, ceiling 24h — a RECOMMENDATION only.
 *
 *  `plan compile` records it; `amico ledger approve` reads it to default `--expires-in` and
 *  remains the sole writer of `expires_at`. Compile must not own a warrant's lifetime: the TTL
 *  sits beside `issued_by` on the approval, which is the human authorization act, and under
 *  `--recompile` a compile-owned TTL would silently re-set how long that authorization lasts. */
export function suggestedTtlFor(stepCount: number): number {
  return Math.min(Math.max(stepCount, 1) * 3600, 24 * 3600);
}

/** The §4.2 budget refusal. Pure, so the whole refusal matrix is testable without a subprocess. */
export function checkBudget(steps: CompiledStep[], budget: Record<string, unknown> | undefined): string[] {
  const errors: string[] = [];

  // A launch-shaped plan with no budget at all is not "unbounded", it is unapproved.
  const solveSteps = steps.filter((s) => SOLVE_BEARING.has(s.task_type));
  const deviceSteps = steps.filter((s) => (s.permissions?.device ?? "none") !== "none");
  if (budget === undefined) {
    if (solveSteps.length > 0 || deviceSteps.length > 0) {
      errors.push(
        `the spec declares no budget, but the compiled plan demands ${[
          solveSteps.length > 0 ? `${solveSteps.length} solve(s)` : undefined,
          deviceSteps.length > 0 ? "device access" : undefined,
        ]
          .filter(Boolean)
          .join(" and ")} — add a budget to the spec, or restructure the plan`,
      );
    }
    return errors;
  }

  // device: join by the EXPORTED DEVICE_ORDER, so compile and the launch gate cannot drift.
  const demandedDevice = steps.reduce<DeviceAccess>((acc, s) => {
    const d = s.permissions?.device ?? "none";
    return DEVICE_ORDER[d] > DEVICE_ORDER[acc] ? d : acc;
  }, "none");
  if (demandedDevice !== "none") {
    const authorised = budget.device as DeviceAccess | undefined;
    if (authorised === undefined) {
      // NEVER default-allow. The launch gate refuses a bound it was not granted
      // (warrant.test.ts's established rule); the compile side needs the same direction, or a
      // budget could authorise device access by saying nothing about it.
      errors.push(
        `device: the plan demands "${demandedDevice}" (step ${steps.find((s) => (s.permissions?.device ?? "none") === demandedDevice)?.id}) but the budget does not declare device at all — an omitted bound is not permission`,
      );
    } else if (DEVICE_ORDER[demandedDevice] > DEVICE_ORDER[authorised]) {
      errors.push(`device: the plan demands "${demandedDevice}" but the budget authorises "${authorised}"`);
    }
  }

  // solves: SUM over solve-bearing steps, with the margin named.
  if (solveSteps.length > 0) {
    const authorised = budget.max_solves;
    if (typeof authorised !== "number") {
      errors.push(
        `max_solves: the plan has ${solveSteps.length} solve-bearing step(s) but the budget does not declare max_solves — an omitted bound is not permission`,
      );
    } else if (solveSteps.length > authorised) {
      errors.push(
        `max_solves: the plan needs ${solveSteps.length} solve(s) but the budget authorises ${authorised} — over by ${solveSteps.length - authorised}`,
      );
    }
  }
  return errors;
}

/** Steps must declare what the budget check reads. An absent field is a REFUSAL: treating it as
 *  "no demand" is how §0.1's `max_solves` counter sat inert while reading as enforced. */
export function checkStepShape(steps: unknown): { steps: CompiledStep[] } | { errors: string[] } {
  if (!Array.isArray(steps) || steps.length === 0) return { errors: ["the planner returned no steps"] };
  const errors: string[] = [];
  const out: CompiledStep[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of steps.entries()) {
    if (!raw || typeof raw !== "object") {
      errors.push(`step ${i}: not an object`);
      continue;
    }
    const s = raw as Record<string, unknown>;
    const id = typeof s.id === "string" ? s.id : "";
    if (id === "") errors.push(`step ${i}: missing id`);
    else if (seen.has(id)) errors.push(`step ${i}: duplicate id "${id}" — derivation keys on it, so ids must be unique`);
    seen.add(id);
    if (typeof s.model !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(s.model))
      errors.push(`step "${id}": model must be a provider/model-id — without it no tier demand can be determined`);
    if (typeof s.task_type !== "string" || !(TASK_TYPES as readonly string[]).includes(s.task_type))
      errors.push(`step "${id}": task_type must be one of (${TASK_TYPES.join(", ")}) — it decides whether the step consumes a solve`);
    const device = (s.permissions as { device?: unknown } | undefined)?.device;
    if (device !== undefined && !Object.prototype.hasOwnProperty.call(DEVICE_ORDER, String(device)))
      errors.push(`step "${id}": permissions.device must be one of (none, ro, rw)`);
    // OMIT absent keys rather than setting them undefined. `canonicalJson` serialises undefined
    // as `null`, so a step built with `optional: undefined` writes `"optional": null` — which
    // fails the plan schema on re-read (`must be boolean`) and makes the artifact unable to
    // round-trip. It also means a step that omits a field and one that sets it undefined would
    // hash identically only by accident; compacting here makes plan_hash a function of the
    // content rather than of how the object happened to be constructed.
    out.push({
      id,
      model: String(s.model),
      task_type: String(s.task_type),
      ...(typeof s.variant === "string" ? { variant: s.variant } : {}),
      ...(Array.isArray(s.gates) ? { gates: s.gates.map(String) } : {}),
      ...(Array.isArray(s.needs) ? { needs: s.needs.map(String) } : {}),
      ...(s.optional === true ? { optional: true as const } : {}),
      ...(device === undefined ? {} : { permissions: { device: device as DeviceAccess } }),
    });
  }
  // Fleet §8: a below-frontier step with no gate is unverified work by a cheaper model.
  for (const s of out) {
    if (!isFrontier(s.model) && (s.gates === undefined || s.gates.length === 0))
      errors.push(`step "${s.id}": model ${s.model} is below the frontier tier and declares no gates — unverified cheap work is refused here and again by the harness at dispatch`);
  }
  return errors.length > 0 ? { errors } : { steps: out };
}

/** Frontier = opus-class. Deliberately a substring test rather than an allowlist: a new opus
 *  point-release must not silently become "below frontier" and start requiring gates it does
 *  not need, and the failure direction of a wrong guess here is a spurious refusal (loud) rather
 *  than ungated cheap work (silent). */
function isFrontier(model: string): boolean {
  return /opus/i.test(model);
}

/** The latest review for a design, if any. */
export function latestReview(records: readonly LedgerRecord[], designHash: string): SpecReviewRecord | undefined {
  const rows = records.filter((r): r is SpecReviewRecord => r.type === "spec_review" && r.design_hash === designHash);
  return rows.length === 0 ? undefined : rows[rows.length - 1];
}

export interface CompileOptions {
  /** `--recompile`: required when a plan for this design has already been approved. */
  recompile?: boolean;
  /** `--allow-unreviewed`: compile from an `approved-mechanical` / `degraded` review. */
  allowUnreviewed?: boolean;
  /** Where the plan note is written (the vault's `plans/` folder). */
  plansDir: string;
  /** Test seam for the planner subprocess. */
  runPlanner?: (specText: string) => Promise<AgentOutcome>;
  now?: () => string;
  env?: NodeJS.ProcessEnv;
  append?: boolean;
  /** Injected so the approval lookup is testable without a real ledger. */
  records?: readonly LedgerRecord[];
  warn?: (msg: string) => void;
}

export async function compilePlan(specPath: string, raw: string, opts: CompileOptions): Promise<CompileResult> {
  const fm = parseFrontmatter(raw);
  if (!fm.ok) return refuse(65, `the spec's frontmatter could not be read: ${fm.error}`);
  const spec = fm.data;
  const specValid = validate(spec, "spec");
  if (!specValid.ok) return refuse(65, ...specValid.errors.map((e) => `spec: ${e}`));

  const spec_id = String(spec.spec_id);
  const design_hash = requireDesignHash(spec);
  const records = opts.records ?? safeRecords();

  // ── the review precondition ──
  // A spec whose review found blocking findings is not compilable at all; one that was only
  // mechanically reviewed is compilable with an explicit acknowledgement, which the row records.
  const review = latestReview(records, design_hash);
  let allow_unreviewed = false;
  if (review === undefined) {
    if (!opts.allowUnreviewed)
      return refuse(65, `no review on record for this spec (design ${design_hash.slice(0, 12)}) — run \`amico spec review\` first, or pass --allow-unreviewed to compile anyway`);
    allow_unreviewed = true;
  } else if (review.review_verdict === "blocking" || review.review_verdict === "exhausted") {
    return refuse(65, `the latest review of this spec is \`${review.review_verdict}\` with ${review.blocking_count} blocking finding(s) — revise the spec; --allow-unreviewed does NOT override a blocking review`);
  } else if (review.review_verdict !== "approved") {
    if (!opts.allowUnreviewed)
      return refuse(65, `the latest review is \`${review.review_verdict}\` — no critic actually reviewed this spec. Pass --allow-unreviewed to compile anyway (it will be recorded)`);
    allow_unreviewed = true;
  }

  // ── recompilation (§4.6) ──
  // Recompiling mints a new plan_hash, invalidating a live warrant. That is correct but it must
  // be LOUD, because the failure otherwise surfaces later as a bare launch denial.
  const priorApproved = records.some(
    (r) => r.type === "approval" && records.some((p) => p.type === "plan_compiled" && p.design_hash === design_hash && p.plan_hash === (r as { plan_hash: string }).plan_hash),
  );
  if (priorApproved && !opts.recompile)
    return refuse(65, `a plan for this spec has already been APPROVED. Recompiling mints a new plan_hash and invalidates that approval — pass --recompile if that is what you want`);
  if (priorApproved && opts.recompile)
    (opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`)))(
      `amico plan compile: recompiling invalidates the existing approval for this spec — the launch gate will say "the plan was recompiled; re-approve" until you run \`amico ledger approve\` on the new plan_hash`,
    );

  // ── the planner call ──
  const planner = opts.runPlanner ?? defaultPlanner(specPath, opts.env);
  if (planner === undefined)
    return refuse(64, `no agent binary available to compile a plan (set $AMICO_CRITIC_BIN, or install the agent CLI on PATH). Nothing was written.`);
  const out = await planner(raw);
  if (out.status !== "ran")
    return refuse(64, `the planner produced no usable plan: ${out.reason ?? "unknown"}. Nothing was written.`);

  const payload = out.payload ?? {};
  const shaped = checkStepShape(payload.steps);
  if ("errors" in shaped) return refuse(65, ...shaped.errors);
  const goal = typeof payload.goal === "string" && payload.goal.trim() !== "" ? payload.goal.trim() : undefined;
  if (goal === undefined) return refuse(65, "the planner returned no goal");

  // ── the budget refusal, BEFORE anything is written ──
  const budgetErrors = checkBudget(shaped.steps, spec.budget as Record<string, unknown> | undefined);
  // A non-launch-shaped spec that compiled to a solve-bearing step is mislabelled, and the
  // mislabelling silently disables two blocking tier-1 lenses (§2.2) and makes this whole check
  // a no-op. Naming the task_type is more useful than naming the budget.
  const launchShaped = ["experiment-sim", "experiment-hw", "author-script"].includes(String(spec.task_type));
  if (!launchShaped && shaped.steps.some((s) => SOLVE_BEARING.has(s.task_type)))
    budgetErrors.push(
      `task_type: the spec is \`${spec.task_type}\` (not launch-shaped) but compiled to a solve-bearing step — relabel the spec, or the budget and baseline lenses stay switched off for work that spends`,
    );
  if (budgetErrors.length > 0) return refuse(65, ...budgetErrors);

  // ── stamp, THEN validate ──
  const nowIso = (opts.now ?? (() => new Date().toISOString()))();
  const plan_hash = planHash({ goal, steps: shaped.steps as unknown as Record<string, unknown>[] });
  const advisories = advisoriesFrom(spec);
  const suggested_ttl_s = suggestedTtlFor(shaped.steps.length);
  const plan_id = `plan-${nowIso.replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-")}-${slug(goal)}`;
  const compiled_by = out.model ? { model: out.model, variant: out.variant ?? "default" } : undefined;

  const planObject: Record<string, unknown> = {
    type: "plan",
    schema_version: "1",
    plan_id,
    goal,
    max_replans: 3,
    plan_hash,
    design_hash,
    compiled_at: nowIso,
    ...(compiled_by ? { compiled_by } : {}),
    suggested_ttl_s,
    spec: spec_id,
    steps: shaped.steps,
    ...(advisories.length > 0 ? { advisories } : {}),
  };
  const planValid = validate(planObject, "plan");
  if (!planValid.ok) return refuse(65, ...planValid.errors.map((e) => `compiled plan: ${e}`));

  // ── write, then record ──
  const plan_path = join(opts.plansDir, `${plan_id}.md`);
  try {
    writeFileSync(plan_path, renderPlanNote(planObject, shaped.steps, advisories));
  } catch (e) {
    return refuse(64, `could not write the compiled plan to ${plan_path}: ${(e as Error).message}`);
  }

  const rec: PlanCompiledRecord = {
    type: "plan_compiled",
    ts: nowIso,
    plan_hash,
    spec_id,
    design_hash,
    step_count: shaped.steps.length,
    advisory_count: advisories.length,
    suggested_ttl_s,
    source: "user",
    ...(compiled_by ? { compiled_by } : {}),
    ...(allow_unreviewed ? { allow_unreviewed: true } : {}),
  };
  if (opts.append !== false) appendRecord(rec);

  return {
    ok: true,
    plan_hash,
    design_hash,
    spec_id,
    plan_path,
    step_count: shaped.steps.length,
    advisory_count: advisories.length,
    suggested_ttl_s,
    allow_unreviewed,
    unchecked: UNCHECKED_BOUNDS,
    compiled_by,
  };
}

/** Surviving advisories become the plan's obligations: a plan cannot reach `complete` while one
 *  is open, which is where tier-2 critics get their teeth (§3.6). */
function advisoriesFrom(spec: Record<string, unknown>): Array<Record<string, unknown>> {
  const review = spec.review;
  if (!review || typeof review !== "object") return [];
  const raw = (review as { advisories?: unknown }).advisories;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a, i) => ({
      id: typeof a.id === "string" && a.id !== "" ? a.id : `adv-${i + 1}`,
      lens: typeof a.lens === "string" ? a.lens : undefined,
      claim: typeof a.claim === "string" ? a.claim : undefined,
      remedy: typeof a.remedy === "string" ? a.remedy : undefined,
      round: typeof a.round === "number" ? a.round : undefined,
    }))
    .map((a) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)));
}

/** The design_hash this plan is compiled from.
 *
 *  Prefer the one the review stamped, so plan and review provably refer to the same decision
 *  surface. Recompute when there is none: a never-reviewed spec still HAS a decision surface, and
 *  the hash is a pure function of it — refusing here would block `--allow-unreviewed` entirely. */
function requireDesignHash(spec: Record<string, unknown>): string {
  const review = spec.review as { design_hash?: unknown } | undefined;
  if (review && typeof review.design_hash === "string" && /^[0-9a-f]{64}$/.test(review.design_hash))
    return review.design_hash;
  return designHash(spec);
}

function slug(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "plan";
}

/** The plan NOTE: typed frontmatter plus a readable body.
 *
 *  Hand-editing a compiled plan is a lint failure — the compiler is the only writer — so the body
 *  says so where someone about to edit it will see it. */
function renderPlanNote(
  plan: Record<string, unknown>,
  steps: CompiledStep[],
  advisories: Array<Record<string, unknown>>,
): string {
  // JSON-encode EVERY value. `String("1")` writes a bare `1`, which YAML reads back as the
  // NUMBER 1 — so the plan this function wrote would fail `validate(…, "plan")` on re-read
  // (schema_version is the string enum ["1"]). The round-trip is the whole point: a warrant is
  // bound to plan_hash, and the file is what a human and `plan status` both read. JSON is a YAML
  // subset, so this is unambiguous for scalars, lists and maps alike.
  const fmLines = Object.entries(plan)
    .filter(([k]) => k !== "steps" && k !== "advisories")
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const stepLines = ["steps:", ...steps.map((s) => `  - ${canonicalJson(s as never)}`)];
  const advLines = advisories.length === 0 ? [] : ["advisories:", ...advisories.map((a) => `  - ${canonicalJson(a as never)}`)];
  const body = [
    `# ${plan.goal}`,
    "",
    "> COMPILED ARTIFACT — do not hand-edit. `plan_hash` is `sha256(canonicalJson({goal, steps}))`,",
    "> and an approved warrant is bound to it; editing this file silently detaches the two. Change",
    "> the spec and re-run `amico plan compile --recompile`.",
    "",
    "## Steps",
    "",
    ...steps.map(
      (s) =>
        `- **${s.id}** — \`${s.task_type}\` on \`${s.model}\`${s.optional ? " *(optional)*" : ""}` +
        `${s.needs?.length ? `, after ${s.needs.join(", ")}` : ""}` +
        `${s.gates?.length ? `, gated by ${s.gates.join(", ")}` : ""}` +
        `${s.permissions?.device && s.permissions.device !== "none" ? `, device ${s.permissions.device}` : ""}`,
    ),
    "",
    ...(advisories.length === 0
      ? ["## Advisories", "", "None surviving. (A plan cannot reach `complete` while an advisory is open.)"]
      : [
          "## Advisories — obligations, not suggestions",
          "",
          "This plan cannot reach `complete` while any of these is open. Close one with",
          "`amico plan advisory <id> --state fixed|waived --reason <r>|obsolete`.",
          "",
          ...advisories.map((a) => `- **${a.id}** (${a.lens ?? "critic"}) — ${a.claim ?? ""}${a.remedy ? ` → ${a.remedy}` : ""}`),
        ]),
    "",
  ].join("\n");
  return `---\n${[...fmLines, ...stepLines, ...advLines].join("\n")}\n---\n\n${body}`;
}

function safeRecords(): readonly LedgerRecord[] {
  try {
    return readRecords();
  } catch {
    return [];
  }
}

/** The real planner: the §3.7 mechanism with `--agent planner`. */
function defaultPlanner(specPath: string, env?: NodeJS.ProcessEnv): ((specText: string) => Promise<AgentOutcome>) | undefined {
  const e = env ?? process.env;
  const bin = resolveAgentBin(e);
  if (bin === undefined) return undefined;
  return (specText: string) =>
    runAgent({
      bin,
      agent: "planner",
      model: criticModel(e),
      env: e,
      prompt: "Compile the spec in your working directory into a plan. Reply with the JSON object only.",
      specText,
      specFilename: specPath.split("/").pop() ?? "spec.md",
    });
}

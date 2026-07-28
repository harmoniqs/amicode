// packages/amico-run/src/plan_verb.ts — the `amico plan` verb (spec-20260728 §4).
//
//   amico plan compile  <spec-path> [--recompile] [--allow-unreviewed] [--plans-dir <d>] [--json]
//   amico plan status   [<plan-hash>] [--json]
//   amico plan advisory <id> --state fixed|waived|obsolete [--reason <r>] [--plan <hash>]
//
// THERE IS NO `amico plan todo` AND NO WRITE PATH FOR STEP STATE. Step state is derived from gate
// verdicts (plan_state.ts); the only thing this verb writes is an ADVISORY transition, which is
// genuine judgment rather than a fact a gate established.
//
// Conventions mirror `spec_verb.ts` deliberately: the path is POSITIONAL (`--spec` belongs to the
// launch path), unknown flags are usage errors rather than being ignored, and the outcome rides
// the JSON payload as well as the exit code because the MCP facade discards `VerbResult.code`.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { appendRecord, readRecords, type LedgerRecord, type TodoRecord } from "./ledger.js";
import { compilePlan, type CompileResult } from "./plan_compile.js";
import { derivePlanState, type PlanShape } from "./plan_state.js";
import { resolveMountStack } from "./mounts.js";
import type { VerbResult } from "./verbs.js";

const USAGE = [
  "amico plan compile  <spec-path> [--recompile] [--allow-unreviewed] [--plans-dir <d>] [--json]",
  "amico plan status   [<plan-hash>] [--json]",
  "amico plan advisory <id> --state fixed|waived|obsolete [--reason <r>] [--plan <hash>]",
  "",
  "There is no `plan todo` and no way to write step state: it is DERIVED from gate verdicts,",
  "so `passed` cannot be claimed without a gate having agreed.",
].join("\n");

const usageError = (error: string): VerbResult => ({ json: { verb: "plan", ok: false, error, usage: USAGE }, code: 64 });

const ADVISORY_STATES = new Set(["fixed", "waived", "obsolete"]);

const KNOWN_FLAGS = new Set(["--recompile", "--allow-unreviewed", "--plans-dir", "--json", "--state", "--reason", "--plan"]);
const VALUED_FLAGS = new Set(["--plans-dir", "--state", "--reason", "--plan"]);

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
}

/** Validate EVERY flag, then return the first positional.
 *
 *  Scanning the whole argv matters: returning at the first non-flag argument would leave TRAILING
 *  flags unvalidated, so `plan compile <path> --forcefully` would silently ignore the typo and
 *  behave as though the caller had asked for nothing. Refusing loudly is the point of having a
 *  known-flag set at all. */
function positional(argv: string[]): { value?: string } | { error: string } {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (!KNOWN_FLAGS.has(name)) return { error: `unknown flag ${name}` };
      if (VALUED_FLAGS.has(name) && !a.includes("=")) i++; // consume its value
      continue;
    }
    if (value === undefined) value = a;
  }
  return value === undefined ? {} : { value };
}

/** The vault's `plans/` folder — the folder `amico-vault` already defines for `type: plan`.
 *  First WRITABLE mount in stack order; a read-only mount is never written to. */
function defaultPlansDir(env: NodeJS.ProcessEnv): string | undefined {
  const override = env.AMICO_PLANS_DIR;
  if (override !== undefined && override.trim() !== "") return override;
  const writable = resolveMountStack().mounts.find((m) => m.writable);
  return writable ? join(writable.path, "plans") : undefined;
}

async function compile(argv: string[], ctx: PlanVerbCtx): Promise<VerbResult> {
  const pos = positional(argv);
  if ("error" in pos) return usageError(pos.error);
  if (pos.value === undefined) return usageError("a spec path is required (positional, not --spec)");
  const abs = resolve(pos.value);
  if (!existsSync(abs)) return usageError(`spec not found: ${abs}`);

  const plansDir = flagValue(argv, "--plans-dir") ?? ctx.plansDir ?? defaultPlansDir(ctx.env ?? process.env);
  if (plansDir === undefined)
    return usageError("no writable vault mount for plans/ — pass --plans-dir, or set $AMICO_PLANS_DIR");
  if (!existsSync(plansDir)) return usageError(`plans directory does not exist: ${plansDir}`);

  let r: CompileResult;
  try {
    r = await compilePlan(abs, (ctx.readFile ?? readFileSync)(abs, "utf8") as string, {
      plansDir,
      recompile: argv.includes("--recompile"),
      allowUnreviewed: argv.includes("--allow-unreviewed"),
      runPlanner: ctx.runPlanner,
      records: ctx.records,
      env: ctx.env,
    });
  } catch (e) {
    return { json: { verb: "plan", subcommand: "compile", ok: false, error: (e as Error).message }, code: 64 };
  }

  if (!r.ok) {
    return {
      json: { verb: "plan", subcommand: "compile", ok: false, exit_code: r.exit_code, errors: r.errors },
      code: r.exit_code,
    };
  }
  return {
    json: {
      verb: "plan",
      subcommand: "compile",
      ok: true,
      plan_hash: r.plan_hash,
      design_hash: r.design_hash,
      spec_id: r.spec_id,
      plan_path: r.plan_path,
      step_count: r.step_count,
      advisory_count: r.advisory_count,
      suggested_ttl_s: r.suggested_ttl_s,
      allow_unreviewed: r.allow_unreviewed,
      // Never silently: the caller is told which bounds compile could not check, so "compiled"
      // does not read as "fully budget-checked".
      unchecked: r.unchecked,
      compiled_by: r.compiled_by,
      next: `amico ledger approve --plan ${r.plan_hash} --expires-in ${r.suggested_ttl_s}s`,
    },
    code: 0,
  };
}

/** Find a compiled plan note by plan_hash. */
function loadPlan(plansDir: string, planHash: string): PlanShape | undefined {
  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return undefined;
  }
  for (const f of entries) {
    if (!f.endsWith(".md")) continue;
    let fm;
    try {
      fm = parseFrontmatter(readFileSync(join(plansDir, f), "utf8"));
    } catch {
      continue;
    }
    if (!fm.ok || fm.data.plan_hash !== planHash) continue;
    const steps = Array.isArray(fm.data.steps) ? (fm.data.steps as Record<string, unknown>[]) : [];
    const advisories = Array.isArray(fm.data.advisories) ? (fm.data.advisories as Record<string, unknown>[]) : [];
    return {
      plan_hash: planHash,
      steps: steps.map((s) => ({ id: String(s.id), optional: s.optional === true ? true : undefined })),
      advisories: advisories.map((a) => ({
        id: String(a.id),
        lens: typeof a.lens === "string" ? a.lens : undefined,
        claim: typeof a.claim === "string" ? a.claim : undefined,
      })),
      max_replans: typeof fm.data.max_replans === "number" ? fm.data.max_replans : undefined,
    };
  }
  return undefined;
}

function status(argv: string[], ctx: PlanVerbCtx): VerbResult {
  const pos = positional(argv);
  if ("error" in pos) return usageError(pos.error);
  const records = ctx.records ?? safeRecords();
  const plansDir = flagValue(argv, "--plans-dir") ?? ctx.plansDir ?? defaultPlansDir(ctx.env ?? process.env);

  // Default to the most recently compiled plan: the common case is "what is the state of the
  // thing I just made", and making the hash mandatory would mean copying it around by hand.
  const compiled = records.filter((r): r is Extract<LedgerRecord, { type: "plan_compiled" }> => r.type === "plan_compiled");
  const planHash = pos.value ?? compiled[compiled.length - 1]?.plan_hash;
  if (planHash === undefined)
    return { json: { verb: "plan", subcommand: "status", ok: true, plans: [], note: "no plan has been compiled yet" }, code: 0 };

  const row = compiled.filter((r) => r.plan_hash === planHash).pop();
  const shape = plansDir ? loadPlan(plansDir, planHash) : undefined;
  if (shape === undefined) {
    // A clean empty answer, not a crash: the ledger may know about a plan whose note was moved
    // or whose vault is not mounted here, and that is worth SAYING rather than throwing.
    return {
      json: {
        verb: "plan",
        subcommand: "status",
        ok: true,
        plan_hash: planHash,
        known_to_ledger: row !== undefined,
        note: row
          ? `the ledger records this plan (${row.step_count} steps) but its note was not found under ${plansDir ?? "(no plans dir)"} — step state cannot be derived without the compiled steps`
          : `no plan with hash ${planHash} is known`,
      },
      code: 0,
    };
  }

  const view = derivePlanState(records, shape);
  // Remaining warrant time comes from the APPROVAL record, which is the sole writer of
  // expires_at. Reading `suggested_ttl_s` off plan_compiled instead would report a
  // RECOMMENDATION as if it were the authorization's actual lifetime.
  const approval = records
    .filter((r): r is Extract<LedgerRecord, { type: "approval" }> => r.type === "approval" && r.plan_hash === planHash)
    .pop();
  const nowMs = ctx.nowMs ? ctx.nowMs() : Date.now();
  const expiresMs = approval ? Date.parse(approval.expires_at) : NaN;
  const warrant = approval
    ? {
        issued_by: approval.issued_by,
        expires_at: approval.expires_at,
        // An unparseable expiry is ALREADY EXPIRED — the same fail-closed direction warrant.ts
        // takes, so a malformed date can never read as an unlimited warrant.
        remaining_s: Number.isNaN(expiresMs) ? 0 : Math.max(0, Math.floor((expiresMs - nowMs) / 1000)),
        expired: Number.isNaN(expiresMs) || expiresMs <= nowMs,
      }
    : undefined;

  return {
    json: {
      verb: "plan",
      subcommand: "status",
      ok: true,
      plan_hash: planHash,
      plan_state: view.state,
      steps: view.steps,
      advisories: view.advisories,
      open_advisories: view.open_advisories,
      blockers: view.blockers,
      warrant,
      ...(row?.allow_unreviewed ? { not_adversarially_reviewed: true } : {}),
    },
    code: 0,
  };
}

function advisory(argv: string[], ctx: PlanVerbCtx): VerbResult {
  const pos = positional(argv);
  if ("error" in pos) return usageError(pos.error);
  if (pos.value === undefined) return usageError("an advisory id is required");
  const id = pos.value;

  const state = flagValue(argv, "--state");
  if (state === undefined) return usageError(`--state is required (one of ${[...ADVISORY_STATES].join(", ")})`);
  if (!ADVISORY_STATES.has(state)) return usageError(`--state must be one of ${[...ADVISORY_STATES].join(", ")}, got "${state}"`);

  const reason = flagValue(argv, "--reason");
  // Surfaced as a USAGE error, not as an append failure: the schema's if/then would reject the
  // row, but only after the user thought they had waived something.
  if (state === "waived" && (reason === undefined || reason.trim() === ""))
    return usageError("--reason is required when --state waived, so waive-spam is visible in the record rather than silent");
  if (reason !== undefined && reason.length > 200)
    return usageError(`--reason is limited to 200 characters (got ${reason.length}) — the ledger row would be rejected on append`);

  const records = ctx.records ?? safeRecords();
  const compiled = records.filter((r): r is Extract<LedgerRecord, { type: "plan_compiled" }> => r.type === "plan_compiled");
  const planHash = flagValue(argv, "--plan") ?? compiled[compiled.length - 1]?.plan_hash;
  if (planHash === undefined) return usageError("no plan has been compiled yet — nothing to close an advisory against");

  // The advisory must be one the plan actually declared. Closing an unknown id would let the
  // open-advisory count be driven to zero by inventing ids, which is the completion rule's
  // denominator and therefore worth guarding.
  const plansDir = flagValue(argv, "--plans-dir") ?? ctx.plansDir ?? defaultPlansDir(ctx.env ?? process.env);
  const shape = plansDir ? loadPlan(plansDir, planHash) : undefined;
  if (shape && !(shape.advisories ?? []).some((a) => a.id === id))
    return usageError(
      `advisory "${id}" is not declared by plan ${planHash.slice(0, 12)} (it has: ${(shape.advisories ?? []).map((a) => a.id).join(", ") || "none"})`,
    );

  const rec: TodoRecord = {
    type: "todo",
    ts: (ctx.now ?? (() => new Date().toISOString()))(),
    plan_hash: planHash,
    id,
    state: state as "fixed" | "waived" | "obsolete",
    source: "user",
    ...(reason !== undefined && reason.trim() !== "" ? { reason } : {}),
  };
  try {
    appendRecord(rec);
  } catch (e) {
    return { json: { verb: "plan", subcommand: "advisory", ok: false, error: (e as Error).message }, code: 64 };
  }
  return { json: { verb: "plan", subcommand: "advisory", ok: true, plan_hash: planHash, id, state, reason }, code: 0 };
}

function safeRecords(): readonly LedgerRecord[] {
  try {
    return readRecords();
  } catch {
    return [];
  }
}

export interface PlanVerbCtx {
  readFile?: (p: string, enc: string) => string;
  plansDir?: string;
  records?: readonly LedgerRecord[];
  runPlanner?: Parameters<typeof compilePlan>[2]["runPlanner"];
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  nowMs?: () => number;
}

export async function planVerb(argv: string[], ctx: PlanVerbCtx = {}): Promise<VerbResult> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "compile") return compile(rest, ctx);
  if (sub === "status") return status(rest, ctx);
  if (sub === "advisory") return advisory(rest, ctx);
  return usageError(`unknown subcommand ${sub ? `"${sub}"` : "(none)"}`);
}

// Assembles the gate's WarrantContext (spec-20260727-164748 §5.1) from the world:
// the ledger, the clock, and the size estimate. Kept OUT of gate.ts and warrant.ts so
// both stay pure — this is the only place in the warrant path that does I/O.
//
// OPT-IN: returns undefined unless AMICO_WARRANTS is truthy. gate.ts treats an absent
// context as "the step does not exist", so the whole feature is off by default and the
// env var is the entire flag surface. That is deliberate for the dogfood phase (plan
// CLI step 4) — the internal ring turns it on, nobody else changes behavior.
import { readRecords, type ApprovalRecord, type PlanCompiledRecord } from "./ledger.js";
import { extractKeyVars, memoryScore, tshirtSize } from "./estimate.js";
import type { WarrantContext } from "./gate.js";
import type { DeviceAccess, SizeClass } from "./warrant.js";

/** Truthy per the ops convention: "1"/"true"/"yes", case-insensitive. */
export function warrantsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.AMICO_WARRANTS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Size class for a script, or UNDEFINED when it cannot be resolved.
 *
 *  §4.4: undefined is the honest answer and the gate treats it as over-threshold.
 *  Do NOT be tempted to fall back to SMALL here — estimate.ts already degrades that
 *  way internally (unresolved `levels` leaves knot_point_state_dim at 1), which is
 *  exactly the silent widening path the gate exists to close. `memoryScore` throws
 *  when N is missing; that throw becomes undefined rather than a crash, because a
 *  spec we cannot size must be gated, not rejected as malformed. */
export function sizeClassFor(scriptText: string): SizeClass | undefined {
  if (!scriptText.trim()) return undefined; // problem_spec specs carry no script
  try {
    const vars = extractKeyVars(scriptText);
    if (!vars.levels) return undefined; // unresolved levels → unresolved size
    return tshirtSize(memoryScore(vars));
  } catch {
    return undefined;
  }
}

/** Solves already recorded against a plan, for the max_solves bound. Counts `solve`
 *  rows carrying this plan_hash — cheap because the ledger is the count-things store
 *  (spec §4.5) rather than a second counter that could drift. */
export function solvesUnderPlan(planHash: string, records: readonly { type: string; plan_hash?: string }[]): number {
  return records.filter((r) => r.type === "solve" && r.plan_hash === planHash).length;
}

export interface AssembleOptions {
  scriptText: string;
  planHash?: string;
  /** Device access this launch needs. Solves are simulator-only today, so the
   *  default is "none"; the device path passes its own value when it lands. */
  device?: DeviceAccess;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/** The context, or undefined when warrants are off (which disarms the gate step). */
export function assembleWarrantContext(opts: AssembleOptions): WarrantContext | undefined {
  if (!warrantsEnabled(opts.env ?? process.env)) return undefined;

  // A ledger that is missing or unreadable yields NO approvals, which fails closed:
  // every gated launch refuses rather than sailing through unwarranted.
  let approvals: ApprovalRecord[] = [];
  let planCompiled: PlanCompiledRecord[] = [];
  let all: { type: string; plan_hash?: string }[] = [];
  try {
    const records = readRecords();
    all = records as unknown as { type: string; plan_hash?: string }[];
    approvals = records.filter((r): r is ApprovalRecord => r.type === "approval");
    // For the §4.6 SUPERSEDED refusal: these rows carry the design_hash -> plan_hash
    // binding, which is the only way the gate can say "you recompiled" rather than
    // "you never approved anything".
    planCompiled = records.filter((r): r is PlanCompiledRecord => r.type === "plan_compiled");
  } catch {
    /* no ledger → no warrants → gated launches refuse */
  }

  return {
    approvals,
    planCompiled,
    now: opts.now ?? Date.now(),
    sizeClass: sizeClassFor(opts.scriptText),
    device: opts.device ?? "none",
    solvesSoFar: opts.planHash ? solvesUnderPlan(opts.planHash, all) : undefined,
  };
}

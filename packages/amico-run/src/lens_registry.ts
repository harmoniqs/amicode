// The lens registry (spec-20260728 §3.1, §3.5): which review lenses apply to which
// `task_type`, and at which tier.
//
// Rev 1 of the spec covered 5 of the 10 task types, so half the closed enum fell through
// to a single lens while `--critics 3` was the default — three calls spent on one lens.
// Exhaustiveness over TASK_TYPES is therefore a TEST, not a convention.
//
// DEVIATION FROM THE SPEC, recorded deliberately (advisory A-13): spec §3.5 places this
// registry in amico-plugin and defines `lens_registry_version` as that repo's git sha.
// Nothing in amico-run can read another repo's sha at runtime, so the registry lives here
// and the version is a local constant until the plugin-side home exists.
import { TASK_TYPES, type TaskType } from "./ledger.js";

/** Bumped BY HAND whenever the lens set or its applicability changes. Stamped into every
 *  `spec_review` record so a review is attributable to the rules that produced it — a spec
 *  approved under a weaker lens set is then visible as such rather than indistinguishable
 *  from one approved under the current set. */
export const LENS_REGISTRY_VERSION = "1";

/** Tier-1 lenses: mechanical, free, deterministic, computed from the spec alone. */
export const TIER1_LENSES = [
  "schema",
  "falsifiable",
  "budget",
  "baseline",
  "precedent",
  "provenance",
] as const;
export type Tier1Lens = (typeof TIER1_LENSES)[number];

/** Tier-2 lenses: judgment, frontier-tier, one critic each. Not exercised by this slice
 *  (the subprocess mechanism is G-2-gated) but declared here so the registry is complete
 *  and `--critics` clamping has something real to clamp against. */
export const TIER2_LENSES = [
  "hidden-failure",
  "decomposition",
  "physics-adequacy",
  "cost-realism",
  "interface-boundary",
  "test-adequacy",
  "sequencing",
  "dependency-order",
  "evidence-adequacy",
] as const;
export type Tier2Lens = (typeof TIER2_LENSES)[number];

/** Task types whose work can reach a gated capability, and which therefore carry a
 *  `budget`. The `budget`, `baseline` and `precedent` lenses are scoped to these. */
export const LAUNCH_SHAPED: readonly TaskType[] = ["experiment-sim", "experiment-hw", "author-script"];

export interface LensSet {
  tier1: readonly Tier1Lens[];
  tier2: readonly Tier2Lens[];
}

// Universal tier-1 lenses. `schema` and `falsifiable` apply to every spec: one checks the
// contract, the other checks that the acceptance criteria are criteria at all.
const T1_UNIVERSAL: readonly Tier1Lens[] = ["schema", "falsifiable", "provenance"];
const T1_LAUNCH: readonly Tier1Lens[] = [...T1_UNIVERSAL, "budget", "baseline", "precedent"];

// `hidden-failure` and `decomposition` are in EVERY non-empty tier-2 set. Rev 1 withheld
// `decomposition` from `implement-slice`, so the specs most exposed to bad carving were the
// one category never reviewed for it — and the spec that shipped with three contradictions
// was itself an `implement-slice`.
const T2_ALWAYS: readonly Tier2Lens[] = ["hidden-failure", "decomposition"];

/** An entry for EVERY value of TASK_TYPES — enforced by test, not by convention. */
export const LENS_REGISTRY: Record<TaskType, LensSet> = {
  "experiment-sim": { tier1: T1_LAUNCH, tier2: [...T2_ALWAYS, "physics-adequacy", "cost-realism"] },
  "experiment-hw": { tier1: T1_LAUNCH, tier2: [...T2_ALWAYS, "physics-adequacy", "cost-realism"] },
  "author-script": { tier1: T1_LAUNCH, tier2: [...T2_ALWAYS, "physics-adequacy", "cost-realism"] },
  "implement-slice": { tier1: T1_UNIVERSAL, tier2: [...T2_ALWAYS, "interface-boundary", "test-adequacy"] },
  plan: { tier1: T1_UNIVERSAL, tier2: [...T2_ALWAYS, "sequencing", "dependency-order"] },
  review: { tier1: T1_UNIVERSAL, tier2: [...T2_ALWAYS, "evidence-adequacy"] },
  insight: { tier1: T1_UNIVERSAL, tier2: [...T2_ALWAYS, "evidence-adequacy"] },
  // Conversational / bookkeeping work gets tier 1 only. Spending a frontier critic on
  // "record this fact" is the bureaucracy trap the spec's §8 names.
  triage: { tier1: T1_UNIVERSAL, tier2: [] },
  bookkeeping: { tier1: T1_UNIVERSAL, tier2: [] },
  converse: { tier1: T1_UNIVERSAL, tier2: [] },
};

export function tier1LensesFor(taskType: TaskType): readonly Tier1Lens[] {
  return LENS_REGISTRY[taskType].tier1;
}

export function tier2LensesFor(taskType: TaskType): readonly Tier2Lens[] {
  return LENS_REGISTRY[taskType].tier2;
}

/** `--critics N` clamps to the number of lenses that actually exist for this task type.
 *  Without this, `--critics 3` on a `review` spec would spend three calls on one lens. */
export function criticCountFor(taskType: TaskType, requested: number): number {
  return Math.max(0, Math.min(requested, tier2LensesFor(taskType).length));
}

/** Is this a task type whose spec must carry a budget? */
export function isLaunchShaped(taskType: TaskType): boolean {
  return LAUNCH_SHAPED.includes(taskType);
}

/** Guard for reading an untrusted `task_type` off frontmatter. */
export function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}

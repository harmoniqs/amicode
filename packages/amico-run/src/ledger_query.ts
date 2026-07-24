// Ledger query aggregation (Plan 3 / L1 Task 4) — L-A's honest priors. Turns the
// run ledger into queryable registry defaults: medians + IQR per recommendable
// param, keyed on `structure_hash × (N-bucket, T-bucket)`, with a `source="user"`
// filter, a solve⋈verdict join for the verified count, honest provenance, and a
// mechanically-capped confidence.
//
// DOCTRINE (spec-20260719-210954 L-A): counting/medians/retrieval with VISIBLE
// provenance — no ML, no silent auto-apply. "Verified" means `verdict = agree` via
// the problem_hash join; converged-but-unverified runs contribute only with an
// explicit label and a confidence cap (learning priors from unverified converged
// runs is exactly the optimizer-vs-rollout mismatch the referee exists to prevent).
import { readRecords, type LedgerRecord, type SolveRecord } from "./ledger.js";

// ── buckets (documented edges) ───────────────────────────────────────────────
// N (trajectory length / knot count) and T (duration) live OUTSIDE structure_hash
// but scale the very params being recommended, so they MUST be part of the key
// (spec L-A#2). Coarse buckets keep neighbouring problem sizes comparable.
//
// N edges: 25, 50, 100, 200, 400 → buckets [<25, 25–50, 50–100, 100–200, 200–400, 400+].
// T edges: 10, 30, 100, 300, 1000 → buckets [<10, 10–30, 30–100, 100–300, 300–1000, 1000+].
// bucket index = how many edges the value is ≥ (a value ON an edge lands in the
// higher bucket).
const N_EDGES = [25, 50, 100, 200, 400] as const;
const T_EDGES = [10, 30, 100, 300, 1000] as const;

export function bucketN(n: number): number {
  return N_EDGES.filter((e) => n >= e).length;
}
export function bucketT(t: number): number {
  return T_EDGES.filter((e) => t >= e).length;
}

// ── tuning constants ─────────────────────────────────────────────────────────
// These four are the ONE rubric in the system (fleet §6.3 Rev 5: "One rubric in the
// system, not two") — exported so ledger_dispatch.ts's tier-dispatch aggregator
// reuses these exact bands instead of declaring a parallel set.
/** Minimum runs at a key before it is trusted; below it, relax to the fallback key. */
export const K_MIN = 2;
/** Runs at/above which (with tight IQR + verified majority) a prior can reach `high`. */
export const N_HIGH = 5;
/** Relative IQR ((q3−q1)/|median|) at/below which a numeric param is "tight". */
export const IQR_TIGHT = 0.5;
/** Relative IQR above which spread is "wide" → demote to `low`. */
export const IQR_WIDE = 1.5;

// The recommendable knobs. Numeric ones get median+IQR; integrator is categorical
// (mode). N is always on `summary`; the rest are carried on `summary` too (the
// summary schema is additionalProperties:true, and Task 5's settle() populates them
// from the solvespec). Params absent on a solve simply don't contribute.
const NUMERIC_PARAMS = ["Q", "R", "du_bound", "N", "max_iter"] as const;
type NumericParam = (typeof NUMERIC_PARAMS)[number];

export interface QueryKey {
  structure_hash: string;
  n_bucket: number;
  t_bucket: number;
  // Task identity. `structure_hash` deliberately does NOT cover the goal (a CZ and
  // an X gate on the same system/template/solver produce the SAME structure_hash —
  // correct for warm-pool routing, since the gate does not change the Julia type).
  // But recommended Q/R/du_bound/max_iter for a CZ are NOT the recommendations for
  // a far easier X gate, so priors must discriminate here or they average two
  // different difficulty populations together. Applied to BOTH the primary and
  // fallback keys; when omitted, no goal discrimination happens (the pre-fix
  // behaviour) and `provenance` says so rather than implying a tighter key.
  goal?: string;
  // fallback key parts (used only when the primary key has < K_MIN runs)
  platform?: string;
  template?: string;
  trajectory?: string;
  levels?: number;
}

export interface ParamStat {
  value: number; // median
  iqr: [number, number]; // [q1, q3]
  n: number; // solves that carried this param
}
export interface CategoricalStat {
  value: string; // mode
  n: number; // count at the mode
  total: number; // solves that carried this param
}

export interface QueryResult {
  key: "primary" | "fallback" | "none";
  structure_hash: string;
  n_bucket: number;
  t_bucket: number;
  total: number; // matched user solves
  verified: number; // matched solves whose problem_hash has an `agree` verdict
  params: Partial<Record<NumericParam, ParamStat>> & { integrator?: CategoricalStat };
  provenance: string; // "n=<total> runs, <verified> verified (<key> key)"
  confidence: "high" | "medium" | "low";
}

// ── quantiles (linear interpolation, R type-7 / numpy default) ───────────────
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Median + [q1, q3] over a value list. Exported for ledger_dispatch.ts (one
 *  quantile implementation, same bands — see the tuning constants above). */
export function numericStat(values: number[]): ParamStat {
  const sorted = [...values].sort((a, b) => a - b);
  return { value: quantile(sorted, 0.5), iqr: [quantile(sorted, 0.25), quantile(sorted, 0.75)], n: sorted.length };
}

function pull(s: SolveRecord, p: string): number | undefined {
  const v = (s.summary as Record<string, unknown>)[p];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function integratorMode(solves: SolveRecord[]): CategoricalStat | undefined {
  const counts = new Map<string, number>();
  for (const s of solves) {
    const v = (s.summary as Record<string, unknown>).integrator;
    if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  if (counts.size === 0) return undefined;
  let best = "";
  let bestN = 0;
  let total = 0;
  for (const [k, n] of counts) {
    total += n;
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return { value: best, n: bestN, total };
}

// ── matching ─────────────────────────────────────────────────────────────────
const isSolve = (r: LedgerRecord): r is SolveRecord => r.type === "solve";

function bucketMatch(s: SolveRecord, key: QueryKey): boolean {
  return bucketN(s.summary.N) === key.n_bucket && bucketT(s.summary.T) === key.t_bucket;
}
/** Task-identity guard. No-op when the caller supplied no goal, so this cannot
 *  silently empty a bucket for callers that predate the goal key. */
function goalMatch(s: SolveRecord, key: QueryKey): boolean {
  return key.goal === undefined || s.summary.goal === key.goal;
}
function primaryMatch(s: SolveRecord, key: QueryKey): boolean {
  return s.structure_hash === key.structure_hash && bucketMatch(s, key) && goalMatch(s, key);
}
function fallbackMatch(s: SolveRecord, key: QueryKey): boolean {
  if (!key.platform || !key.template || !key.trajectory) return false;
  const sm = s.summary;
  if (sm.platform !== key.platform || sm.template !== key.template || sm.trajectory !== key.trajectory) return false;
  if (key.levels !== undefined && sm.levels !== key.levels) return false;
  return bucketMatch(s, key) && goalMatch(s, key);
}

// ── confidence rubric (mechanical) ───────────────────────────────────────────
// tight IQR + high n + verified majority → high; sparse or wide → low; else medium.
// INTERIM CAP (spec L-A#3 + interim guard, do NOT remove until L-H per-structure
// trust lands in L3): if ANY contributing run is unverified, cap at `medium`.
// Veloce auto-accepts only `high`, so this makes ledger-sourced auto-apply
// unreachable until the trust gate exists (success criterion 5).
function rankConfidence(total: number, verified: number, relIQRs: number[]): "high" | "medium" | "low" {
  const wide = relIQRs.some((r) => r > IQR_WIDE);
  const tight = relIQRs.length > 0 && relIQRs.every((r) => r <= IQR_TIGHT);
  const verifiedMajority = verified * 2 > total;

  let c: "high" | "medium" | "low";
  if (total < K_MIN || wide) c = "low";
  else if (total >= N_HIGH && tight && verifiedMajority) c = "high";
  else c = "medium";

  // interim cap: never claim `high` when any run is unverified.
  if (c === "high" && verified < total) c = "medium";
  return c;
}

// ── aggregation ──────────────────────────────────────────────────────────────
/** Pure aggregation over an in-memory record array (no ledger I/O) — the testable
 *  core. `queryDefaults` is the thin ledger-reading wrapper. */
export function aggregate(records: LedgerRecord[], key: QueryKey): QueryResult {
  const solves = records.filter(isSolve).filter((s) => s.source === "user"); // exclude replay AND simulated

  const primary = solves.filter((s) => primaryMatch(s, key));
  let matched = primary;
  let usedKey: QueryResult["key"] = "primary";
  if (primary.length < K_MIN) {
    const fb = solves.filter((s) => fallbackMatch(s, key));
    if (fb.length > primary.length) {
      matched = fb;
      usedKey = "fallback";
    }
  }
  if (matched.length === 0) usedKey = "none";

  // verified := solves whose problem_hash has an `agree` verdict.
  const agreed = new Set(
    records.filter((r) => r.type === "verdict" && r.verdict === "agree").map((r) => (r as { problem_hash: string }).problem_hash),
  );
  const verified = matched.filter((s) => agreed.has(s.problem_hash)).length;

  const params: QueryResult["params"] = {};
  const relIQRs: number[] = [];
  for (const p of NUMERIC_PARAMS) {
    const values = matched.map((s) => pull(s, p)).filter((v): v is number => v !== undefined);
    if (values.length === 0) continue;
    const stat = numericStat(values);
    params[p] = stat;
    if (values.length >= 2 && stat.value !== 0) {
      relIQRs.push((stat.iqr[1] - stat.iqr[0]) / Math.abs(stat.value));
    }
  }
  const integrator = integratorMode(matched);
  if (integrator) params.integrator = integrator;

  const confidence = matched.length === 0 ? "low" : rankConfidence(matched.length, verified, relIQRs);

  return {
    key: usedKey,
    structure_hash: key.structure_hash,
    n_bucket: key.n_bucket,
    t_bucket: key.t_bucket,
    total: matched.length,
    verified,
    params,
    // Provenance must state whether the goal was keyed on: an unkeyed query can mix
    // difficulty populations (CZ with X), and a reader deserves to see which it got.
    provenance:
      `n=${matched.length} runs, ${verified} verified (${usedKey} key` +
      (key.goal === undefined ? ", goal not keyed" : `, goal=${key.goal}`) +
      `)`,
    confidence,
  };
}

/** Query the on-disk ledger for recommendable defaults at a key. */
export function queryDefaults(key: QueryKey): QueryResult {
  return aggregate(readRecords(), key);
}

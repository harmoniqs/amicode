// Tier-dispatch aggregation (fleet spec §6.3 Rev 5) — which model tier should author
// work of a given kind, measured rather than hand-authored.
//
// DOCTRINE: this RIDES THE RUN LEDGER; it does not build a second store. The
// typed-specs learning layer already shipped the append-only record store this needs
// (`amico ledger` + ledger.ts + ledger_query.ts), so the rows here are the 7th ledger
// kind (`dispatch`) and the path always comes from `$AMICO_LEDGER`. There is no
// `amico telemetry` verb: that name is taken (telemetry.ts is the solve-run log
// classifier) and a parallel store is precisely the divergence this design deletes.
//
// The policy this module serves (§6, authority order):
//   1. verifiability rule  — a below-frontier stamp needs a runnable gate (enforced
//      on the PROFILE, see profile_verb.ts; not a property of these rows)
//   2. escalation ladder   — the permanent fallback: attempt at the stamped tier, on
//      gate failure escalate one rung, repeat to the top reachable rung
//   3. learned stamping    — THIS module: m*(s) = argmin_m c_m / p_m(s)
//
// SUFFICIENCY, Rev 5: the activation test is NOT a bare n ≥ 20. It adopts the
// ledger's shipped rubric shape — relax-to-coarser-key below `K_MIN`, plus a
// spread-aware mechanical confidence (`N_HIGH` + relative-IQR tight/wide bands) over
// the per-cell cost-per-success estimates. One rubric in the system, not two: those
// four constants are IMPORTED from ledger_query.ts, never re-declared here. Only the
// sufficiency test is unified; m*(s) selection itself is unchanged.
//
// KEY GRANULARITY, Rev 5 (inherit the lesson, don't re-learn it): `structure_hash`
// was found not to discriminate `goal.gate` — correct for its cloud-routing job,
// wrong as a learning key. `task_type` is coarser still, so a plain `experiment-sim`
// cell would pool a trivial T1 fit with a 50-iteration QILC campaign. So the primary
// key is the FINEST work identity (`work_id`) and `task_type` is the explicit
// FALLBACK tier. Never one hash for both routing and learning.
//
// ⚠️ THE SIM/HW BOUNDARY IS THE LOAD-BEARING RULE (Rev 5). Simulated rows ARE
// admissible here (opt-in `include_simulated`) — unlike ledger_query.ts, whose
// `source === "user"` filter stays untouched — because tier dispatch asks a different
// question: *can model m author correct work of type s*, which a fit-recovery gate
// against known ground truth does test. What it cannot test is robustness to real
// noise, drift, and unexpected resonances, so a simulated pass is NECESSARY BUT NOT
// SUFFICIENT evidence of hardware competence. Therefore sim and hw cells NEVER pool,
// and — the leak path — THE FALLBACK MUST NOT CROSS THE BOUNDARY EITHER: a sparse
// `experiment-hw` cell relaxes within hardware rows only, or fails over to the
// escalation ladder. It never relaxes into a bucket that pools `experiment-sim` rows,
// which would let simulated pass-rates route real board time. This is the same class
// of defect as `structure_hash`'s goal-blindness: the *fallback* key, not the primary,
// is where difficulty populations get mixed. Enforced by `laneOf()` on BOTH matchers
// plus an admissibility pre-filter, and asserted by
// test/ledger_dispatch.test.ts's "the sim/hw boundary" block.
//
// NO TRANSFER CLAIM: whether simulated pass-rate predicts hardware pass-rate is an
// open empirical question and nothing here assumes it. Pooling the two cells would
// require measured hardware data justifying it.
import { readRecords, type DispatchRecord, type LedgerRecord, type TaskType } from "./ledger.js";
import { IQR_TIGHT, IQR_WIDE, K_MIN, N_HIGH, numericStat } from "./ledger_query.js";

// ── the sim/hw/authoring partition ───────────────────────────────────────────────
/** The three difficulty populations that must never pool. The sim/hw axis is carried
 *  in the taxonomy itself (`experiment-sim` vs `experiment-hw`, fleet G-F), which is
 *  why the `dispatch` schema stanza enumerates task types: a bare `experiment` value
 *  would be a lane-less row, and a lane-less row is exactly the leak. */
export type Lane = "sim" | "hw" | "authoring";

/** The lane a row (or a query) belongs to. `authoring` covers every non-experiment
 *  task type — plan/author-script/implement-slice/review/insight/… — whose rows come
 *  from the ladder's own model dispatches. */
export function laneOf(task_type: TaskType | string): Lane {
  if (task_type === "experiment-sim") return "sim";
  if (task_type === "experiment-hw") return "hw";
  return "authoring";
}

// ── the escalation ladder (§6.2) ─────────────────────────────────────────────────
/** The below-frontier rungs, cheap → expensive. */
export const LADDER = ["anthropic/claude-haiku-4-5", "anthropic/claude-sonnet-5", "anthropic/claude-opus-4-8"] as const;
/** The frontier tier. G-E asked which model backs the frontier rung: fable-class has
 *  landed, so the frontier set is the 5-series top tier and `opus-4-8` is now a
 *  BELOW-frontier rung (kept in step with amico-plugin's profiles/SCHEMA.md §5). */
export const FRONTIER_MODELS = [
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-mythos-5",
] as const;
/** The model id the ladder's top rung resolves to. */
export const FRONTIER_RUNG = "anthropic/claude-opus-5";

/** The rungs at or above the bottom, in ladder order. */
export function ladderRungs(frontier: string = FRONTIER_RUNG): string[] {
  return [...LADDER, frontier];
}

/** The rungs an attempt escalates through after a gate failure at `stamp`, in order.
 *
 *  A rung is SKIPPED when its model id equals the current one — so before fable-class
 *  landed, `opus-4-8 → frontier` collapsed to a single rung (pass
 *  `frontier = "anthropic/claude-opus-4-8"` to see that collapse). The last element is
 *  the TOP REACHABLE RUNG: the highest DISTINCT model id at or above the stamp. An
 *  empty ladder means the stamp already IS the top reachable rung, so a gate failure
 *  there is a gate-exhaustion event (registry `blocked`, needs a human) rather than a
 *  replan — replanning rewrites step bodies, which does not help work that fails
 *  verification at frontier.
 *
 *  A model id outside the known ladder is treated as below-frontier (conservative:
 *  it escalates straight to frontier). */
export function escalationLadder(stamp: string, frontier: string = FRONTIER_RUNG): string[] {
  const rungs = ladderRungs(frontier);
  const at = rungs.indexOf(stamp);
  if (at < 0) return stamp === frontier ? [] : [frontier];
  const out: string[] = [];
  let current = stamp;
  for (const rung of rungs.slice(at + 1)) {
    if (rung === current) continue; // rung skipped: its model id equals the current one
    out.push(rung);
    current = rung;
  }
  return out;
}

// ── per-attempt cost c_m ─────────────────────────────────────────────────────────
/** The last-resort per-attempt cost: the model's 1-based LADDER POSITION.
 *
 *  This asserts only what the ladder itself asserts — rungs are ordered cheap →
 *  expensive — and deliberately invents no price ratio. A cell priced this way is
 *  marked `cost_observed: false` and can never reach `high` confidence, because half
 *  of the c_m/p_m ratio is then unmeasured (the same interim-cap discipline
 *  ledger_query applies to unverified runs). An unknown model id prices as
 *  frontier-class, which is the conservative direction: it makes a cheap-looking
 *  unknown harder, not easier, to select. */
export function ladderCost(model: string): number {
  const rungs = ladderRungs();
  const at = rungs.indexOf(model);
  return at >= 0 ? at + 1 : rungs.length;
}

/** Observed per-attempt cost for a (model, variant), from the ledger's own token
 *  counts. Median tokens is c_m; the relative IQR of those samples is the spread the
 *  confidence bands read.
 *
 *  Three steps, in order: (1) rows with this model AND variant; (2) rows with this
 *  model, ANY variant; (3) `ladderCost`. Step 2 is fleet §6.3 Rev 4.1's rule that a
 *  LAB cell's c_m comes from the ladder's own AUTHORING dispatches — experiment rows
 *  carry `tokens = 0` and are excluded by the `tokens > 0` filter, so an
 *  `experiment-*` cell is priced by the same model's authoring work automatically.
 *
 *  ⚠️ Cost samples pool ACROSS lanes and work_ids ON PURPOSE. Cost is a property of
 *  the model, not of the work, so pooling it is sound — and it is NOT a pass-rate
 *  leak: `p_m(s)` never sees a row from another lane (see `cellFor`). Read this
 *  function and `cellFor` together before touching either. */
function costFor(rows: DispatchRecord[], model: string, variant: string): { cost: number; observed: boolean; rel_iqr: number | null } {
  const priced = rows.filter((r) => r.tokens > 0);
  let samples = priced.filter((r) => r.model === model && r.variant === variant).map((r) => r.tokens);
  if (samples.length === 0) samples = priced.filter((r) => r.model === model).map((r) => r.tokens);
  if (samples.length === 0) return { cost: ladderCost(model), observed: false, rel_iqr: null };
  const stat = numericStat(samples);
  const rel_iqr = samples.length >= 2 && stat.value !== 0 ? (stat.iqr[1] - stat.iqr[0]) / Math.abs(stat.value) : null;
  return { cost: stat.value, observed: true, rel_iqr };
}

// ── the rubric (mirrors ledger_query.rankConfidence, same four constants) ─────────
/** Mechanical confidence in a cell's cost-per-success estimate: tight spread + high n
 *  → `high`; sparse or wide → `low`; else `medium`.
 *
 *  INTERIM CAP (mirroring ledger_query's "never claim high when any run is
 *  unverified"): a cell whose c_m is a ladder-position DEFAULT can never claim `high`,
 *  because the cost half of c_m/p_m was never measured. Every lab cell is in that
 *  position today, which is the honest reading of "a simulated pass is necessary but
 *  not sufficient". */
export function rankDispatchConfidence(n: number, relIQR: number | null, costObserved: boolean): "high" | "medium" | "low" {
  const wide = relIQR !== null && relIQR > IQR_WIDE;
  const tight = relIQR !== null && relIQR <= IQR_TIGHT;

  let c: "high" | "medium" | "low";
  if (n < K_MIN || wide) c = "low";
  else if (n >= N_HIGH && tight) c = "high";
  else c = "medium";

  if (c === "high" && !costObserved) c = "medium";
  return c;
}

// ── shapes ───────────────────────────────────────────────────────────────────────
export interface DispatchKey {
  /** The finest work identity: `structure_hash` for solve-shaped work, the experiment
   *  kind for task work. The PRIMARY key. */
  work_id: string;
  /** The task type being routed. Coarser than `work_id`, so it is the FALLBACK tier —
   *  and it carries the sim/hw axis, so it also fixes the lane. */
  task_type: TaskType | string;
  /** Restrict cells to one effort variant (the ladder carries the variant over
   *  unchanged across rungs, so a caller routing a stamped step passes its variant). */
  variant?: string;
  /** The currently stamped model, used to compute the escalation ladder that a
   *  ladder-fallback answer hands back. */
  stamp?: string;
}

export interface DispatchOptions {
  /** Opt-in: count simulated evidence. It admits rows into the SIM LANE ONLY and can
   *  never widen a `hw` or `authoring` cell (fleet §6.3 Rev 5). ledger_query.ts's
   *  `source === "user"` filter is deliberately untouched. */
  include_simulated?: boolean;
  /** The frontier model id backing the ladder's top rung (test seam for the
   *  same-model-id rung skip). */
  frontier?: string;
}

export interface DispatchCell {
  model: string;
  variant: string;
  key: "primary" | "fallback";
  lane: Lane;
  /** First-attempt gated samples backing `p` (escalated attempts see a biased task
   *  distribution and are excluded — §6.2). */
  n: number;
  passes: number;
  /** p_m(s), the first-attempt pass rate. */
  p: number;
  /** c_m, per-attempt cost. */
  cost: number;
  cost_observed: boolean;
  cost_rel_iqr: number | null;
  /** c_m / p_m(s) — the quantity m*(s) minimizes. Infinity when p = 0. */
  cost_per_success: number;
  confidence: "high" | "medium" | "low";
  /** The Rev 5 sufficiency test (which replaced the bare n ≥ 20). */
  eligible: boolean;
  provenance: string;
}

export interface DispatchSelection {
  model: string;
  variant: string;
  key: "primary" | "fallback";
  p: number;
  cost: number;
  cost_per_success: number;
  n: number;
  confidence: "high" | "medium" | "low";
}

export interface DispatchResult {
  work_id: string;
  task_type: string;
  lane: Lane;
  key: "primary" | "fallback" | "none";
  include_simulated: boolean;
  cells: DispatchCell[];
  /** m*(s), or null when no cell is sufficient — then the escalation ladder governs. */
  selection: DispatchSelection | null;
  ladder_fallback: boolean;
  /** The rungs to escalate through from `stamp` (empty when the stamp is already the
   *  top reachable rung → gate exhaustion). */
  ladder: string[];
  stamp: string | null;
  /** Visible provenance for every row the aggregator refused (doctrine: counting with
   *  VISIBLE provenance, never a silent filter). */
  excluded: { replay: number; simulated: number; cross_lane: number; escalated: number };
  provenance: string;
  confidence: "high" | "medium" | "low";
}

const isDispatch = (r: LedgerRecord): r is DispatchRecord => r.type === "dispatch";

// ── aggregation ──────────────────────────────────────────────────────────────────
/** Pure aggregation over an in-memory record array (no ledger I/O) — the testable
 *  core. `dispatchTable` is the thin ledger-reading wrapper. */
export function aggregateDispatch(records: LedgerRecord[], key: DispatchKey, opts: DispatchOptions = {}): DispatchResult {
  const qlane = laneOf(key.task_type);
  const includeSim = opts.include_simulated === true;
  const excluded = { replay: 0, simulated: 0, cross_lane: 0, escalated: 0 };

  // ── admissibility ──────────────────────────────────────────────────────────────
  // A replay row is a re-execution of already-recorded work, not fresh evidence that
  // a model authored something correct, so it is excluded unconditionally (the same
  // judgement ledger_query makes, for the same reason).
  const admissible: DispatchRecord[] = [];
  for (const r of records.filter(isDispatch)) {
    if (r.source === "replay") {
      excluded.replay++;
      continue;
    }
    const rlane = laneOf(r.task_type);
    if (r.source === "simulated") {
      // Simulated evidence is opt-in AND lane-restricted. A `source: "simulated"` row
      // outside the sim lane is mislabelled and can never license hardware routing —
      // dropped here as a second line of defence behind the lane match below.
      if (!includeSim) {
        excluded.simulated++;
        continue;
      }
      if (rlane !== "sim") {
        excluded.cross_lane++;
        continue;
      }
    }
    // The sim lane as a whole is simulated evidence, whatever a row's `source` says
    // (an `experiment-sim` row IS a simulator run), so the opt-in gates the lane too.
    if (rlane === "sim" && !includeSim) {
      excluded.simulated++;
      continue;
    }
    admissible.push(r);
  }

  // ── lane-scoped matchers — THE boundary ────────────────────────────────────────
  // Both keys are lane-scoped. The primary key is `work_id` (finest identity); the
  // fallback key is `task_type`, which is lane-pure BY CONSTRUCTION (`experiment-sim`
  // and `experiment-hw` are distinct taxonomy values) and lane-checked anyway, so a
  // sparse `experiment-hw` cell relaxes within HARDWARE rows only. Lane-scoping the
  // PRIMARY matters just as much: an experiment `work_id` (the experiment kind, e.g.
  // "t1-fit") is the SAME string on the simulator and on the board, so an unscoped
  // primary key would pool the two difficulty populations before the fallback ever
  // ran.
  const sameLane = (r: DispatchRecord): boolean => laneOf(r.task_type) === qlane;
  const primaryMatch = (r: DispatchRecord): boolean => sameLane(r) && r.work_id === key.work_id;
  const fallbackMatch = (r: DispatchRecord): boolean => sameLane(r) && r.task_type === key.task_type;

  const inScope = admissible.filter((r) => primaryMatch(r) || fallbackMatch(r));
  const firstAttempt = inScope.filter((r) => {
    if (r.attempt_index === 1) return true;
    excluded.escalated++; // p_m(s) conditions on first-attempt samples (§6.2)
    return false;
  });

  // ── cells: one per (model, variant) ───────────────────────────────────────────
  const pairs = new Map<string, { model: string; variant: string }>();
  for (const r of firstAttempt) {
    if (key.variant !== undefined && r.variant !== key.variant) continue;
    pairs.set(`${r.model}\x00${r.variant}`, { model: r.model, variant: r.variant });
  }

  const cells: DispatchCell[] = [];
  for (const { model, variant } of pairs.values()) {
    const cell = cellFor(firstAttempt, admissible, key, model, variant, qlane);
    if (cell) cells.push(cell);
  }
  cells.sort((a, b) => a.cost_per_success - b.cost_per_success || b.n - a.n || a.model.localeCompare(b.model));

  // ── m*(s) = argmin_m c_m / p_m(s) over SUFFICIENT cells only ───────────────────
  // A cell with p = 0 has cost_per_success = Infinity and is never selected: a model
  // that has never passed the gate is infinitely expensive per verified success.
  const eligible = cells.filter((c) => c.eligible);
  const best = eligible.reduce<DispatchCell | null>((acc, c) => {
    if (!acc) return c;
    if (c.cost_per_success < acc.cost_per_success) return c;
    if (c.cost_per_success > acc.cost_per_success) return acc;
    // ties → the cheaper per-attempt rung first, then a stable model-id order
    if (c.cost !== acc.cost) return c.cost < acc.cost ? c : acc;
    return c.model.localeCompare(acc.model) < 0 ? c : acc;
  }, null);

  const selection: DispatchSelection | null = best
    ? {
        model: best.model,
        variant: best.variant,
        key: best.key,
        p: best.p,
        cost: best.cost,
        cost_per_success: best.cost_per_success,
        n: best.n,
        confidence: best.confidence,
      }
    : null;

  const stamp = key.stamp ?? null;
  const resultKey: DispatchResult["key"] =
    cells.length === 0 ? "none" : (selection?.key ?? (cells.some((c) => c.key === "primary") ? "primary" : "fallback"));

  return {
    work_id: key.work_id,
    task_type: String(key.task_type),
    lane: qlane,
    key: resultKey,
    include_simulated: includeSim,
    cells,
    selection,
    ladder_fallback: selection === null,
    ladder: stamp ? escalationLadder(stamp, opts.frontier) : [],
    stamp,
    excluded,
    provenance: selection
      ? `m*=${selection.model}/${selection.variant} at c/p=${fmt(selection.cost_per_success)} from n=${selection.n} first-attempt rows (${selection.key} key, lane=${qlane}${includeSim ? ", simulated rows counted" : ""})`
      : `no sufficient cell (${cells.length} seen, lane=${qlane}) — the escalation ladder governs${stamp ? ` from ${stamp}` : ""}`,
    confidence: selection?.confidence ?? "low",
  };
}

/** One (model, variant) cell: primary key, relaxed to the fallback key below `K_MIN`
 *  exactly as ledger_query does — and only ever WITHIN the query's lane. */
function cellFor(
  firstAttempt: DispatchRecord[],
  admissible: DispatchRecord[],
  key: DispatchKey,
  model: string,
  variant: string,
  qlane: Lane,
): DispatchCell | null {
  const mine = firstAttempt.filter((r) => r.model === model && r.variant === variant);
  const primary = mine.filter((r) => r.work_id === key.work_id);
  let matched = primary;
  let usedKey: "primary" | "fallback" = "primary";
  if (primary.length < K_MIN) {
    const fb = mine.filter((r) => r.task_type === key.task_type);
    if (fb.length > primary.length) {
      matched = fb;
      usedKey = "fallback";
    }
  }
  if (matched.length === 0) return null;

  const n = matched.length;
  const passes = matched.filter((r) => r.pass).length;
  const p = passes / n;
  const { cost, observed, rel_iqr } = costFor(admissible, model, variant);
  const cost_per_success = p > 0 ? cost / p : Number.POSITIVE_INFINITY;
  const confidence = rankDispatchConfidence(n, rel_iqr, observed);

  return {
    model,
    variant,
    key: usedKey,
    lane: qlane,
    n,
    passes,
    p,
    cost,
    cost_observed: observed,
    cost_rel_iqr: rel_iqr,
    cost_per_success,
    confidence,
    // Sufficiency (Rev 5): the shipped rubric replaces the bare n ≥ 20 count. A cell
    // is sufficient when it clears K_MIN, is not spread-demoted to `low`, and has at
    // least one observed pass to divide by.
    eligible: n >= K_MIN && confidence !== "low" && p > 0,
    provenance: `n=${n} first-attempt rows, ${passes} passed, p=${fmt(p)}, c=${fmt(cost)}${observed ? "" : " (ladder-position default)"} (${usedKey} key, lane=${qlane})`,
  };
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "inf";
  return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** Query the on-disk ledger for the tier-dispatch table at a work identity. */
export function dispatchTable(key: DispatchKey, opts: DispatchOptions = {}): DispatchResult {
  return aggregateDispatch(readRecords(), key, opts);
}

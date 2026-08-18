// The run ledger (Plan 3 / L1 Task 1) — the append-only single-writer JSONL
// substrate that grounds charter/16's Tier-2 selection signal (keyed on
// `structure_hash`) and reconnects charter/18's product↔engine flywheel.
//
// DOCTRINE: this is OPS-DATA, not vault knowledge. Curated insights ride
// vault→dream→Armonia; pulses stay in the catalog; the ledger just counts. No ML —
// medians/IQR/retrieval with visible provenance only.
//
// SINGLE-WRITER, MADE HONEST: `amico-run` owns the file. There are, however,
// MULTIPLE amico-run processes (a completing solve's LocalExecutor.settle() and
// extension-shelled `amico ledger append` can race). We rely on POSIX O_APPEND
// atomicity, which holds ONLY for writes ≤ PIPE_BUF (4096 B on Linux): concurrent
// appends whose payloads each fit under the ceiling never interleave. appendRecord
// therefore ASSERTS the serialized line ≤ PIPE_BUF and throws otherwise, so a
// pathologically large record fails loudly instead of corrupting the file. A
// realistic solve record (summary + outcome + a full Pkg versions map) is ~2 KB —
// well under the ceiling; the assertion is a safety net, not a routine limit. The
// cross-process guarantee is exercised by a real-subprocess concurrency test at the
// `ledger` verb layer (ledger_verb.test.ts), where the built CLI exists.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { validate, studioPathsOrLegacy } from "@amicode/schema";

/** POSIX minimum PIPE_BUF; O_APPEND writes at or under this size are atomic on
 *  Linux (a single `write(2)` never interleaves with another). */
export const PIPE_BUF = 4096;

// ── record contract (spec-20260719-210954 §"Record contract") ────────────────────
// ELEVEN discriminated record kinds. `solve` is the primary; `verdict` joins to it on
// `problem_hash`; the rest are lightweight events. The `source: "simulated"` value
// is the Prova isolation bridge (a deliberate extension of the spec's `user|replay`).
// The 7th kind, `dispatch`, is the tier-dispatch row (fleet §6.3 Rev 5): tier
// dispatch RIDES THIS LEDGER rather than building a second store — there is no
// `amico telemetry` verb (that name is the solve-log classifier, telemetry.ts).

export interface SolveSummary {
  platform: string;
  template: string;
  trajectory: string;
  N: number;
  T: number;
  goal: string;
  solver: string;
  strategy: string;
  levels?: number;
  [k: string]: unknown;
}

export interface SolveOutcome {
  converged: boolean;
  fidelity: number;
  iterations: number;
  wall_s?: number;
  [k: string]: unknown;
}

export interface SolveRecord {
  type: "solve";
  ts: string;
  session?: string;
  problem?: string; // slug
  structure_hash: string;
  problem_hash: string;
  kind: string;
  tier: string;
  summary: SolveSummary;
  warm_start?: string | null;
  source: "user" | "replay" | "simulated";
  outcome: SolveOutcome;
  versions?: Record<string, string>;
  /** The approved plan this solve ran under, copied from `solvespec.plan_hash` at
   *  emission. Load-bearing, not informational: `warrant_context.solvesUnderPlan()`
   *  counts `solve` rows by this field to enforce a warrant's `max_solves` bound, so
   *  without it the bound is inert (the counter is always 0). Absent for an ungated
   *  free-set launch, which carries no plan_hash by design. */
  plan_hash?: string;
}

export interface VerdictRecord {
  type: "verdict";
  ts: string;
  /** Required by the schema ONLY when `step_id` is absent — i.e. for a solve re-rollout
   *  verdict. A plan-step gate need not be solve-shaped. */
  problem_hash?: string;
  structure_hash?: string;
  /** `exhausted` = per-step gate exhaustion. The fleet registry's `blocked` is
   *  session-scoped, so it cannot carry a per-step outcome. `bypassed` is the terminal row
   *  for an `optional: true` step the walk did not need — the second half of the `skipped`
   *  producer, since the flag alone is a permission rather than an event. */
  verdict: "agree" | "disagree" | "exhausted" | "bypassed";
  fidelity_rerolled?: number;
  fidelity_reported?: number;
  /** Plan-step identity. Present on a plan-step gate verdict; this is the join that
   *  plan-step state is DERIVED from, which is what makes forging `passed` require
   *  forging a gate verdict (spec-20260728 §4.4). Both optional so every pre-existing
   *  solve verdict keeps validating. Derivation keys on (plan_hash, step_id) — never
   *  step_id alone, or a recompiled plan aliases onto the old plan's rows. */
  plan_hash?: string;
  step_id?: string;
  source?: "user" | "replay" | "simulated";
}

export interface AttemptErrorRecord {
  type: "attempt_error";
  ts: string;
  session?: string;
  errors: Array<{ path?: string; msg?: string; [k: string]: unknown }>;
}

export interface FallbackRecord {
  type: "fallback";
  ts: string;
  from_tier: string;
  reason: string;
}

export interface OverrideRecord {
  type: "override";
  ts: string;
  param: string;
  recommended: unknown;
  applied: unknown;
  structure_hash: string;
  auto_accepted: boolean;
}

export interface BurnRecord {
  type: "burn";
  ts: string;
  class: string;
  mechanism: string;
  receipt?: string;
  fixture?: string;
  prevention?: string;
}

// ── the dispatch stanza (fleet §6.3 Rev 5) ───────────────────────────────────────
/** The task-type taxonomy (fleet G-F) plus `converse` — the closed set the
 *  capability profiles stamp and tier dispatch keys on. The sim/hw axis is carried
 *  HERE (`experiment-sim` vs `experiment-hw`) so learned routing for hardware work
 *  is never fit on simulator difficulty. Extensible only by schema revision: the
 *  `ledger-record` schema's `dispatch` stanza enumerates exactly this set, so a
 *  mislabelled row (e.g. a bare `experiment`, which would pool sim with hw) is
 *  rejected on append rather than silently pooling two difficulty populations. */
export const TASK_TYPES = [
  "triage",
  "plan",
  "author-script",
  "implement-slice",
  "bookkeeping",
  "insight",
  "review",
  "experiment-sim",
  "experiment-hw",
  "converse",
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

/** One gated dispatch attempt, one row per gate (fleet §6.3). Appended by the
 *  session harness / task supervisor via `amico ledger append` — the path always
 *  comes from `$AMICO_LEDGER`, there is no `--ledger` flag.
 *
 *  `work_id` is the FINEST work identity available: `structure_hash` for
 *  solve-shaped rows, the experiment kind for task rows. `task_type` is
 *  deliberately COARSER — it is the aggregator's fallback tier, never its primary
 *  key (fleet §6.3 "inherit the lesson, don't re-learn it": one hash for routing
 *  and learning is what made `structure_hash` goal-blind).
 *
 *  Experiment-row conventions (Rev 4.1): `attempt_index = 1` always (tasks never
 *  traverse the escalation ladder, so every task row is first-attempt by
 *  definition) and `tokens = 0`, with experiment cells excluded from token-based
 *  cost estimation — a lab cell's cost comes from the same model's authoring
 *  dispatches. */
export interface DispatchRecord {
  type: "dispatch";
  ts: string;
  task_type: TaskType;
  work_id: string;
  model: string; // provider/model-id (fork format)
  variant: string; // effort axis — ALWAYS co-stamped with `model` (fleet §2)
  gate: string; // the gate this row reports (one row per gate)
  pass: boolean; // gate outcome: verdict = agree
  tokens: number; // per-attempt token cost; 0 on experiment rows (excluded from c_m)
  attempt_index: number; // ladder position; 1 = first attempt (the p_m(s) sample)
  source: "user" | "replay" | "simulated";
  /** Plan-step identity (optional) — lets step-state derivation see a step as `running`
   *  before any terminal verdict row exists. */
  plan_hash?: string;
  step_id?: string;
}

/** What a warrant authorises. An ABSENT key does not mean "unlimited" — the gate
 *  refuses a launch that needs a bound the warrant omits (spec §5.1 rule 2), so an
 *  empty `bounds` authorises nothing beyond the ungated free set. `device` uses the
 *  fleet spec §2.1 permission vocabulary. */
export interface WarrantBounds {
  max_solves?: number;
  tier?: string;
  max_size_class?: "SMALL" | "MEDIUM";
  device?: "none" | "ro" | "rw";
}

/** A capability warrant (spec-20260727-164748 §5): what lets a gated launch through
 *  the `--spec` gate. DELIBERATELY UNSIGNED — the threat model is drift, not an
 *  adversary (spec §3), and the product agent holds unrestricted bash, so a signature
 *  would defend against an attacker this layer could not stop anyway. Provenance lives
 *  in `issued_by`, and the append-only ledger makes the record tamper-evident. */
export interface ApprovalRecord {
  type: "approval";
  ts: string;
  plan_hash: string;
  bounds: WarrantBounds;
  expires_at: string;
  issued_by: string;
}

// ── the deliberation stanzas (spec-20260728 §5) ──────────────────────────────────
// The front half of deliberation: a Spec is authored, adversarially reviewed, and
// compiled into a Plan whose advisory todos are tracked here. Step todos are NOT here
// — step state is derived from `verdict` rows (§4.4), so forging `passed` requires
// forging a gate verdict.

/** One completed adversarial review. Finding BODIES live in a sidecar, not here: a
 *  3-round 3-critic review's prose exceeds PIPE_BUF and appendRecord throws above it —
 *  after the model spend — so this row carries only a digest. */
export interface SpecReviewRecord {
  type: "spec_review";
  ts: string;
  /** The spec's IMMUTABLE identity. `design_hash` alone is not an identity: two specs
   *  sharing an acceptance list would collide in the findings namespace. */
  spec_id: string;
  design_hash: string;
  rounds: number; // 1..3, schema-enforced
  /** NOT `verdict`: the ledger already has a `verdict` KIND whose `verdict` field is
   *  agree|disagree, and both live in the same runs.jsonl. */
  review_verdict: "approved" | "approved-mechanical" | "degraded" | "blocking" | "exhausted";
  lens_registry_version: string;
  lens_status: Array<{ lens: string; status: "ran" | "not-applicable" | "skipped" | "unverified"; reason?: string }>;
  /** PRESENT-and-empty is the offline sentinel; absent would be indistinguishable from
   *  a row written before the field existed. */
  critics: Array<{ model: string; variant: string }>;
  findings_count: number;
  blocking_count: number;
  findings_sha256?: string;
  findings_ref?: string;
  source: "user" | "replay" | "simulated";
}

/** A Plan compiled from a Spec. This row IS the design_hash -> plan_hash binding,
 *  without which the launch gate cannot distinguish "recompiled, re-approve" from
 *  "never approved". */
export interface PlanCompiledRecord {
  type: "plan_compiled";
  ts: string;
  plan_hash: string;
  spec_id: string;
  design_hash: string;
  compiled_by?: { model: string; variant: string };
  step_count: number;
  advisory_count?: number;
  /** A RECOMMENDATION from step_count. `amico ledger approve` reads it to default
   *  --expires-in and remains the sole writer of expires_at. */
  suggested_ttl_s?: number;
  allow_unreviewed?: boolean;
  source: "user" | "replay" | "simulated";
}

/** One ADVISORY todo transition. `open` is the absence of a row; multiple rows per id
 *  resolve last-ts-wins. No `actor` field — no trustworthy actor identity exists here. */
/** GPU/compute accounting for a remote run (#425, GPU-plane spec): pure
 *  spend record — no fidelity, never feeds priors. The campaign warrant fold
 *  sums these (unit-keyed bounds). Emitted by the remote executor at settle. */
export interface ReceiptRecord {
  type: "receipt";
  ts: string;
  task_id: string;
  executor: "remote";
  gpu_sku?: string;
  gpu_seconds?: number;
  cost_usd?: number;
  problem?: string;
  session?: string;
  status?: "completed" | "failed" | "aborted";
}

export interface TodoRecord {
  type: "todo";
  ts: string;
  plan_hash: string;
  id: string;
  state: "fixed" | "waived" | "obsolete";
  reason?: string; // required iff state === "waived"
  source: "user" | "replay" | "simulated";
}

export type LedgerRecord =
  | SolveRecord
  | ReceiptRecord
  | VerdictRecord
  | AttemptErrorRecord
  | FallbackRecord
  | OverrideRecord
  | BurnRecord
  | DispatchRecord
  | ApprovalRecord
  | SpecReviewRecord
  | PlanCompiledRecord
  | TodoRecord;

/** The ledger file path: `$AMICO_LEDGER` override, else the studio ladder
 *  (manifest ledger root → legacy ~/.amico/ledger). Absent manifest = today. */
export function ledgerPath(): string {
  if (process.env.AMICO_LEDGER) return process.env.AMICO_LEDGER;
  return join(studioPathsOrLegacy().ledger, "runs.jsonl");
}

/** GPU spend totals over receipt rows (#425) — the warrant fold's view.
 *  Pure aggregation: never throws, zeros on empty. by_sku/by_status keyed
 *  breakdowns; cost_usd omitted per-row when the runner didn't report it. */
export interface GpuTotals {
  receipts: number;
  gpu_seconds: number;
  cost_usd: number;
  by_sku: Record<string, { gpu_seconds?: number; cost_usd?: number }>;
  by_status: Record<string, number>;
}

export function gpuTotals(file = ledgerPath()): GpuTotals {
  const t: GpuTotals = { receipts: 0, gpu_seconds: 0, cost_usd: 0, by_sku: {}, by_status: {} };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return t; // absent ledger = zero spend, not an error
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: LedgerRecord;
    try {
      rec = JSON.parse(line) as LedgerRecord;
    } catch {
      continue; // a torn line never breaks accounting
    }
    if (rec.type !== "receipt") continue;
    t.receipts += 1;
    if (rec.gpu_seconds !== undefined) t.gpu_seconds += rec.gpu_seconds;
    if (rec.cost_usd !== undefined) t.cost_usd += rec.cost_usd;
    if (rec.gpu_sku !== undefined) {
      const b = t.by_sku[rec.gpu_sku] ?? {};
      if (rec.gpu_seconds !== undefined) b.gpu_seconds = (b.gpu_seconds ?? 0) + rec.gpu_seconds;
      if (rec.cost_usd !== undefined) b.cost_usd = (b.cost_usd ?? 0) + rec.cost_usd;
      t.by_sku[rec.gpu_sku] = b;
    }
    if (rec.status !== undefined) t.by_status[rec.status] = (t.by_status[rec.status] ?? 0) + 1;
  }
  t.cost_usd = Math.round(t.cost_usd * 1e4) / 1e4;
  return t;
}

/** Append one record as a single JSONL line. Validates against the `ledger-record`
 *  schema (Task 2 wires this in) before writing so no malformed line ever lands.
 *  Throws when the serialized line exceeds PIPE_BUF (would break O_APPEND
 *  atomicity) — a loud failure beats silent interleaving. */
export function appendRecord(rec: LedgerRecord): void {
  // Validate on write — a malformed record must never land as a ledger line (an
  // honest ledger has no garbage). Throw with the field-precise errors.
  const v = validate(rec, "ledger-record");
  if (!v.ok) {
    throw new Error(`invalid ledger record: ${v.errors.join("; ")}`);
  }
  const line = JSON.stringify(rec) + "\n";
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > PIPE_BUF) {
    throw new Error(
      `ledger record too large: ${bytes} B > PIPE_BUF (${PIPE_BUF} B) — would break single-writer O_APPEND atomicity`,
    );
  }
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, { flag: "a" }); // O_APPEND: atomic per-line under the ceiling above
}

/** Read every record from the ledger, in append order. Missing file → []. Skips
 *  blank lines; a malformed line throws (the ledger is validated on write, so a
 *  parse failure means external tampering, which should surface). */
export function readRecords(): LedgerRecord[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerRecord);
}

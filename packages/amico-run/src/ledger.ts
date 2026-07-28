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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { validate } from "@amicode/schema";

/** POSIX minimum PIPE_BUF; O_APPEND writes at or under this size are atomic on
 *  Linux (a single `write(2)` never interleaves with another). */
export const PIPE_BUF = 4096;

// ── record contract (spec-20260719-210954 §"Record contract") ────────────────────
// SEVEN discriminated record kinds. `solve` is the primary; `verdict` joins to it on
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
  problem_hash: string;
  structure_hash?: string;
  verdict: "agree" | "disagree";
  fidelity_rerolled?: number;
  fidelity_reported?: number;
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

export type LedgerRecord =
  | SolveRecord
  | VerdictRecord
  | AttemptErrorRecord
  | FallbackRecord
  | OverrideRecord
  | BurnRecord
  | DispatchRecord
  | ApprovalRecord;

/** The ledger file path: `$AMICO_LEDGER` override, else `~/.amico/ledger/runs.jsonl`. */
export function ledgerPath(): string {
  return process.env.AMICO_LEDGER || join(homedir(), ".amico", "ledger", "runs.jsonl");
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

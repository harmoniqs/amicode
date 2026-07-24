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
// Six discriminated record kinds. `solve` is the primary; `verdict` joins to it on
// `problem_hash`; the rest are lightweight events. The `source: "simulated"` value
// is the Prova isolation bridge (a deliberate extension of the spec's `user|replay`).

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

export type LedgerRecord =
  | SolveRecord
  | VerdictRecord
  | AttemptErrorRecord
  | FallbackRecord
  | OverrideRecord
  | BurnRecord;

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

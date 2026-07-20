// Δ10 / issue #34 (C1) — the v0 estimator at SolveSpec-assembly time: a faithful
// TypeScript port of aws-infra @ origin/staging : examples/tshirt_sizing.py (A-v1).
//
// Given the {N, levels, num_qudits} a solve script declares, it returns the cloud
// sizeClass (the reference's t-shirt size) plus an offload SUGGESTION vs local RAM.
// The output is DATA ONLY: no executor is selected here, nothing auto-routes (D7
// dropped the classifier) — the agent may relay the suggestion, the researcher
// confirms, and only #63's UX sets `executor` on the SolveSpec upstream. The real
// solver×integrator estimator is deferred (C2, calibrated from Δ7 records).
//
// Reference math (kept bit-identical, including its fallbacks):
//   knot_point_state_dim  = prod(levels.values)      — 1 when levels are absent or
//                                                      the fill() length var is
//                                                      unresolvable (the reference
//                                                      stores an error string that
//                                                      get_memory_estimate skips)
//   knot_point_state_dim *= knot_point_state_dim     — unitary trajectory
//   score                 = N * knot_point_state_dim^2   (= N * prod(levels)^4)
//   sizeClass             = score > 12000 ? MEDIUM : SMALL   (strict >; no LARGE in A-v1)
//
// The score counts Float64-sized entries (the dense per-knot-point quadratic block
// of the isomorphized unitary), so bytes = score × 8. The local-RAM threshold is
// os.totalmem() at runtime, overridable via AMICO_LOCAL_RAM_BYTES for tests/CI.
import { totalmem } from "node:os";
import { ConfigError } from "./types.js";

export interface Levels {
  length: number;
  values: number[];
}

export interface KeyVars {
  N?: number;
  num_qudits?: number;
  levels?: Levels;
  /** Reference parity: when the fill() length var cannot be resolved the reference
   *  stores an error string instead of values; we keep that message here and the
   *  score computation skips levels exactly as get_memory_estimate does. */
  levelsUnresolved?: string;
}

export type SizeClass = "SMALL" | "MEDIUM";

/** The reference's decision boundary: score > 12000 → MEDIUM (strict). */
export const SCORE_MEDIUM_THRESHOLD = 12000;

/** The score counts Float64-sized entries → 8 bytes each. */
export const BYTES_PER_SCORE_UNIT = 8;

/** Port of extract_key_vars: N, num_qudits/num_qubits, and levels via the three
 *  reference patterns — fill(value, var) > [array] > scalar, first match wins
 *  per pattern, fill-branch precedence over the others regardless of line order. */
export function extractKeyVars(content: string): KeyVars {
  const out: KeyVars = {};

  const nMatch = /^\s*N\s*=\s*(\d+)/m.exec(content);
  if (nMatch) out.N = Number(nMatch[1]);

  const numQuditsMatch = /^\s*num_qu(?:dits|bits)\s*=\s*(\d+)/m.exec(content);
  if (numQuditsMatch) out.num_qudits = Number(numQuditsMatch[1]);

  const fillMatch = /^\s*levels\s*=\s*fill\(\s*(\d+)\s*,\s*(\w+)\s*\)/m.exec(content);
  const arrayMatch = /^\s*levels\s*=\s*\[(.*?)\]/m.exec(content);
  const scalarMatch = /^\s*levels\s*=\s*(\d+)/m.exec(content);

  if (fillMatch) {
    const value = Number(fillMatch[1]);
    const varName = fillMatch[2];
    // varName is \w+ so it is safe to interpolate into a regex verbatim.
    const varMatch = new RegExp(`^\\s*${varName}\\s*=\\s*(\\d+)`, "m").exec(content);
    if (varMatch) {
      const length = Number(varMatch[1]);
      out.levels = { length, values: Array(length).fill(value) };
    } else if (out.num_qudits !== undefined && (varName === "num_qudits" || varName === "num_qubits")) {
      const length = out.num_qudits;
      out.levels = { length, values: Array(length).fill(value) };
    } else {
      out.levelsUnresolved = `Could not determine length from '${varName}' for fill()`;
    }
  } else if (arrayMatch) {
    const inner = arrayMatch[1].trim();
    const values = inner === "" ? [] : arrayMatch[1].split(",").map((v) => Number(v.trim()));
    if (values.some((v) => !Number.isInteger(v))) {
      // The reference would throw (int() ValueError); surface it as unresolved instead.
      out.levelsUnresolved = `Could not parse levels array [${arrayMatch[1]}] as integers`;
    } else {
      out.levels = { length: values.length, values };
    }
  } else if (scalarMatch) {
    out.levels = { length: 1, values: [Number(scalarMatch[1])] };
  }

  return out;
}

/** Port of get_memory_estimate: N × (prod(levels))⁴; absent/unresolved levels
 *  contribute nothing (knot_point_state_dim stays 1), exactly as the reference. */
export function memoryScore(vars: KeyVars): number {
  if (vars.N === undefined) throw new ConfigError("could not extract N (needed by the tshirt-sizing estimator)");
  let knotPointStateDim = 1;
  if (vars.levels) for (const v of vars.levels.values) knotPointStateDim *= v;
  knotPointStateDim *= knotPointStateDim; // assumes a unitary trajectory problem
  return vars.N * knotPointStateDim ** 2;
}

/** Port of get_tshirt_size: strict >, two classes in A-v1. */
export function tshirtSize(score: number): SizeClass {
  return score > SCORE_MEDIUM_THRESHOLD ? "MEDIUM" : "SMALL";
}

/** The local-RAM threshold: AMICO_LOCAL_RAM_BYTES (tests/CI) or os.totalmem().
 *  An invalid override is a loud ConfigError, never a silent fallback. */
export function localRamBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AMICO_LOCAL_RAM_BYTES;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0)
      throw new ConfigError(`AMICO_LOCAL_RAM_BYTES must be a positive byte count (got "${raw}")`);
    return n;
  }
  return totalmem();
}

export interface Estimate {
  sizeClass: SizeClass;
  score: number;
  estimatedBytes: number;
  localRamBytes: number;
  offloadSuggested: boolean;
  reason: string;
  inputs: { N: number; num_qudits?: number; levels?: Levels };
}

function fmtBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

/** Assemble the full estimate: sizeClass + the offload suggestion signal.
 *  Suggestion fires when the estimate EXCEEDS local RAM (strict >). Data only —
 *  the caller (agent/UX #63) decides; nothing here selects an executor. */
export function estimateFromVars(vars: KeyVars, env: NodeJS.ProcessEnv = process.env): Estimate {
  const score = memoryScore(vars);
  const estimatedBytes = score * BYTES_PER_SCORE_UNIT;
  const ram = localRamBytes(env);
  const offloadSuggested = estimatedBytes > ram;
  const sizeClass = tshirtSize(score);
  const reason = offloadSuggested
    ? `estimated ~${fmtBytes(estimatedBytes)} (score ${score}, sizeClass ${sizeClass}) exceeds local RAM ` +
      `${fmtBytes(ram)} — offload to company compute suggested; per-solve and explicit, nothing auto-routes`
    : `estimated ~${fmtBytes(estimatedBytes)} (score ${score}, sizeClass ${sizeClass}) fits within local RAM ${fmtBytes(ram)}`;
  const inputs: Estimate["inputs"] = { N: vars.N! };
  if (vars.num_qudits !== undefined) inputs.num_qudits = vars.num_qudits;
  if (vars.levels) inputs.levels = vars.levels;
  return { sizeClass, score, estimatedBytes, localRamBytes: ram, offloadSuggested, reason, inputs };
}

// Cross-language ProblemSpec hashing — the TypeScript mirror of Piccolo's
// src/specs/hashes.jl. `structureHash`/`problemHash` MUST be byte-identical to
// `Piccolo.Specs.structure_hash`/`problem_hash` for every shared fixture
// (test/hashing.test.ts checks against Julia-emitted sidecars). Plan 2 Task 5.
//
// Two-stage, exactly as Julia:
//   problemHash   = sha256hex(canonicalJson(fullDict(spec)))
//   structureHash = sha256hex(canonicalJson(structureFields(spec)))
// where `spec` is the raw TOML object (smol-toml parse). fullDict/structureFields
// apply the SAME parse_spec defaults + wire projection the Julia structs carry, so
// the two languages hash the same logical spec even though smol-toml and TOML.jl
// disagree on int-vs-float parsing.
//
// Numeric rule (pinned, mirrors hashes.jl `_es_number`): integer-VALUED numbers
// render as bare integers ("100.0" -> "100"); non-integers use the ECMAScript
// Number::toString algorithm. In JS that algorithm *is* `String(x)` (JSON.stringify
// uses it too), and JS cannot distinguish 100 from 100.0 — so `String(x)` gives the
// int/float-agnostic output for free. Julia's `_es_number` was hand-built to match
// this exact algorithm; do NOT swap in any other float formatter on either side.
import { createHash } from "node:crypto";

type Json = null | boolean | number | bigint | string | Json[] | { [k: string]: Json };
// Raw smol-toml value (Date appears for bare datetimes; specs never carry them).
type Raw = unknown;

// ── canonical JSON (mirror of hashes.jl `canonical_json`) ──────────────────────
export function canonicalJson(x: Json): string {
  if (x === null || x === undefined) return "null";
  if (typeof x === "boolean") return x ? "true" : "false";
  if (typeof x === "bigint") return x.toString(); // always integer-valued
  if (typeof x === "number") return canonNumber(x);
  if (typeof x === "string") return canonString(x);
  if (Array.isArray(x)) return "[" + x.map((v) => canonicalJson(v)).join(",") + "]";
  if (typeof x === "object") {
    const keys = Object.keys(x).sort(); // ASCII keys: JS UTF-16 sort == Julia code-point sort
    return "{" + keys.map((k) => canonString(k) + ":" + canonicalJson((x as Record<string, Json>)[k])).join(",") + "}";
  }
  throw new Error(`canonicalJson cannot serialize ${typeof x}`);
}

function canonNumber(x: number): string {
  if (!Number.isFinite(x)) throw new Error(`canonicalJson cannot serialize non-finite number ${x}`);
  return String(x); // ECMAScript Number::toString — the reference algo hashes.jl mirrors
}

function canonString(s: string): string {
  let out = '"';
  for (const c of s) {
    if (c === '"') out += '\\"';
    else if (c === "\\") out += "\\\\";
    else if (c === "\b") out += "\\b";
    else if (c === "\t") out += "\\t";
    else if (c === "\n") out += "\\n";
    else if (c === "\f") out += "\\f";
    else if (c === "\r") out += "\\r";
    else if (c < "\x20") out += "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0");
    else out += c;
  }
  return out + '"';
}

// ── helpers ────────────────────────────────────────────────────────────────
const obj = (v: Raw): Record<string, Raw> => (v ?? {}) as Record<string, Raw>;
const isObj = (v: Raw): v is Record<string, Raw> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyObj = (v: Raw): boolean => isObj(v) && Object.keys(v).length > 0;
const isNum = (v: Raw): v is number => typeof v === "number" || typeof v === "bigint";
const isFiniteNum = (v: Raw): boolean => (typeof v === "number" && Number.isFinite(v)) || typeof v === "bigint";
// _wireval: TOML values are already string-keyed; pass scalars/arrays/objects
// through verbatim (canonicalJson does the sorting + number formatting).
const wire = (v: Raw): Json => v as Json;

// ── full_dict wire projection (mirror of hashes.jl `full_dict` + parse defaults) ─
export function fullDict(spec: Raw): Json {
  const s = obj(spec);
  const d: Record<string, Json> = {};
  d.schema_version = isNum(s.schema_version) ? (s.schema_version as Json) : 1;
  d.kind = "control";
  d.system = systemDict(s.system);
  if (s.goal != null) d.goal = goalDict(s.goal);
  if (s.pulse != null) d.pulse = pulseDict(s.pulse);
  const traj = obj(s.trajectory);
  if (traj.kind != null) d.trajectory = { kind: String(traj.kind) };
  if (s.problem != null) d.problem = problemDict(s.problem);
  if (s.integrator != null) d.integrator = integratorDict(s.integrator);
  if (Array.isArray(s.wrappers) && s.wrappers.length > 0) d.wrappers = s.wrappers.map(wrapperDict);
  d.solver = solverDict(s.solver);
  if (s.warm_start != null) d.warm_start = warmStartDict(s.warm_start);
  return d;
}

function systemDict(sys: Raw): Json {
  const s = obj(sys);
  const d: Record<string, Json> = { kind: String(s.kind ?? "template") };
  if (s.template != null) d.template = String(s.template);
  if (nonEmptyObj(s.params)) d.params = wire(s.params);
  if (nonEmptyObj(s.global_params)) d.global_params = wire(s.global_params);
  if (s.components != null) d.components = wire(s.components);
  if (s.H_drift != null) d.H_drift = wire(s.H_drift);
  if (s.H_drives != null) d.H_drives = wire(s.H_drives);
  return d;
}

function goalDict(goal: Raw): Json {
  const g = obj(goal);
  const d: Record<string, Json> = { kind: String(g.kind) };
  if (g.gate != null) d.gate = String(g.gate);
  if (g.matrix != null) d.matrix = wire(g.matrix);
  if (g.target != null) d.target = g.target as Json;
  if (g.initial != null) d.initial = g.initial as Json;
  if (g.subsystem_levels != null) d.subsystem_levels = wire(g.subsystem_levels);
  if (g.subspace != null) d.subspace = wire(g.subspace);
  return d;
}

// _pulse_dict ALWAYS emits kind, T, init, seed (defaults filled by parse_spec).
function pulseDict(pulse: Raw): Json {
  const p = obj(pulse);
  return { kind: String(p.kind), T: p.T as Json, init: String(p.init ?? "default"), seed: (p.seed ?? 0) as Json };
}

// _problem_dict: template, N, goal_treatment, free_dt, Q, R, free_phase ALWAYS;
// the rest only when present (du_bound only when finite — Inf default is omitted).
function problemDict(prob: Raw): Json {
  const p = obj(prob);
  const d: Record<string, Json> = {
    template: String(p.template),
    N: p.N as Json,
    goal_treatment: String(p.goal_treatment ?? "objective"),
    free_dt: Array.isArray(p.free_dt) ? (p.free_dt as Json) : false,
    Q: isNum(p.Q) ? (p.Q as Json) : 100.0,
    R: isNum(p.R) ? (p.R as Json) : 1e-2,
    free_phase: (p.free_phase ?? false) as Json,
  };
  if (p.final_fidelity != null) d.final_fidelity = p.final_fidelity as Json;
  if (p.R_u != null) d.R_u = p.R_u as Json;
  if (p.R_du != null) d.R_du = p.R_du as Json;
  if (p.R_ddu != null) d.R_ddu = p.R_ddu as Json;
  if (p.du_bound != null && isFiniteNum(p.du_bound)) d.du_bound = p.du_bound as Json;
  if (p.ddu_bound != null) d.ddu_bound = p.ddu_bound as Json;
  if (p.initial_phases != null) d.initial_phases = wire(p.initial_phases);
  if (Array.isArray(p.calibration_targets) && p.calibration_targets.length > 0)
    d.calibration_targets = p.calibration_targets.map(String);
  if (Array.isArray(p.global_names) && p.global_names.length > 0) d.global_names = p.global_names.map(String);
  if (nonEmptyObj(p.global_bounds)) d.global_bounds = wire(p.global_bounds);
  if (Array.isArray(p.objectives) && p.objectives.length > 0)
    d.objectives = p.objectives.map((o) => {
      const t = obj(o);
      return { kind: String(t.kind), weight: (t.weight ?? 1.0) as Json };
    });
  if (nonEmptyObj(p.options)) d.options = wire(p.options);
  return d;
}

// _integrator_dict: {kind, alg} with parse defaults.
function integratorDict(integ: Raw): Json {
  const i = obj(integ);
  return { kind: String(i.kind ?? "bilinear"), alg: String(i.alg ?? "tsit5") };
}

function wrapperDict(wrap: Raw): Json {
  const w = obj(wrap);
  const d: Record<string, Json> = { kind: String(w.kind) };
  if (Array.isArray(w.variants) && w.variants.length > 0) d.variants = w.variants.map(wire);
  if (w.weights != null) d.weights = wire(w.weights);
  return d;
}

// _solver_dict ALWAYS emits backend, device, precision, max_iter, strategy; tol if present.
function solverDict(solver: Raw): Json {
  const s = obj(solver);
  const d: Record<string, Json> = {
    backend: String(s.backend ?? "ipopt"),
    device: String(s.device ?? "cpu"),
    precision: String(s.precision ?? "f64"),
    max_iter: (s.max_iter ?? 500) as Json,
    strategy: String(s.strategy ?? "direct"),
  };
  if (s.tol != null) d.tol = s.tol as Json;
  return d;
}

function warmStartDict(ws: Raw): Json {
  const w = obj(ws);
  const d: Record<string, Json> = {};
  if (w.catalog_ref != null) d.catalog_ref = w.catalog_ref as Json;
  if (w.pulse_hash != null) d.pulse_hash = w.pulse_hash as Json;
  return d;
}

// ── structure_fields (mirror of hashes.jl `structure_fields`) ──────────────────
// The type-determining carve-out: excludes N/T/Q/regularizer weights so a
// resize/reweight preserves structure_hash while changing problem_hash.
export function structureFields(spec: Raw): Json {
  const s = obj(spec);
  const d: Record<string, Json> = { kind: "control" };
  const sysIn = obj(s.system);
  const sys: Record<string, Json> = { kind: String(sysIn.kind ?? "template") };
  if (sysIn.template != null) sys.template = String(sysIn.template);
  const params = obj(sysIn.params);
  if (params.levels != null) sys.levels = wire(params.levels);
  d.system = sys;

  const traj = obj(s.trajectory);
  if (traj.kind != null) d.trajectory_kind = String(traj.kind);
  else if (s.goal != null) d.trajectory_kind = String(obj(s.goal).kind);

  if (s.pulse != null) d.pulse_kind = String(obj(s.pulse).kind);

  if (s.problem != null) {
    const p = obj(s.problem);
    const prob: Record<string, Json> = {
      template: String(p.template),
      goal_treatment: String(p.goal_treatment ?? "objective"),
      free_dt: Array.isArray(p.free_dt) ? "free" : "fixed",
      free_phase: (p.free_phase ?? false) as Json,
      objective_kinds: (Array.isArray(p.objectives) ? p.objectives : []).map((o) => String(obj(o).kind)).sort(),
    };
    const options = obj(p.options);
    if (options.leakage_constraint != null) prob.leakage_constraint = wire(options.leakage_constraint);
    d.problem = prob;
  }

  if (s.integrator != null) {
    const i = obj(s.integrator);
    d.integrator = { kind: String(i.kind ?? "bilinear"), alg: String(i.alg ?? "tsit5") };
  }

  d.wrapper_kinds = (Array.isArray(s.wrappers) ? s.wrappers : []).map((w) => String(obj(w).kind)).sort();

  const solverIn = obj(s.solver);
  d.solver = {
    backend: String(solverIn.backend ?? "ipopt"),
    device: String(solverIn.device ?? "cpu"),
    precision: String(solverIn.precision ?? "f64"),
    strategy: String(solverIn.strategy ?? "direct"),
  };
  return d;
}

// ── hashes ─────────────────────────────────────────────────────────────────
export const sha256hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** SHA-256 hex of canonicalJson(structureFields(spec)) — the problem's *shape* key. */
export function structureHash(spec: Raw): string {
  return sha256hex(canonicalJson(structureFields(spec)));
}

/** SHA-256 hex of canonicalJson(fullDict(spec)) — the *full* problem-instance key. */
export function problemHash(spec: Raw): string {
  return sha256hex(canonicalJson(fullDict(spec)));
}

// ── deliberation hashes (spec-20260728 §2.4, §4.1) ───────────────────────────────

/** Drop every undefined- OR null-valued key. `canonicalJson` renders both as "null",
 *  and a literal `{a, b, c}` with `c: undefined` still has an enumerable `c` — so
 *  without this an absent budget hashes as `"budget":null`: stable, permanent, and
 *  wrong, with nothing anywhere reporting an error. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** The Spec's DECISION-SURFACE hash. Named `designHash`, NOT `specHash`: gate.ts already
 *  stamps `hashes.spec_hash` as the sha256 of the canonical SOLVESPEC, and one name over
 *  two populations makes any join across them silently wrong.
 *
 *  Covers `task_type`, `acceptance` and `budget` only. `acceptance` entries are trimmed,
 *  inner whitespace collapsed, then SORTED (UTF-16 code units, matching canonicalJson's
 *  own key sort) — reordering independent criteria is not a decision change. `invariants`
 *  and `assumptions` are excluded deliberately: prose must not re-gate a live warrant,
 *  and a violated assumption is a runtime blocked-report rather than a re-approval. */
export function designHash(spec: Record<string, unknown>): string {
  const acceptance = Array.isArray(spec.acceptance)
    ? (spec.acceptance as unknown[]).map((s) => String(s).trim().replace(/\s+/g, " ")).sort()
    : [];
  return sha256hex(canonicalJson(compact({ task_type: spec.task_type, acceptance, budget: spec.budget }) as Json));
}

/** The compiled Plan's hash: `goal` + `steps` only. `design_hash` and `compiled_at` are
 *  excluded so a recompile that changed nothing does not mint a new hash — which would
 *  invalidate a live warrant for no reason. */
export function planHash(plan: Record<string, unknown>): string {
  return sha256hex(canonicalJson(compact({ goal: plan.goal, steps: plan.steps }) as Json));
}

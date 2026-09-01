// ============================================================================
// Entity TOML writers for the amicode_* tool pack — pure, dependency-free.
//
// This file is imported from TWO runtimes and must stay import-free (types +
// functions only, no node: builtins, no npm packages):
//   1. opencode's embedded Bun runtime — amicode_tools.ts (the plugin, loaded
//      by absolute path via OPENCODE_CONFIG_CONTENT `plugin: [...]`) does
//      `import { ... } from "./entities"`; Bun transpiles TS natively and
//      resolves the relative sibling, but nothing guarantees npm resolution
//      from this directory, so we depend on nothing.
//   2. vitest (test/amicode_tools.test.ts) — round-trips the emitted TOML
//      through `smol-toml`, the parser @amicode/schema and the extension use.
//
// Entities live under <entitiesDir> (see amicode_tools.ts): System and
// Formulation are the interview's durable design state; the Run *stub* records
// that a launch was requested — it is bookkeeping, NOT the run-dir `run.toml`
// that amico-run itself writes (different directory, different schema).
//
// `recorded` is emitted as a QUOTED ISO-8601 string, not a bare TOML datetime:
// smol-toml parses bare datetimes into TomlDate objects (schema/src/index.ts
// has a note on exactly this trap), and downstream consumers want a plain
// string. Serializers throw on invalid entities; validate* return a list of
// human-readable problems so tools can answer the chat without throwing.
// ============================================================================

export interface SystemEntity {
  /** Open platform string (spec A): any platform a Legato/Piccolo/Intonato user
   *  names. Known platforms (KNOWN_PLATFORMS) keep their affordances; unknown
   *  ones are recorded honestly. Validated non-empty. */
  platform: string;
  /** Optional — platform-dependent. Only transmon defaults to 3; unknown
   *  platforms get no default. When given: integer >= MIN_LEVELS (no upper
   *  error — the old <=6 cap is now a tool-side warning, not a validation error). */
  levels?: number;
  /** Named physical parameters, e.g. omega/delta (GHz), drive_max. */
  params: Record<string, number>;
  /** Free text for what params can't hold (e.g. topology prose). EXCLUDED from
   *  the canonical hash input (prose edits must not churn identity). */
  notes?: string;
}

/** Structured solve parameters merged into the Formulation (spec A): they are the
 *  hash-relevant "duration/knots + integrator + parameterization + pinned globals"
 *  half of amicode#64's formulation_hash. Written by amicode_solve. */
export interface SolveParams {
  T?: number;
  N?: number;
  max_iter?: number;
  integrator?: string;
  parameterization?: string;
  pinned_globals?: string[];
}

/** Legacy free-form Formulation (on-disk pre-spec-20260709). Migrated by
 *  normalizeFormulation; no longer written. */
export interface LegacyFormulationEntity {
  problem: string;
  target: string;
  objective: string;
  constraints: string[];
  solve?: SolveParams;
}

// ---- Formulation typed facets (spec-20260709 §3) ---------------------------
export type TrajectoryType = "ket" | "multiket" | "gate" | "density" | "multidensity";
export type TimeMode = "fixed" | "min_time";
export type Parameterization = "smooth" | "linear_spline" | "cubic_spline" | "bang_bang";
export type RobustnessKind = "none" | "ensemble" | "sensitivity";
export type ConstraintKind =
  | "bounds"
  | "du_bound"
  | "ddu_bound"
  | "dt_bounds"
  | "final_fidelity"
  | "calibration_pin"
  | "custom";
export type ObjectiveKind = "reg_u" | "reg_du" | "reg_ddu" | "sensitivity" | "custom";

export const TRAJECTORY_TYPES: TrajectoryType[] = ["ket", "multiket", "gate", "density", "multidensity"];
export const TIME_MODES: TimeMode[] = ["fixed", "min_time"];
export const PARAMETERIZATIONS: Parameterization[] = ["smooth", "linear_spline", "cubic_spline", "bang_bang"];
export const ROBUSTNESS_KINDS: RobustnessKind[] = ["none", "ensemble", "sensitivity"];
export const CONSTRAINT_KINDS: ConstraintKind[] = [
  "bounds",
  "du_bound",
  "ddu_bound",
  "dt_bounds",
  "final_fidelity",
  "calibration_pin",
  "custom",
];
export const OBJECTIVE_KINDS: ObjectiveKind[] = ["reg_u", "reg_du", "reg_ddu", "sensitivity", "custom"];

export interface Robustness {
  kind: RobustnessKind;
  params: Record<string, number | string>;
}
export interface ObjectiveTerm {
  kind: ObjectiveKind;
  params: Record<string, number>;
  label?: string;
}
export interface Constraint {
  kind: ConstraintKind;
  params: Record<string, number>;
  label?: string;
}

/** Structured Formulation (spec-20260709 §3). Legacy free-form entities migrate
 *  via normalizeFormulation. The PRIMARY objective is DERIVED (trajectory_type +
 *  free_phase + time_mode), never stored; `objectives[]` holds ADDED terms only.
 *  Leakage's sole home is the flag + leakage_params. */
export interface FormulationEntity {
  trajectory_type: TrajectoryType;
  time_mode: TimeMode;
  /** {final_fidelity?, D?} — used/editable when time_mode === "min_time". */
  time_params?: Record<string, number>;
  parameterization: Parameterization;
  robustness: Robustness;
  free_phase: boolean;
  leakage: boolean;
  /** {value?, cost?} when leakage=true — encodes both the constraint and objective. */
  leakage_params?: Record<string, number>;
  target: string;
  /** ADDED terms only (regularizers/sensitivity/custom); primary is derived. */
  objectives: ObjectiveTerm[];
  constraints: Constraint[];
  /** Solve params (spec A) — present once amicode_solve has recorded them. */
  solve?: SolveParams;
  notes?: string;
}

// ---- Formulation migration + merge (spec §3.1.3, §8, §10) ------------------

function normRobustness(r: unknown): Robustness {
  if (r && typeof r === "object" && typeof (r as any).kind === "string") {
    const o = r as any;
    return { kind: o.kind, params: o.params && typeof o.params === "object" ? o.params : {} };
  }
  return { kind: "none", params: {} };
}
function normTerm<T extends { kind: string; params: Record<string, number>; label?: string }>(o: any): T {
  const out: any = { kind: o.kind, params: o.params && typeof o.params === "object" ? o.params : {} };
  if (typeof o.label === "string") out.label = o.label;
  return out as T;
}
function inferTypeFromTarget(target: string): TrajectoryType {
  return /^\s*\||prep|state/i.test(target) ? "ket" : "gate";
}
function constraintKindFor(lc: string): ConstraintKind {
  if (/slew|\bdu\b/.test(lc)) return "du_bound";
  if (/ddu|accel/.test(lc)) return "ddu_bound";
  if (/Δt|timestep|\bdt\b/.test(lc)) return "dt_bounds";
  if (/calibration|\bpin\b/.test(lc)) return "calibration_pin";
  if (/amplitude|bound/.test(lc)) return "bounds";
  return "custom";
}

/** Legacy free-form → structured; structured passes through (defaults filled).
 *  §10 mapping table. Idempotent. Never throws. */
export function normalizeFormulation(raw: unknown): FormulationEntity {
  const r = (raw ?? {}) as Record<string, any>;

  // Already structured → normalize sub-shapes, fill defaults, pass through.
  if (typeof r.trajectory_type === "string") {
    const out: FormulationEntity = {
      trajectory_type: r.trajectory_type as TrajectoryType,
      time_mode: r.time_mode === "min_time" ? "min_time" : "fixed",
      parameterization: typeof r.parameterization === "string" ? (r.parameterization as Parameterization) : "smooth",
      robustness: normRobustness(r.robustness),
      free_phase: r.free_phase === true,
      leakage: r.leakage === true,
      target: typeof r.target === "string" ? r.target : "",
      objectives: Array.isArray(r.objectives) ? r.objectives.map((o: any) => normTerm<ObjectiveTerm>(o)) : [],
      constraints: Array.isArray(r.constraints) ? r.constraints.map((c: any) => normTerm<Constraint>(c)) : [],
    };
    if (r.time_params && typeof r.time_params === "object") out.time_params = r.time_params;
    if (r.leakage_params && typeof r.leakage_params === "object") out.leakage_params = r.leakage_params;
    if (r.solve && typeof r.solve === "object") out.solve = r.solve;
    if (typeof r.notes === "string") out.notes = r.notes;
    return out;
  }

  // Legacy free-form.
  const problem = typeof r.problem === "string" ? r.problem : "";
  const target = typeof r.target === "string" ? r.target : "";
  let trajectory_type: TrajectoryType = "gate";
  let time_mode: TimeMode = "fixed";
  if (problem === "state_prep") trajectory_type = "ket";
  else if (problem === "min_time") {
    time_mode = "min_time";
    trajectory_type = inferTypeFromTarget(target);
  }

  const objectives: ObjectiveTerm[] = [];
  const objStr = typeof r.objective === "string" ? r.objective.trim() : "";
  if (objStr && !/infidelity/i.test(objStr)) objectives.push({ kind: "custom", params: {}, label: objStr });

  const constraints: Constraint[] = [];
  let leakage = false;
  let time_params: Record<string, number> | undefined;
  for (const c of Array.isArray(r.constraints) ? r.constraints : []) {
    if (typeof c !== "string") continue;
    const lc = c.toLowerCase();
    if (/leakage/.test(lc)) {
      leakage = true;
      continue;
    }
    if (/final.?fidelity/.test(lc)) {
      const m = c.match(/[\d.]+/);
      time_params = { ...(time_params ?? {}), final_fidelity: m ? Number(m[0]) : 0.99 };
      continue;
    }
    constraints.push({ kind: constraintKindFor(lc), params: {}, label: c });
  }

  const out: FormulationEntity = {
    trajectory_type,
    time_mode,
    parameterization: "smooth",
    robustness: { kind: "none", params: {} },
    free_phase: false,
    leakage,
    target,
    objectives,
    constraints,
  };
  if (time_params) out.time_params = time_params;
  if (r.solve && typeof r.solve === "object") out.solve = r.solve;
  if (typeof r.notes === "string") out.notes = r.notes;
  return out;
}

export interface FormulationPatch {
  trajectory_type?: TrajectoryType;
  time_mode?: TimeMode;
  time_params?: Record<string, number>;
  parameterization?: Parameterization;
  robustness?: Robustness;
  free_phase?: boolean;
  leakage?: boolean;
  leakage_params?: Record<string, number>;
  target?: string;
  objectives?: ObjectiveTerm[];
  constraints?: Constraint[];
  solve?: SolveParams;
  notes?: string;
}

/** Normalize the (possibly legacy) existing, then upsert: scalar modes replace,
 *  sets replace-whole when provided, param bags shallow-merge. */
export function updateFormulation(existing: unknown, patch: FormulationPatch): FormulationEntity {
  const base = normalizeFormulation(existing);
  const merged: FormulationEntity = { ...base };
  if (patch.trajectory_type !== undefined) merged.trajectory_type = patch.trajectory_type;
  if (patch.time_mode !== undefined) merged.time_mode = patch.time_mode;
  if (patch.parameterization !== undefined) merged.parameterization = patch.parameterization;
  if (patch.robustness !== undefined) merged.robustness = patch.robustness;
  if (patch.free_phase !== undefined) merged.free_phase = patch.free_phase;
  if (patch.leakage !== undefined) merged.leakage = patch.leakage;
  if (patch.target !== undefined) merged.target = patch.target;
  if (patch.objectives !== undefined) merged.objectives = patch.objectives;
  if (patch.constraints !== undefined) merged.constraints = patch.constraints;
  if (patch.time_params !== undefined) merged.time_params = { ...(base.time_params ?? {}), ...patch.time_params };
  if (patch.leakage_params !== undefined) merged.leakage_params = { ...(base.leakage_params ?? {}), ...patch.leakage_params };
  if (patch.solve !== undefined) merged.solve = { ...(base.solve ?? {}), ...patch.solve };
  if (patch.notes !== undefined) merged.notes = patch.notes;
  return merged;
}

export interface RunStub {
  formulation_ref?: string;
  system_ref?: string;
  /** Run directory, when the bash launch already happened and the agent knows it. */
  run_dir?: string;
  /** Authoring tier (spec C): vetted | composed | free. */
  tier?: "vetted" | "composed" | "free";
  /** Path to the authored script (spec C — workspace-owned solve.jl). */
  script_ref?: string;
  /** Resolved env binding kind (spec C). */
  env?: string;
  /** SEAM 5 (#681): the bank seed this run warm-started from (catalog entry id
   *  or pulse ref) — the load_traj idiom's recorded half. Additive. */
  warm_start?: string;
  /** Free-tier re-rollout verification outcome (spec C) — recorded by
   *  amicode_verify after amico-run's harness writes verification.toml. Spec B's
   *  entity view renders it beside the tier; promotion is gated on agree. */
  verification?: {
    agree: boolean;
    fidelity_rerolled?: number | null;
    fidelity_reported?: number | null;
  };
  /** Optional free-text note ("X gate, defaults"). */
  note?: string;
}

/** Problem workspace identity (spec A) — the `[problem]` table of problem.toml. */
export interface ProblemScoreRef {
  id: string;
  version: number;
}

export interface ProblemEnvBinding {
  /** provisioned (~/.amico/julia) | project (a Julia project path) | sandbox
   *  (generated per-problem). NO cloud kind — executor routing is per-solve. */
  kind: "provisioned" | "project" | "sandbox";
  path?: string;
}

export interface ProblemMeta {
  name: string;
  slug: string;
  created: string;
  /** Only these two persist; solving/solved are display-derived (spec A). */
  status: "designing" | "archived";
  recorded?: string;
  score?: ProblemScoreRef;
  env?: ProblemEnvBinding;
}

/** A reference into ~/.amico/runs/<lab>/<runId> (spec A) — the workspace stores
 *  refs only; RunsManager's runs/index is the run source of truth. */
export interface RunRef {
  run_id: string;
  lab: string;
  tier?: "vetted" | "composed" | "free";
  recorded: string;
}

/** Stage-8 guided stub (amicode_to_hardware): records intent to send a pulse to
 *  a device. THIS BUILD PERFORMS NO DEVICE I/O — `gate` and `checks` are fixed
 *  by the serializer (pending-human-sign-off + the auto-check list), never
 *  caller-supplied, so a stub can't claim an approval that didn't happen. */
export interface DeviceSessionStub {
  /** The solved pulse artifact (pulse.jld2) if known. */
  pulse_ref?: string;
  /** The run directory the pulse came from, if known. */
  run_dir?: string;
  note?: string;
  /** SEAM 1 (#680): the MockSoc rehearsal record — the solved pulse's run
   *  through the Strumento.jl transport path, honestly labeled sim. Parsed +
   *  validated from the rehearsal.toml artifact (./rehearsal.ts); additive —
   *  a stub without it is the pre-SEAM-1 honest stub, unchanged. */
  rehearsal?: RehearsalRecord;
}

/** SEAM 1 (#680): what the MockSoc rehearsal actually produced. NO `sim` field
 *  by design — the serializer PINS `sim = true` on the record (a rehearsal is
 *  a sim preview, never a hardware claim), so a caller cannot label it
 *  otherwise. Outcome-gated: `rehearsalSatisfiesStage` is the only satisfier
 *  of the hardware stage — a failed rehearsal records honestly and does NOT
 *  satisfy it. */
export interface RehearsalRecord {
  /** The transport path: "mocksoc" — Strumento's Piccolo-extension MockSoc
   *  (translate → envelopes → execute! → synthetic IQ → Measurement → one
   *  strategy step). The only kind today; anything else is not a rehearsal. */
  kind: "mocksoc";
  outcome: "success" | "failed";
  /** Content-hash (sha256:<hex>) of the pulse.jld2 bytes the rehearsal ran. */
  pulse_hash: string;
  /** The mock system's mismatch declaration (e.g. "delta × 1.05 …"). */
  mismatch: string;
  /** The strategy-step outcome. REQUIRED when outcome === "success". */
  step_outcome?: string;
  /** What failed. REQUIRED when outcome === "failed". */
  error?: string;
  /** ISO-8601, from the artifact (quoted string — same rule as `recorded`). */
  recorded?: string;
}

/** The outcome gate (SEAM 1 AC): a rehearsal satisfies the hardware stage ONLY
 *  on success. A failed rehearsal is surfaced distinctly and leaves the stage
 *  an honest stub — never a costume of progress. */
export function rehearsalSatisfiesStage(rec: RehearsalRecord): boolean {
  return rec.outcome === "success";
}

/** Human-readable problems for a RehearsalRecord (shaped for readRehearsalRecord
 *  in ./rehearsal.ts, which normalizes the parsed artifact into one). [] = valid. */
export function validateRehearsalRecord(rec: Partial<RehearsalRecord>): string[] {
  const problems: string[] = [];
  if (rec.kind !== "mocksoc") {
    problems.push(`kind must be "mocksoc" (the Strumento transport path), got ${JSON.stringify(rec.kind)}`);
  }
  if (rec.outcome !== "success" && rec.outcome !== "failed") {
    problems.push(`outcome must be "success" | "failed", got ${JSON.stringify(rec.outcome)}`);
  }
  if (typeof rec.pulse_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(rec.pulse_hash)) {
    problems.push(`pulse_hash must be a sha256 content-hash ("sha256:<64 hex>"), got ${JSON.stringify(rec.pulse_hash)}`);
  }
  if (typeof rec.mismatch !== "string" || rec.mismatch.trim() === "") {
    problems.push("mismatch must be a non-empty declaration of the mock system's mismatch");
  }
  if (rec.outcome === "success" && (typeof rec.step_outcome !== "string" || rec.step_outcome.trim() === "")) {
    problems.push("step_outcome is required on success — a success must have proven the strategy step");
  }
  if (rec.outcome === "failed" && (typeof rec.error !== "string" || rec.error.trim() === "")) {
    problems.push("error is required on a failed rehearsal (what failed)");
  }
  if (rec.recorded !== undefined && typeof rec.recorded !== "string") {
    problems.push("recorded must be a string when given");
  }
  return problems;
}

/** Guided follow-up stub (amicode_calibrate): the calibration loop that follows
 *  hardware runs. `loop`/`status` are fixed by the serializer — "not-wired" is
 *  the honest state of this build. */
export interface CalibrationStub {
  device_session_ref?: string;
  note?: string;
}

// --- SEAM 5 (#681): the calibrate→pin→re-optimize→re-bank chain record ----------

/** The chain's fingerprint (spec SEAM 5): what the calibration was, which globals
 *  got pinned, which bank pulse seeded the re-solve, and — once the human-gated
 *  re-bank is verified — the promoted entry with the provenance its catalog note
 *  carries. Composes EXISTING seams; the record is the recording path's spine.
 *
 *  STRUCTURAL HONESTY: `leg` is the literal "mock" — the ONLY constructible leg.
 *  The hardware leg is a REFUSAL in the recording path (real-board sessions are
 *  an enumerated human gate), never a record variant, so no caller can label a
 *  chain hardware-flavored. `promotion` is NOT a field: the serializer DERIVES it
 *  (pending-human-sign-off while staged; human-gated-rebank-recorded once the
 *  verified re-bank leg lands) — the record can never claim an approval that
 *  didn't happen through the human-gated ingest. */
export interface CalibChainRecord {
  leg: "mock";
  /** The calibration leg — the SEAM 1 rehearsal artifact is the mock calibration
   *  data source (the cross-seam dependency, explicit). */
  calibration: {
    /** The rehearsal.toml artifact the calibration ran on. */
    source: string;
    /** Content-hash of the pulse the calibration ran (from the artifact). */
    pulse_hash: string;
    /** The calibration's mismatch declaration (mock truth vs nominal model). */
    mismatch: string;
  };
  /** The pin: global → calibrated value. Lands on the formulation as the
   *  existing `calibration_pin` constraint (params = these values) and as
   *  `solve.pinned_globals` (the names) — the fix_global_variable! path. */
  pinned_globals: Record<string, number>;
  /** The bank seed the re-solve warm-started from (catalog entry id or pulse
   *  ref) — the load_traj idiom's recorded half. */
  warm_start: string;
  /** The re-solve's run directory, once launched through the solve path. */
  run_dir?: string;
  note?: string;
  /** Present ONLY after the human-gated promotion is VERIFIED against the
   *  promoted entry's catalog note (the fingerprint must match). */
  rebank?: {
    catalog_entry: string;
    /** The provenance the catalog note carries (checked to MATCH this chain
     *  before the executed marker can land — see ./calib_chain.ts). */
    provenance: {
      warm_start: string;
      calibration_ref: string;
      pinned_globals: Record<string, number>;
    };
  };
}

/** Human-readable problems for a CalibChainRecord; [] = valid. */
export function validateCalibChainRecord(rec: Partial<CalibChainRecord>): string[] {
  const problems: string[] = [];
  if (rec.leg !== "mock") {
    problems.push(
      `leg must be "mock" — the hardware leg runs ONLY inside a real-board session (an enumerated human gate) and is never recordable, got ${JSON.stringify(rec.leg)}`,
    );
  }
  const cal = rec.calibration as CalibChainRecord["calibration"] | undefined;
  if (!cal || typeof cal.source !== "string" || cal.source.trim() === "") {
    problems.push("calibration.source must be a non-empty path to the calibration artifact");
  }
  if (!cal || typeof cal.pulse_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(cal.pulse_hash)) {
    problems.push(`calibration.pulse_hash must be a sha256 content-hash ("sha256:<64 hex>"), got ${JSON.stringify(cal?.pulse_hash)}`);
  }
  if (!cal || typeof cal.mismatch !== "string" || cal.mismatch.trim() === "") {
    problems.push("calibration.mismatch must be a non-empty declaration of the calibrated mismatch");
  }
  const pinProblems = (pin: unknown, field: string): void => {
    if (typeof pin !== "object" || pin === null || Array.isArray(pin)) {
      problems.push(`${field} must be a table of global → calibrated value`);
      return;
    }
    const entries = Object.entries(pin as Record<string, unknown>);
    if (entries.length === 0) problems.push(`${field} must pin at least one global`);
    for (const [k, v] of entries) {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        problems.push(`${field}["${k}"] must be a finite number, got ${JSON.stringify(v)}`);
      }
    }
  };
  pinProblems(rec.pinned_globals, "pinned_globals");
  if (typeof rec.warm_start !== "string" || rec.warm_start.trim() === "") {
    problems.push("warm_start must be a non-empty bank seed (catalog entry id or pulse ref)");
  }
  if (rec.run_dir !== undefined && (typeof rec.run_dir !== "string" || rec.run_dir.trim() === "")) {
    problems.push("run_dir must be a non-empty path when given");
  }
  if (rec.rebank !== undefined) {
    const rb = rec.rebank;
    if (typeof rb.catalog_entry !== "string" || rb.catalog_entry.trim() === "") {
      problems.push("rebank.catalog_entry must be a non-empty catalog entry id");
    }
    const prov = rb.provenance as NonNullable<CalibChainRecord["rebank"]>["provenance"] | undefined;
    if (!prov || typeof prov.warm_start !== "string" || prov.warm_start.trim() === "") {
      problems.push("rebank.provenance.warm_start must be a non-empty seed");
    }
    if (!prov || typeof prov.calibration_ref !== "string" || prov.calibration_ref.trim() === "") {
      problems.push("rebank.provenance.calibration_ref must be a non-empty calibration ref");
    }
    pinProblems(prov?.pinned_globals, "rebank.provenance.pinned_globals");
  }
  return problems;
}

/** Serialize the chain record under [calib_chain]. `leg` is pinned "mock" and
 *  `promotion` DERIVED (staged → "pending-human-signoff"; verified re-bank →
 *  "human-gated-rebank-recorded") — neither is caller data, mirroring the
 *  rehearsal record's pinned `sim = true`. Throws on an invalid record. */
export function calibChainToml(rec: CalibChainRecord, now?: Date): string {
  const problems = validateCalibChainRecord(rec);
  if (problems.length > 0) throw new Error(`invalid calib chain: ${problems.join("; ")}`);
  const lines = ["[calib_chain]"];
  lines.push(`leg = ${tomlEscape(rec.leg)}`); // pinned — the record has no hardware variant
  lines.push(`promotion = ${tomlEscape(rec.rebank ? "human-gated-rebank-recorded" : "pending-human-signoff")}`);
  lines.push(`warm_start = ${tomlEscape(rec.warm_start)}`);
  if (rec.run_dir !== undefined) lines.push(`run_dir = ${tomlEscape(rec.run_dir)}`);
  if (rec.note !== undefined) lines.push(`note = ${tomlEscape(rec.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  lines.push("", "[calib_chain.calibration]");
  lines.push(`source = ${tomlEscape(rec.calibration.source)}`);
  lines.push(`pulse_hash = ${tomlEscape(rec.calibration.pulse_hash)}`);
  lines.push(`mismatch = ${tomlEscape(rec.calibration.mismatch)}`);
  lines.push("", "[calib_chain.pinned_globals]");
  lines.push(...Object.entries(rec.pinned_globals).map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`));
  if (rec.rebank !== undefined) {
    lines.push("", "[calib_chain.rebank]");
    lines.push(`catalog_entry = ${tomlEscape(rec.rebank.catalog_entry)}`);
    lines.push("", "[calib_chain.rebank.provenance]");
    lines.push(`warm_start = ${tomlEscape(rec.rebank.provenance.warm_start)}`);
    lines.push(`calibration_ref = ${tomlEscape(rec.rebank.provenance.calibration_ref)}`);
    lines.push("", "[calib_chain.rebank.provenance.pinned_globals]");
    lines.push(
      ...Object.entries(rec.rebank.provenance.pinned_globals).map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`),
    );
  }
  return lines.join("\n") + "\n";
}

/** Platforms with built-in affordances (Hamiltonian LaTeX, defaults). NOT a
 *  closed validation set anymore (spec A opened `platform` to any string) — this
 *  is the hint list for tool descriptions. PLATFORMS kept as an alias for the
 *  existing amicode_tools.ts import. */
export const KNOWN_PLATFORMS = ["transmon", "rydberg"] as const;
export const PLATFORMS = KNOWN_PLATFORMS;
export const MIN_LEVELS = 2;
/** Soft cap: >MAX_LEVELS is a tool-side warning, no longer a validation error. */
export const MAX_LEVELS = 6;

// --- validation --------------------------------------------------------------

/** Problems with a SystemEntity; [] means valid. Opened model (spec A): any
 *  non-empty platform string; levels optional and, when given, an integer
 *  >= MIN_LEVELS (no upper bound — the >6 case is a warning surfaced by the
 *  tool, not a validation error). */
export function validateSystem(e: SystemEntity): string[] {
  const problems: string[] = [];
  if (typeof e.platform !== "string" || e.platform.trim() === "") {
    problems.push(`platform must be a non-empty string`);
  }
  if (e.levels !== undefined && (!Number.isInteger(e.levels) || e.levels < MIN_LEVELS)) {
    problems.push(`levels, when given, must be an integer >= ${MIN_LEVELS}, got ${e.levels}`);
  }
  for (const [k, v] of Object.entries(e.params ?? {})) {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      problems.push(`param "${k}" must be a finite number, got ${v}`);
    }
  }
  return problems;
}

/** Problems with a FormulationEntity; [] means valid. */
export function validateFormulation(e: FormulationEntity): string[] {
  const problems: string[] = [];
  if (!TRAJECTORY_TYPES.includes(e.trajectory_type)) problems.push(`trajectory_type must be one of ${TRAJECTORY_TYPES.join(", ")}`);
  if (!TIME_MODES.includes(e.time_mode)) problems.push(`time_mode must be one of ${TIME_MODES.join(", ")}`);
  if (!PARAMETERIZATIONS.includes(e.parameterization)) problems.push(`parameterization must be one of ${PARAMETERIZATIONS.join(", ")}`);
  if (!e.robustness || !ROBUSTNESS_KINDS.includes(e.robustness.kind)) problems.push(`robustness.kind must be one of ${ROBUSTNESS_KINDS.join(", ")}`);
  if (typeof e.free_phase !== "boolean") problems.push("free_phase must be a boolean");
  if (typeof e.leakage !== "boolean") problems.push("leakage must be a boolean");
  if (typeof e.target !== "string") problems.push("target must be a string");
  if (!Array.isArray(e.objectives)) problems.push("objectives must be an array");
  else e.objectives.forEach((o, i) => { if (!OBJECTIVE_KINDS.includes(o.kind)) problems.push(`objectives[${i}].kind invalid: ${o.kind}`); });
  if (!Array.isArray(e.constraints)) problems.push("constraints must be an array");
  else e.constraints.forEach((c, i) => { if (!CONSTRAINT_KINDS.includes(c.kind)) problems.push(`constraints[${i}].kind invalid: ${c.kind}`); });
  return problems;
}

/** Soft, non-blocking warnings (spec §3.2). `componentCount` (N, from the
 *  sibling System entity) is optional; the free_phase-on-N=1 warning fires only
 *  when it is exactly 1, and is skipped when componentCount is undefined. */
export function formulationWarnings(e: FormulationEntity, componentCount?: number): string[] {
  const warnings: string[] = [];
  if (e.trajectory_type === "density" || e.trajectory_type === "multidensity")
    warnings.push("density trajectory — the System should be an open quantum system (dissipators)");
  if (e.time_mode === "min_time") {
    if (!e.time_params || typeof e.time_params.final_fidelity !== "number")
      warnings.push("min_time without a time_params.final_fidelity floor");
    if (!Array.isArray(e.constraints) || !e.constraints.some((c) => c.kind === "dt_bounds"))
      warnings.push("min_time needs free Δt — add a dt_bounds constraint");
  }
  if (e.free_phase && componentCount === 1)
    warnings.push("free_phase on a single-component system has no virtual-Z freedom");
  return warnings;
}

// --- merge (amicode_set_model) ------------------------------------------------

export interface SystemPatch {
  levels?: number;
  params?: Record<string, number>;
}

/** Merge a set_model patch into an existing SystemEntity (pure — returns a new
 *  object; the input is never mutated). Throws if the RESULT is invalid, so a
 *  bad patch can never corrupt a previously-valid recorded entity. */
export function updateSystem(existing: SystemEntity, patch: SystemPatch): SystemEntity {
  const merged: SystemEntity = {
    platform: existing.platform,
    levels: patch.levels ?? existing.levels,
    params: { ...existing.params, ...(patch.params ?? {}) },
  };
  if (existing.notes !== undefined) merged.notes = existing.notes;
  const problems = validateSystem(merged);
  if (problems.length) throw new Error(`invalid system after merge: ${problems.join("; ")}`);
  return merged;
}

// --- composite system (spec-20260709-023819) ---------------------------------
// The System entity becomes a COMPOSITE: components[] + couplings[] + topology +
// drive-arch, with single-qubit the degenerate N=1 case. Introduced alongside the
// flat SystemEntity above; normalizeSystem (below) migrates a flat on-disk entity
// to a composite on read. `Role`/`CouplingKind`/`Topology`/`DriveArch` are CLOSED
// validated sets; `platform` stays OPEN (any non-empty string), as the flat entity
// always was (spec §2.1).

/** `other` is the honest escape: a subsystem on a platform we have no structural
 *  model for. It exists so `platformDefaultRole` never has to FABRICATE a role
 *  from an unrecognized platform string — that fabrication is what put the
 *  transmon Hamiltonian (and its anharmonicity row) on an exchange-only spin
 *  qubit, because every consumer read the defaulted "qubit" as a statement. */
export const ROLES = ["qubit", "cavity", "resonator", "mode", "atom", "other"] as const;
export type Role = (typeof ROLES)[number];

export const COUPLING_KINDS = ["exchange", "ZZ", "cross-resonance", "dispersive-chi", "vdW", "mode-mediated"] as const;
export type CouplingKind = (typeof COUPLING_KINDS)[number];

/** v1 presets only; ring/grid/star/all-to-all are deferred (spec §9). */
export const TOPOLOGIES = ["single-pair", "linear-chain", "custom"] as const;
export type Topology = (typeof TOPOLOGIES)[number];

export const DRIVE_ARCHS = ["global", "per-component", "zoned"] as const;
export type DriveArch = (typeof DRIVE_ARCHS)[number];

export interface Component {
  id: string;
  role: Role;
  /** Optional, per-component; when given an integer >= MIN_LEVELS. Absent = "levels TBD". */
  levels?: number;
  params: Record<string, number>;
}

export interface Coupling {
  /** >=2 component ids. Pairwise = 2 ids; a mode-mediated hyperedge lists the
   *  coupled components PLUS the shared mode's OWN component id. */
  between: string[];
  kind: CouplingKind;
  params: Record<string, number>;
}

export const TERM_KINDS = ["drift", "coupling", "drive"] as const;
export type TermKind = (typeof TERM_KINDS)[number];

/** One term of an EXPLICITLY RECORDED Hamiltonian. The card used to re-derive
 *  the Hamiltonian from (role, levels, platform) with hardcoded tables, so it
 *  could only ever be right for platforms someone had hardcoded — and was
 *  silently wrong for the rest. The agent already understands the model well
 *  enough to author the Julia solve; this is where that understanding gets
 *  written down instead of evaporating into the script. */
export interface HamiltonianTerm {
  kind: TermKind;
  /** KaTeX-renderable LaTeX for this term alone, with no leading `+`. */
  latex: string;
  /** Component ids the term acts on; omitted/[] = the whole system. */
  acts_on?: string[];
  /** Short human label ("Rydberg detuning", "vdW blockade"). */
  label?: string;
}

export interface RecordedHamiltonian {
  terms: HamiltonianTerm[];
  /** Conventions the terms assume — frame, units, basis ordering. Free text. */
  notes?: string;
}

export interface CompositeSystem {
  /** Open platform string (spec A), same rule as the flat entity. */
  platform: string;
  components: Component[];
  couplings: Coupling[];
  /** Provenance: which preset generated `couplings` (undefined for hand-authored). */
  topology?: Topology;
  drive: { arch: DriveArch };
  /** Present = the researcher confirmed this model. Absent = the card falls back
   *  to a canonical form for the platform, LABELLED as inferred. */
  hamiltonian?: RecordedHamiltonian;
  /** Free text; excluded from the canonical hash (like the flat entity). */
  notes?: string;
}

/** Roles that carry a bosonic mode (the shared member of a mode-mediated edge). */
const MODE_ROLES = new Set<Role>(["mode", "resonator"]);

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** `{` / `}` balance, ignoring the escaped literals `\{` and `\}`. */
function balancedBraces(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; } // skip the escaped char, whatever it is
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth < 0) return false;
  }
  return depth === 0;
}

/** Problems with a CompositeSystem; [] means valid. Closed sets for
 *  role/kind/topology/drive.arch; platform open; levels optional but >= 2. */
export function validateCompositeSystem(e: CompositeSystem): string[] {
  const problems: string[] = [];
  if (typeof e.platform !== "string" || e.platform.trim() === "") {
    problems.push("platform must be a non-empty string");
  }
  if (!Array.isArray(e.components) || e.components.length < 1) {
    problems.push("components must be a non-empty array");
    return problems; // nothing below is checkable without components
  }
  const ids = new Set<string>();
  for (const c of e.components) {
    if (typeof c.id !== "string" || c.id.trim() === "") problems.push(`component id must be a non-empty string`);
    else if (ids.has(c.id)) problems.push(`duplicate component id "${c.id}"`);
    else ids.add(c.id);
    if (!(ROLES as readonly string[]).includes(c.role)) {
      problems.push(`component "${c.id}" role must be one of ${ROLES.join("|")}, got ${JSON.stringify(c.role)}`);
    }
    if (c.levels !== undefined && (!Number.isInteger(c.levels) || c.levels < MIN_LEVELS)) {
      problems.push(`component "${c.id}" levels, when given, must be an integer >= ${MIN_LEVELS}, got ${c.levels}`);
    }
    for (const [k, v] of Object.entries(c.params ?? {})) {
      if (!isFiniteNumber(v)) problems.push(`component "${c.id}" param "${k}" must be a finite number, got ${v}`);
    }
  }
  if (!Array.isArray(e.couplings)) {
    problems.push("couplings must be an array");
  } else {
    for (const cp of e.couplings) {
      if (!Array.isArray(cp.between) || cp.between.length < 2) {
        problems.push(`coupling.between must list >= 2 component ids`);
        continue;
      }
      for (const id of cp.between) {
        if (!ids.has(id)) problems.push(`coupling references unknown component id "${id}"`);
      }
      if (!(COUPLING_KINDS as readonly string[]).includes(cp.kind)) {
        problems.push(`coupling.kind must be one of ${COUPLING_KINDS.join("|")}, got ${JSON.stringify(cp.kind)}`);
      }
      if (cp.kind === "mode-mediated") {
        const modeMembers = cp.between.filter((id) => {
          const comp = e.components.find((c) => c.id === id);
          return comp !== undefined && MODE_ROLES.has(comp.role);
        });
        if (modeMembers.length !== 1) {
          problems.push(
            `mode-mediated coupling must include exactly one component of role mode|resonator, found ${modeMembers.length}`,
          );
        }
      }
      for (const [k, v] of Object.entries(cp.params ?? {})) {
        if (!isFiniteNumber(v)) problems.push(`coupling param "${k}" must be a finite number, got ${v}`);
      }
    }
  }
  if (e.topology !== undefined && !(TOPOLOGIES as readonly string[]).includes(e.topology)) {
    problems.push(`topology must be one of ${TOPOLOGIES.join("|")}, got ${JSON.stringify(e.topology)}`);
  }
  if (e.hamiltonian !== undefined) {
    const h = e.hamiltonian;
    if (!Array.isArray(h.terms) || h.terms.length === 0) {
      problems.push("hamiltonian.terms must be a non-empty array");
    } else {
      h.terms.forEach((t, i) => {
        if (!(TERM_KINDS as readonly string[]).includes(t?.kind)) {
          problems.push(`hamiltonian.terms[${i}].kind must be one of ${TERM_KINDS.join("|")}, got ${JSON.stringify(t?.kind)}`);
        }
        if (typeof t?.latex !== "string" || t.latex.trim() === "") {
          problems.push(`hamiltonian.terms[${i}].latex must be a non-empty string`);
        } else if (!balancedBraces(t.latex)) {
          // The card renders this straight into KaTeX. We can't parse LaTeX here
          // (the plugin stays dependency-free), but unbalanced braces are the
          // one slip common enough — and cheap enough — to reject at the door.
          problems.push(`hamiltonian.terms[${i}].latex has unbalanced braces: ${JSON.stringify(t.latex)}`);
        }
        for (const id of t?.acts_on ?? []) {
          if (!ids.has(id)) problems.push(`hamiltonian.terms[${i}] acts_on unknown component id "${id}"`);
        }
      });
    }
  }
  if (!e.drive || !(DRIVE_ARCHS as readonly string[]).includes(e.drive.arch)) {
    problems.push(`drive.arch must be one of ${DRIVE_ARCHS.join("|")}, got ${JSON.stringify(e.drive?.arch)}`);
  }
  return problems;
}

/** Soft per-role level guidance (NOT validation errors) — mirrors the flat
 *  entity's MAX_LEVELS soft-cap posture (spec §2.2). */
const ROLE_LEVEL_HINTS: Partial<Record<Role, { min?: number; max?: number; note: string }>> = {
  qubit: { max: 5, note: "many levels for a qubit — worsens conditioning/leakage/cost" },
  atom: { max: 5, note: "many levels for an atom — worsens conditioning/leakage/cost" },
  cavity: { min: 4, note: "low Fock truncation for a cavity — may under-resolve the mode" },
  resonator: { min: 4, note: "low Fock truncation for a resonator — may under-resolve the mode" },
  mode: { min: 4, note: "low Fock truncation for a mode — may under-resolve the mode" },
};

/** Soft warnings for a (valid) composite — never a rejection. */
export function compositeSystemWarnings(e: CompositeSystem): string[] {
  const warnings: string[] = [];
  for (const c of e.components ?? []) {
    if (c.levels === undefined) continue;
    const hint = ROLE_LEVEL_HINTS[c.role];
    if (!hint) continue;
    if ((hint.max !== undefined && c.levels > hint.max) || (hint.min !== undefined && c.levels < hint.min)) {
      warnings.push(`component "${c.id}" (${c.role}, ${c.levels} levels): ${hint.note}`);
    }
  }
  return warnings;
}

// --- migration + merge (spec §6, §2.3) ---------------------------------------

/** Platform → default component role (spec §2.1 table). Only platforms we
 *  actually model get a role inferred from the string; anything else is `other`
 *  until the MODEL stage asks. Guessing "qubit" here was wrong for photonic
 *  (a mode) and bosonic (a mode) and told every downstream consumer that an
 *  unexamined platform was a transmon-shaped qubit. */
const PLATFORM_ROLE: Record<string, Role> = {
  rydberg: "atom",
  transmon: "qubit",
  bosonic: "mode",
};
export function platformDefaultRole(platform: string): Role {
  return PLATFORM_ROLE[platform.toLowerCase()] ?? "other";
}

/** Platform → default drive arch (spec §2.1 table). rydberg/ion → global; else per-component. */
export function platformDefaultArch(platform: string): DriveArch {
  const p = platform.toLowerCase();
  return p === "rydberg" || p === "ion" ? "global" : "per-component";
}

/** Read-shim (spec §6): a flat on-disk `{platform, levels, params, notes}` becomes an N=1
 *  composite; an already-composite value passes through (idempotent), filling a default
 *  `drive` if absent. Pure; tolerant of raw JSON (never throws). This is the sole flat→composite
 *  path — the plugin invokes it at every read site (amicode_tools.ts). */
export function normalizeSystem(raw: unknown): CompositeSystem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const platform = typeof r.platform === "string" ? r.platform : "";
  if (Array.isArray(r.components)) {
    const rawDrive = r.drive as { arch?: unknown } | undefined;
    const drive =
      rawDrive && typeof rawDrive.arch === "string"
        ? { arch: rawDrive.arch as DriveArch }
        : { arch: platformDefaultArch(platform) };
    const out: CompositeSystem = {
      platform,
      components: r.components as Component[],
      couplings: Array.isArray(r.couplings) ? (r.couplings as Coupling[]) : [],
      drive,
    };
    if (typeof r.topology === "string") out.topology = r.topology as Topology;
    if (r.hamiltonian && typeof r.hamiltonian === "object") out.hamiltonian = r.hamiltonian as RecordedHamiltonian;
    if (typeof r.notes === "string") out.notes = r.notes;
    return out;
  }
  // flat → N=1 composite
  const comp: Component = {
    id: "q1",
    role: platformDefaultRole(platform),
    params: (r.params as Record<string, number>) ?? {},
  };
  if (typeof r.levels === "number") comp.levels = r.levels;
  const out: CompositeSystem = { platform, components: [comp], couplings: [], drive: { arch: platformDefaultArch(platform) } };
  if (typeof r.notes === "string") out.notes = r.notes;
  return out;
}

export interface CompositeSystemPatch {
  /** Upserted by `id` (existing component of that id is field-merged; else appended). */
  components?: Component[];
  /** Replaces the coupling set wholesale (edges are a set, not field-merged). */
  couplings?: Coupling[];
  topology?: Topology;
  drive?: { arch: DriveArch };
  /** Replaces the recorded Hamiltonian wholesale — a partial term list would be
   *  a partial Hamiltonian, which is worse than none. */
  hamiltonian?: RecordedHamiltonian;
  notes?: string;
}

/** Merge a composite patch into an existing System (pure; input never mutated). F1: `existing`
 *  is `normalizeSystem`d first, so a legacy FLAT on-disk entity merges cleanly with a composite
 *  patch. Throws if the RESULT is invalid (a bad patch can't corrupt a valid recorded entity). */
export function updateCompositeSystem(existing: unknown, patch: CompositeSystemPatch): CompositeSystem {
  const base = normalizeSystem(existing);
  const components = base.components.map((c) => ({ ...c }));
  for (const pc of patch.components ?? []) {
    const i = components.findIndex((c) => c.id === pc.id);
    if (i >= 0) components[i] = { ...components[i], ...pc, params: { ...components[i].params, ...(pc.params ?? {}) } };
    else components.push(pc);
  }
  const merged: CompositeSystem = {
    platform: base.platform,
    components,
    couplings: patch.couplings ?? base.couplings,
    drive: patch.drive ?? base.drive,
  };
  const topology = patch.topology ?? base.topology;
  if (topology !== undefined) merged.topology = topology;
  const hamiltonian = patch.hamiltonian ?? base.hamiltonian;
  if (hamiltonian !== undefined) merged.hamiltonian = hamiltonian;
  const notes = patch.notes ?? base.notes;
  if (notes !== undefined) merged.notes = notes;
  const problems = validateCompositeSystem(merged);
  if (problems.length) throw new Error(`invalid composite system after merge: ${problems.join("; ")}`);
  return merged;
}

/** Serialize a CompositeSystem: [system] platform/topology/notes/recorded + [system.drive] +
 *  [[system.components]] (params as an inline table) + [[system.couplings]]. Throws on invalid.
 *  (tomlEscape/tomlKey/tomlNumber/isoNow are hoisted function declarations below.) */
export function compositeSystemToml(e: CompositeSystem, now?: Date): string {
  const problems = validateCompositeSystem(e);
  if (problems.length) throw new Error(`invalid composite system: ${problems.join("; ")}`);
  const inlineParams = (p: Record<string, number>): string => {
    const entries = Object.entries(p);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`).join(", ")} }`;
  };
  const lines: string[] = ["[system]", `platform = ${tomlEscape(e.platform)}`];
  if (e.topology !== undefined) lines.push(`topology = ${tomlEscape(e.topology)}`);
  if (e.notes !== undefined) lines.push(`notes = ${tomlEscape(e.notes)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  lines.push("", "[system.drive]", `arch = ${tomlEscape(e.drive.arch)}`);
  for (const c of e.components) {
    lines.push("", "[[system.components]]", `id = ${tomlEscape(c.id)}`, `role = ${tomlEscape(c.role)}`);
    if (c.levels !== undefined) lines.push(`levels = ${c.levels}`);
    lines.push(`params = ${inlineParams(c.params)}`);
  }
  for (const cp of e.couplings) {
    lines.push(
      "",
      "[[system.couplings]]",
      `between = [${cp.between.map(tomlEscape).join(", ")}]`,
      `kind = ${tomlEscape(cp.kind)}`,
      `params = ${inlineParams(cp.params)}`,
    );
  }
  if (e.hamiltonian) {
    if (e.hamiltonian.notes !== undefined) {
      lines.push("", "[system.hamiltonian]", `notes = ${tomlEscape(e.hamiltonian.notes)}`);
    }
    for (const t of e.hamiltonian.terms) {
      lines.push("", "[[system.hamiltonian.terms]]", `kind = ${tomlEscape(t.kind)}`, `latex = ${tomlEscape(t.latex)}`);
      if (t.acts_on !== undefined) lines.push(`acts_on = [${t.acts_on.map(tomlEscape).join(", ")}]`);
      if (t.label !== undefined) lines.push(`label = ${tomlEscape(t.label)}`);
    }
  }
  return lines.join("\n") + "\n";
}

// --- topology + replicate (spec §2.3, §4.2) ----------------------------------

/** Expand a v1 topology preset into explicit edges over `componentIds` (canonical order),
 *  each stamped with `kind` + shared `params`. `custom` returns [] (edges authored directly).
 *  ring/grid/star/all-to-all are deferred (spec §9) and throw. Bad arity throws. */
export function expandTopology(
  topology: Topology,
  componentIds: string[],
  kind: CouplingKind,
  params: Record<string, number> = {},
): Coupling[] {
  switch (topology) {
    case "custom":
      return [];
    case "single-pair":
      if (componentIds.length !== 2) {
        throw new Error(`single-pair topology needs exactly 2 components, got ${componentIds.length}`);
      }
      return [{ between: [componentIds[0], componentIds[1]], kind, params: { ...params } }];
    case "linear-chain": {
      if (componentIds.length < 2) {
        throw new Error(`linear-chain topology needs >= 2 components, got ${componentIds.length}`);
      }
      const edges: Coupling[] = [];
      for (let i = 0; i + 1 < componentIds.length; i++) {
        edges.push({ between: [componentIds[i], componentIds[i + 1]], kind, params: { ...params } });
      }
      return edges;
    }
    default:
      throw new Error(`topology "${topology}" is deferred (spec §9); v1 supports single-pair|linear-chain|custom`);
  }
}

/** Replicate a homogeneous component template into N components identical except `id`
 *  (`${prefix}1..${prefix}N`) — so couplings/topology can reference them (spec §4.2). */
export function replicateHomogeneous(
  template: Omit<Component, "id">,
  n: number,
  prefix = "q",
): Component[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`replicateHomogeneous needs n >= 1, got ${n}`);
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    role: template.role,
    ...(template.levels !== undefined ? { levels: template.levels } : {}),
    params: { ...template.params },
  }));
}

// --- TOML emission -------------------------------------------------------------

/** Escape a string for a TOML basic (double-quoted) string. */
function tomlEscape(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0");
    else out += ch;
  }
  return `"${out}"`;
}

/** A TOML key: bare when safe, basic-quoted otherwise. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlEscape(k);
}

/** Finite-number TOML literal (validators guarantee finiteness before this). */
function tomlNumber(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`param value ${v} has no TOML representation`);
  return String(v);
}

function isoNow(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

/** Serialize a SystemEntity:
 *  [system] platform/levels/recorded + [system.params] name = value. Throws on
 *  an invalid entity. `now` is injectable for deterministic tests. */
export function systemToml(e: SystemEntity, now?: Date): string {
  const problems = validateSystem(e);
  if (problems.length) throw new Error(`invalid system: ${problems.join("; ")}`);
  const lines = ["[system]", `platform = ${tomlEscape(e.platform)}`];
  if (e.levels !== undefined) lines.push(`levels = ${e.levels}`);
  if (e.notes !== undefined) lines.push(`notes = ${tomlEscape(e.notes)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`, "", "[system.params]");
  lines.push(...Object.entries(e.params).map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`));
  return lines.join("\n") + "\n";
}

/** Serialize a FormulationEntity under [formulation]. Throws on invalid. */
export function formulationToml(e: FormulationEntity, now?: Date): string {
  const problems = validateFormulation(e);
  if (problems.length) throw new Error(`invalid formulation: ${problems.join("; ")}`);
  const inlineNum = (p: Record<string, number>): string => {
    const entries = Object.entries(p);
    return entries.length === 0 ? "{}" : `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${tomlNumber(v)}`).join(", ")} }`;
  };
  const inlineMixed = (p: Record<string, number | string>): string => {
    const entries = Object.entries(p);
    return entries.length === 0
      ? "{}"
      : `{ ${entries.map(([k, v]) => `${tomlKey(k)} = ${typeof v === "number" ? tomlNumber(v) : tomlEscape(v)}`).join(", ")} }`;
  };
  const lines: string[] = [
    "[formulation]",
    `trajectory_type = ${tomlEscape(e.trajectory_type)}`,
    `time_mode = ${tomlEscape(e.time_mode)}`,
    `parameterization = ${tomlEscape(e.parameterization)}`,
    `free_phase = ${e.free_phase}`,
    `leakage = ${e.leakage}`,
    `target = ${tomlEscape(e.target)}`,
    `robustness = { kind = ${tomlEscape(e.robustness.kind)}, params = ${inlineMixed(e.robustness.params)} }`,
  ];
  if (e.time_params !== undefined) lines.push(`time_params = ${inlineNum(e.time_params)}`);
  if (e.leakage_params !== undefined) lines.push(`leakage_params = ${inlineNum(e.leakage_params)}`);
  if (e.notes !== undefined) lines.push(`notes = ${tomlEscape(e.notes)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  // Array-of-tables + [formulation.solve] MUST follow all [formulation] scalar
  // keys (TOML: no scalar key may be added after a sub-table opens).
  for (const o of e.objectives) {
    lines.push("", "[[formulation.objectives]]", `kind = ${tomlEscape(o.kind)}`);
    if (o.label !== undefined) lines.push(`label = ${tomlEscape(o.label)}`);
    lines.push(`params = ${inlineNum(o.params)}`);
  }
  for (const c of e.constraints) {
    lines.push("", "[[formulation.constraints]]", `kind = ${tomlEscape(c.kind)}`);
    if (c.label !== undefined) lines.push(`label = ${tomlEscape(c.label)}`);
    lines.push(`params = ${inlineNum(c.params)}`);
  }
  // [formulation.solve] sub-table (spec A) — MUST follow all [formulation]
  // scalar keys (TOML: no keys added to a table after a sub-table opens).
  if (e.solve) {
    const s = e.solve;
    lines.push("", "[formulation.solve]");
    if (s.T !== undefined) lines.push(`T = ${tomlNumber(s.T)}`);
    if (s.N !== undefined) lines.push(`N = ${tomlNumber(s.N)}`);
    if (s.max_iter !== undefined) lines.push(`max_iter = ${tomlNumber(s.max_iter)}`);
    if (s.integrator !== undefined) lines.push(`integrator = ${tomlEscape(s.integrator)}`);
    if (s.parameterization !== undefined) lines.push(`parameterization = ${tomlEscape(s.parameterization)}`);
    if (s.pinned_globals !== undefined) {
      lines.push(`pinned_globals = [${s.pinned_globals.map(tomlEscape).join(", ")}]`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Serialize the Run bookkeeping stub under [run]. `launched_via` is fixed to
 *  "bash amico-run": the amicode_solve tool records intent only — the actual
 *  launch is the AGENTS.md bash workflow, never this tool. Optional refs are
 *  omitted (not written as "") when absent. */
export function runStubToml(stub: RunStub, now?: Date): string {
  const lines = ["[run]"];
  if (stub.formulation_ref !== undefined) lines.push(`formulation_ref = ${tomlEscape(stub.formulation_ref)}`);
  if (stub.system_ref !== undefined) lines.push(`system_ref = ${tomlEscape(stub.system_ref)}`);
  if (stub.run_dir !== undefined) lines.push(`run_dir = ${tomlEscape(stub.run_dir)}`);
  if (stub.tier !== undefined) lines.push(`tier = ${tomlEscape(stub.tier)}`);
  if (stub.script_ref !== undefined) lines.push(`script_ref = ${tomlEscape(stub.script_ref)}`);
  if (stub.env !== undefined) lines.push(`env = ${tomlEscape(stub.env)}`);
  if (stub.warm_start !== undefined) lines.push(`warm_start = ${tomlEscape(stub.warm_start)}`);
  lines.push(`launched_via = ${tomlEscape("bash amico-run")}`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  if (stub.verification !== undefined) {
    lines.push("", "[run.verification]", `agree = ${stub.verification.agree}`);
    if (stub.verification.fidelity_rerolled != null)
      lines.push(`fidelity_rerolled = ${stub.verification.fidelity_rerolled}`);
    if (stub.verification.fidelity_reported != null)
      lines.push(`fidelity_reported = ${stub.verification.fidelity_reported}`);
  }
  return lines.join("\n") + "\n";
}

// --- problem workspace serializers (spec A) ----------------------------------

/** Serialize ProblemMeta under [problem] (+ [problem.score]/[problem.env]).
 *  `recorded` defaults to now when absent. */
export function problemToml(meta: ProblemMeta, now?: Date): string {
  const lines = [
    "[problem]",
    `name = ${tomlEscape(meta.name)}`,
    `slug = ${tomlEscape(meta.slug)}`,
    `created = ${tomlEscape(meta.created)}`,
    `status = ${tomlEscape(meta.status)}`,
    `recorded = ${tomlEscape(meta.recorded ?? isoNow(now))}`,
  ];
  if (meta.score) {
    lines.push("", "[problem.score]", `id = ${tomlEscape(meta.score.id)}`, `version = ${meta.score.version}`);
  }
  if (meta.env) {
    lines.push("", "[problem.env]", `kind = ${tomlEscape(meta.env.kind)}`);
    if (meta.env.path !== undefined) lines.push(`path = ${tomlEscape(meta.env.path)}`);
  }
  return lines.join("\n") + "\n";
}

/** Serialize an array of RunRefs as [[runs]] array-of-tables. */
export function runRefsToml(refs: RunRef[]): string {
  const blocks = refs.map((r) => {
    const lines = ["[[runs]]", `run_id = ${tomlEscape(r.run_id)}`, `lab = ${tomlEscape(r.lab)}`];
    if (r.tier !== undefined) lines.push(`tier = ${tomlEscape(r.tier)}`);
    lines.push(`recorded = ${tomlEscape(r.recorded)}`);
    return lines.join("\n");
  });
  return blocks.length ? blocks.join("\n\n") + "\n" : "";
}

/** JSON sidecars — the machine-read source (the plugin is TOML-writer-only, so
 *  all reads/merges go through these). */
export function problemJson(meta: ProblemMeta): string {
  return JSON.stringify(meta, null, 2) + "\n";
}

export function runRefsJson(refs: RunRef[]): string {
  return JSON.stringify({ runs: refs }, null, 2) + "\n";
}

// --- canonical serialization + diffs (spec A / amicode#64) -------------------

/** Keys excluded from the canonical hash input: `recorded` (clock ticks) and
 *  `notes` (prose) must not churn entity identity. The #64 coordination seam —
 *  number normalization is JSON.stringify's default for v1 (revisit with #64). */
const HASH_EXCLUDED_KEYS = new Set(["recorded", "notes"]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (HASH_EXCLUDED_KEYS.has(key)) continue;
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = canonicalize(v);
  }
  return out;
}

/** Canonical JSON: recursively key-sorted, `recorded`/`notes` and undefined
 *  dropped at every level. The hash input for hashes.ts (spec A / #64). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Kebab-case slug from a problem name; empty result → "untitled". */
export function deriveSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

/** Flatten one level of nested objects to dotted keys (`params.drive_max`),
 *  dropping `recorded`. Arrays are treated as scalar values. */
function flattenForDiff(e: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!e) return out;
  for (const [k, v] of Object.entries(e)) {
    if (k === "recorded") continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) out[`${k}.${sk}`] = sv;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Structured diff of two entity snapshots → { dottedKey: {from, to} } for
 *  changed keys only. `before === undefined` (create) → every `from` is null. */
export function entityDiff(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, { from: unknown; to: unknown }> {
  const b = flattenForDiff(before);
  const a = flattenForDiff(after);
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const fromV = k in b ? b[k] : null;
    const toV = k in a ? a[k] : null;
    if (JSON.stringify(fromV) !== JSON.stringify(toV)) {
      diff[k] = { from: before === undefined ? null : fromV, to: toV };
    }
  }
  return diff;
}

/** Keep the AMICODE_DIFF sentinel line small: truncate long string values, then,
 *  if still over budget, drop trailing entries and mark with an "…" key. */
export function truncateDiffForSentinel(
  diff: Record<string, { from: unknown; to: unknown }>,
  maxBytes = 1024,
): Record<string, { from: unknown; to: unknown }> {
  const trunc = (v: unknown): unknown => (typeof v === "string" && v.length > 120 ? v.slice(0, 120) + "…" : v);
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, { from, to }] of Object.entries(diff)) out[k] = { from: trunc(from), to: trunc(to) };
  const keys = Object.keys(out);
  const total = keys.length;
  while (JSON.stringify(out).length > maxBytes && keys.length > 0) {
    delete out[keys.pop()!];
    out["…"] = { from: null, to: `${total - keys.length} more fields` };
  }
  return out;
}

/** A given-but-empty ref is a caller bug (an ABSENT ref is fine — omit the key). */
function requireNonEmptyRef(name: string, value: string | undefined): void {
  if (value !== undefined && value.trim() === "") {
    throw new Error(`${name} must be non-empty when given — omit it (null) if unknown`);
  }
}

/** The stage-8 send-to-device gate's automated checks — fixed, not caller data:
 *  they describe what the gate WILL verify, not what happened (nothing happens
 *  in this build). Human visual sign-off follows the auto checks. */
const HARDWARE_CHECKS = ["fidelity>=threshold", "|drive|<=cap", "bandwidth", "leakage"] as const;

/** Serialize the DeviceSession stub under [device_session]. `gate` is pinned to
 *  "pending-human-sign-off" and `checks` to HARDWARE_CHECKS (see interface note).
 *  A rehearsal record lands under [device_session.rehearsal] with `sim = true`
 *  PINNED by this serializer (the record type has no sim field to lie with). */
export function deviceSessionStubToml(stub: DeviceSessionStub, now?: Date): string {
  requireNonEmptyRef("pulse_ref", stub.pulse_ref);
  requireNonEmptyRef("run_dir", stub.run_dir);
  if (stub.rehearsal !== undefined && validateRehearsalRecord(stub.rehearsal).length > 0) {
    throw new Error(
      `invalid rehearsal record: ${validateRehearsalRecord(stub.rehearsal).join("; ")}`,
    );
  }
  const lines = ["[device_session]"];
  if (stub.pulse_ref !== undefined) lines.push(`pulse_ref = ${tomlEscape(stub.pulse_ref)}`);
  if (stub.run_dir !== undefined) lines.push(`run_dir = ${tomlEscape(stub.run_dir)}`);
  lines.push(`gate = ${tomlEscape("pending-human-signoff")}`);
  lines.push(`checks = [${HARDWARE_CHECKS.map(tomlEscape).join(", ")}]`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  if (stub.rehearsal !== undefined) {
    const reh = stub.rehearsal;
    lines.push("");
    lines.push("[device_session.rehearsal]");
    lines.push(`kind = ${tomlEscape(reh.kind)}`);
    lines.push("sim = true"); // PINNED, bare TOML boolean — sim is part of the trust chain
    lines.push(`outcome = ${tomlEscape(reh.outcome)}`);
    lines.push(`pulse_hash = ${tomlEscape(reh.pulse_hash)}`);
    lines.push(`mismatch = ${tomlEscape(reh.mismatch)}`);
    if (reh.step_outcome !== undefined) lines.push(`step_outcome = ${tomlEscape(reh.step_outcome)}`);
    if (reh.error !== undefined) lines.push(`error = ${tomlEscape(reh.error)}`);
    if (reh.recorded !== undefined) lines.push(`recorded = ${tomlEscape(reh.recorded)}`);
  }
  return lines.join("\n") + "\n";
}

/** Serialize the Calibration stub under [calibration]. `loop` is pinned to "ILC"
 *  (iterative learning control — the loop that follows hardware runs) and
 *  `status` to "not-wired": this build records the follow-up, nothing more. */
export function calibrationStubToml(stub: CalibrationStub, now?: Date): string {
  requireNonEmptyRef("device_session_ref", stub.device_session_ref);
  const lines = ["[calibration]"];
  if (stub.device_session_ref !== undefined) {
    lines.push(`device_session_ref = ${tomlEscape(stub.device_session_ref)}`);
  }
  lines.push(`loop = ${tomlEscape("ILC")}`);
  lines.push(`status = ${tomlEscape("not-wired")}`);
  if (stub.note !== undefined) lines.push(`note = ${tomlEscape(stub.note)}`);
  lines.push(`recorded = ${tomlEscape(isoNow(now))}`);
  return lines.join("\n") + "\n";
}

// packages/schema/src/project.ts — deterministic projection
// FormulationEntity + CompositeSystem → ProblemSpec (control branch)
//
// No LLM in the path. Pure function implementing the master spec's
// mapping table (spec-20260717-020639):
//   parameterization → pulse.kind + problem.template
//   min_time → goal_treatment="both" + free_dt + time objective
//   ensemble → sampling wrapper
//   leakage → problem.options
//   custom → not spec-expressible fallback with reason
//   T/N/max_iter/integrator etc. flow through from solve params.
//
// Used by:
//   - amicode_formulate v2 (writes ~/.amico/problems/<slug>/problem.toml)
//   - tests / goldens
// The plugin (amicode_tools.ts) imports this via relative path
//   ../../schema/src/project.js — Bun transpiles TS natively.
//
// The ProblemSpec shape is the vendored FULL variant's `control` branch:
//   { schema_version:1, kind:"control", system, goal?, pulse, problem,
//     trajectory?, integrator?, solver?, wrappers?, ... }
// Validation is external (ajv validate(..., "problemspec") before write).

export type TrajectoryType = "ket" | "multiket" | "gate" | "density" | "multidensity";
export type TimeMode = "fixed" | "min_time";
export type Parameterization = "smooth" | "linear_spline" | "cubic_spline" | "bang_bang";
export type RobustnessKind = "none" | "ensemble" | "sensitivity";

// Minimal structural mirrors of the entity types (do NOT import from
// extension/opencode-plugin/entities.ts to keep @amicode/schema self-contained).
export interface FormulationEntityLike {
  trajectory_type: TrajectoryType;
  time_mode: TimeMode;
  time_params?: Record<string, number>;
  parameterization: Parameterization;
  robustness: { kind: RobustnessKind; params: Record<string, number | string> };
  free_phase: boolean;
  leakage: boolean;
  leakage_params?: Record<string, number>;
  target: string;
  objectives: Array<{ kind: string; params: Record<string, number>; label?: string }>;
  constraints: Array<{ kind: string; params: Record<string, number>; label?: string }>;
  solve?: { T?: number; N?: number; max_iter?: number; integrator?: string; parameterization?: string };
  notes?: string;
}

export interface CompositeSystemLike {
  platform: string;
  components: Array<{ id: string; role: string; levels?: number; params: Record<string, number> }>;
  couplings: Array<{ between: string[]; kind: string; params: Record<string, number> }>;
  topology?: string;
  drive: { arch: string };
  hamiltonian?: unknown;
  notes?: string;
}

export type ProjectionOk = { ok: true; spec: Record<string, unknown>; warnings: string[] };
export type ProjectionErr = { ok: false; reason: string; spec?: undefined };
export type ProjectionResult = ProjectionOk | ProjectionErr;

// ── helpers ────────────────────────────────────────────────────────────────

function systemTemplate(sys: CompositeSystemLike): string {
  const p = sys.platform.toLowerCase();
  const n = sys.components.length;
  const hasCavity = sys.components.some((c) => c.role === "cavity" || c.role === "resonator" || c.role === "mode");
  const hasQubit = sys.components.some((c) => c.role === "qubit" || c.role === "atom");
  if (p === "transmon") return n === 1 ? "TransmonSystem" : "MultiTransmonSystem";
  if (p === "rydberg") return "RydbergChainSystem";
  if (p === "bosonic" || p === "cavity") {
    if (hasQubit && hasCavity) return "TransmonCavitySystem";
    return "CatSystem";
  }
  if (p === "ion" || p === "trapped-ion") return "IonChainSystem";
  // fallback: if cavity present → CatSystem, else single → TransmonSystem, multi → MultiTransmonSystem
  if (hasCavity && !hasQubit) return "CatSystem";
  return n === 1 ? "TransmonSystem" : "MultiTransmonSystem";
}

function pulseAndTemplate(
  p: Parameterization,
): { pulseKind: string; template: string } {
  switch (p) {
    case "smooth":
      return { pulseKind: "zero_order", template: "SmoothPulseProblem" };
    case "bang_bang":
      return { pulseKind: "zero_order", template: "BangBangPulseProblem" };
    case "linear_spline":
      return { pulseKind: "linear_spline", template: "SplinePulseProblem" };
    case "cubic_spline":
      return { pulseKind: "cubic_spline", template: "SplinePulseProblem" };
  }
}

function parseIntegrator(
  raw: string | undefined,
  freePhase: boolean,
): { kind: string; alg: string } {
  const s = (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  let out: { kind: string; alg: string };
  if (s.includes("magnusgl4") || s === "gl4") out = { kind: "exponential", alg: "magnus_gl4" };
  else if (s.includes("magnusadapt4") || s.includes("adapt4")) out = { kind: "spline", alg: "magnus_adapt4" };
  else if (s.includes("tsit5")) out = { kind: "bilinear", alg: "tsit5" };
  else if (s.includes("bilinear")) out = { kind: "bilinear", alg: "tsit5" };
  else if (s.includes("spline")) out = { kind: "spline", alg: "magnus_adapt4" };
  else if (s.includes("exponential")) out = { kind: "exponential", alg: "magnus_gl4" };
  else out = { kind: "bilinear", alg: "tsit5" };
  // free_phase requires exponential|spline (schema if/then) — upgrade bilinear silently
  if (freePhase && out.kind === "bilinear") out = { kind: "spline", alg: "magnus_adapt4" };
  return out;
}

function dtBoundsFromConstraints(constraints: FormulationEntityLike["constraints"]): [number, number] | undefined {
  const c = constraints.find((x) => x.kind === "dt_bounds");
  if (!c) return undefined;
  const p = c.params ?? {};
  // Accept several key spellings; params may carry dt_min/dt_max, lo/hi, lower/upper, min/max
  const lo =
    (p.dt_min as number) ??
    (p.lo as number) ??
    (p.lower as number) ??
    (p.min as number) ??
    (p.dt_lower as number);
  const hi =
    (p.dt_max as number) ??
    (p.hi as number) ??
    (p.upper as number) ??
    (p.max as number) ??
    (p.dt_upper as number);
  if (typeof lo === "number" && typeof hi === "number" && Number.isFinite(lo) && Number.isFinite(hi)) {
    return [lo, hi];
  }
  // If the constraint has no numeric bounds, treat as unspecified (caller defaults)
  return undefined;
}

// ── main projection ──────────────────────────────────────────────────────

export function projectToProblemSpec(
  formulation: FormulationEntityLike,
  system: CompositeSystemLike,
): ProjectionResult {
  const warnings: string[] = [];

  // ── 1. non-spec-expressible fallback checks ──────────────────────────
  // Custom objectives / constraints: no ProblemSpec representation.
  const customObj = formulation.objectives.find((o) => o.kind === "custom");
  if (customObj) {
    return {
      ok: false,
      reason: `custom objective not spec-expressible: ${customObj.label ?? customObj.kind} — falls back to script-tier authoring`,
    };
  }
  const customCon = formulation.constraints.find((c) => c.kind === "custom");
  if (customCon) {
    return {
      ok: false,
      reason: `custom constraint not spec-expressible: ${customCon.label ?? customCon.kind} — falls back to script-tier authoring`,
    };
  }
  // Trajectory types beyond gate/ket are not expressible as control ProblemSpec
  // (the control branch only knows ket|unitary).
  if (
    formulation.trajectory_type === "density" ||
    formulation.trajectory_type === "multidensity" ||
    formulation.trajectory_type === "multiket"
  ) {
    return {
      ok: false,
      reason: `trajectory_type "${formulation.trajectory_type}" not spec-expressible as a control ProblemSpec — falls back to script-tier`,
    };
  }

  // ── 2. system ────────────────────────────────────────────────────────
  const template = systemTemplate(system);
  const sys: Record<string, unknown> = { kind: "template", template };
  // Pass through levels + any numeric global params via system.params.
  // For a single-component system, surface its levels; for multi, keep the map minimal.
  const firstLevels = system.components[0]?.levels;
  if (typeof firstLevels === "number") {
    sys.params = { levels: firstLevels };
  } else if (system.components.length === 1 && Object.keys(system.components[0].params ?? {}).length > 0) {
    // Preserve any numeric params if levels absent — still useful for hashing parity
    const p: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(system.components[0].params)) if (typeof v === "number") p[k] = v;
    if (Object.keys(p).length > 0) sys.params = p;
  }
  // If the system has >1 component, also surface all levels implicitly via goal.subsystem_levels
  // (system.params itself stays single-level for template systems that expect a scalar).

  // ── 3. goal + trajectory ─────────────────────────────────────────────
  let trajectoryKind: string;
  let goalKind: string;
  if (formulation.trajectory_type === "gate") {
    trajectoryKind = "unitary";
    goalKind = "unitary";
  } else {
    // ket (single-state prep) — the only other expressible trajectory
    trajectoryKind = "ket";
    goalKind = "ket";
  }

  const subsystemLevels = system.components.map((c) => (typeof c.levels === "number" ? c.levels : 3));
  const goal: Record<string, unknown> = { kind: goalKind, subsystem_levels: subsystemLevels };
  if (goalKind === "unitary") {
    // Gate name — preserve the target string verbatim (e.g. "CZ", "X", "H")
    goal.gate = formulation.target || "X";
  } else {
    goal.target = formulation.target || "|0>";
  }

  // ── 4. pulse + problem template ──────────────────────────────────────
  const effParam = (formulation.solve?.parameterization as Parameterization | undefined) ?? formulation.parameterization;
  const { pulseKind, template: probTemplate } = pulseAndTemplate(effParam);

  const T = formulation.solve?.T ?? 40;
  const N = formulation.solve?.N ?? 40;

  const pulse: Record<string, unknown> = { kind: pulseKind, T, init: "default", seed: 0 };

  const problem: Record<string, unknown> = { template: probTemplate, N };

  // min_time vs fixed
  if (formulation.time_mode === "min_time") {
    problem.goal_treatment = "both";
    const bounds = dtBoundsFromConstraints(formulation.constraints);
    problem.free_dt = bounds ?? [0.01, 2.0];
    const ff = formulation.time_params?.final_fidelity;
    problem.final_fidelity = typeof ff === "number" ? ff : 0.99;
    // time objective weight D
    const D = formulation.time_params?.D;
    const w = typeof D === "number" ? D : 100;
    // Merge with any regularizer objectives → problem.objectives includes time + regs
    const objs: Array<Record<string, unknown>> = [{ kind: "time", weight: w }];
    for (const o of formulation.objectives) {
      if (o.kind === "reg_u" || o.kind === "reg_du" || o.kind === "reg_ddu" || o.kind === "sensitivity") {
        const weight = (o.params as Record<string, unknown>).weight as number | undefined;
        objs.push({ kind: o.kind === "reg_u" ? "reg_u" : o.kind === "reg_du" ? "reg_du" : o.kind === "reg_ddu" ? "reg_ddu" : "sensitivity", weight: typeof weight === "number" ? weight : 1 });
      }
    }
    problem.objectives = objs;
  } else {
    problem.goal_treatment = "objective";
    problem.free_dt = false;
    // Regularizer weights for fixed-time: surface as direct problem fields
    // where the mapping is unambiguous, plus objectives array carry-through.
    const objs: Array<Record<string, unknown>> = [];
    for (const o of formulation.objectives) {
      if (o.kind === "reg_u") problem.R_u = (o.params as Record<string, unknown>).weight as number ?? (o.params as Record<string, unknown>).value as number ?? 1e-4;
      else if (o.kind === "reg_du") problem.R_du = (o.params as Record<string, unknown>).weight as number ?? 1e-5;
      else if (o.kind === "reg_ddu") problem.R_ddu = (o.params as Record<string, unknown>).weight as number ?? 1e-6;
      else if (o.kind === "sensitivity") objs.push({ kind: "sensitivity", weight: (o.params as Record<string, unknown>).weight as number ?? 1 });
    }
    if (objs.length > 0) problem.objectives = objs;
    // Also respect direct Q/R fields if objectives carry them via params.Q etc? Not needed.
  }

  // free_phase
  if (formulation.free_phase) problem.free_phase = true;

  // leakage → problem.options.leakage_constraint
  if (formulation.leakage) {
    const opts: Record<string, unknown> = {};
    const lp = formulation.leakage_params ?? {};
    // Master spec: leakage → options.leakage_constraint (+ value/cost if given)
    opts.leakage_constraint = true;
    if (typeof lp.value === "number") opts.leakage_constraint_value = lp.value;
    if (typeof lp.cost === "number") opts.leakage_cost = lp.cost;
    // Also allow a boolean leakage_constraint_value already
    problem.options = opts;
  }

  // calibration_pin constraint → problem.calibration_targets
  const cal = formulation.constraints.find((c) => c.kind === "calibration_pin");
  if (cal) {
    const names = Object.keys(cal.params ?? {});
    if (names.length > 0) problem.calibration_targets = names;
    else if (cal.label) problem.calibration_targets = [cal.label];
  }

  // Global bounds / du_bound etc. — if constraints include bounds/du_bound/ddu_bound,
  // surface them as direct problem fields where the schema expects them.
  for (const c of formulation.constraints) {
    if (c.kind === "bounds" && c.params) {
      // bounds constraint carries amplitude caps — store as global_bounds
      problem.global_bounds = { ...c.params };
    } else if (c.kind === "du_bound" && typeof (c.params as Record<string, unknown>).value === "number") {
      problem.du_bound = (c.params as Record<string, unknown>).value as number;
    } else if (c.kind === "ddu_bound" && typeof (c.params as Record<string, unknown>).value === "number") {
      problem.ddu_bound = (c.params as Record<string, unknown>).value as number;
    } else if (c.kind === "du_bound" && typeof (c.params as Record<string, unknown>).du_bound === "number") {
      problem.du_bound = (c.params as Record<string, unknown>).du_bound as number;
    }
  }

  // ── 5. integrator + solver ───────────────────────────────────────────
  const integrator = parseIntegrator(formulation.solve?.integrator, formulation.free_phase);
  const maxIter = formulation.solve?.max_iter;
  const solver: Record<string, unknown> = {
    backend: "ipopt",
    device: "cpu",
    precision: "f64",
    max_iter: typeof maxIter === "number" ? maxIter : 500,
    strategy: "direct",
  };

  // ── 6. wrappers (ensemble / sensitivity) ──────────────────────────────
  let wrappers: Array<Record<string, unknown>> | undefined;
  if (formulation.robustness.kind === "ensemble") {
    const variants: unknown[] = [];
    // If robustness.params carries an explicit variants array, use it; else one variant from params.
    const maybeVariants = (formulation.robustness.params as Record<string, unknown>).variants;
    if (Array.isArray(maybeVariants)) variants.push(...(maybeVariants as unknown[]));
    else variants.push({ ...formulation.robustness.params });
    const w: Record<string, unknown> = { kind: "sampling", variants };
    const weights = (formulation.robustness.params as Record<string, unknown>).weights;
    if (Array.isArray(weights)) w.weights = weights;
    wrappers = [w];
  } else if (formulation.robustness.kind === "sensitivity") {
    wrappers = [{ kind: "robust", variants: [{ ...formulation.robustness.params }] }];
  }

  // ── 7. assemble ──────────────────────────────────────────────────────
  const spec: Record<string, unknown> = {
    schema_version: 1,
    kind: "control",
    system: sys,
    goal,
    pulse,
    problem,
    trajectory: { kind: trajectoryKind },
    integrator,
    solver,
  };
  if (wrappers) spec.wrappers = wrappers;

  // Minimal sanity: pulse kind must match template per schema conditionals.
  // This is already enforced by pulseAndTemplate, but warn if someone later edits the map.
  if (probTemplate === "SplinePulseProblem" && pulseKind === "zero_order") {
    warnings.push(`template ${probTemplate} requires cubic_spline|linear_spline pulse, got ${pulseKind}`);
  }
  if ((probTemplate === "SmoothPulseProblem" || probTemplate === "BangBangPulseProblem") && pulseKind !== "zero_order") {
    warnings.push(`template ${probTemplate} requires zero_order pulse, got ${pulseKind}`);
  }

  return { ok: true, spec, warnings };
}

/** Convenience: true when the facet set is spec-expressible (no fallback). */
export function isSpecExpressible(
  formulation: FormulationEntityLike,
  _system: CompositeSystemLike,
): boolean {
  return projectToProblemSpec(formulation, _system).ok;
}

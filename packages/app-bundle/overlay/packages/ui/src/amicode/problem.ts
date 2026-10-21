// AMICODE: receipt post-state chips for the amicode_* transcript receipts.
// The deprecated research surfaces (entity rail, entity views, their /amicode/
// problem + run-status parsers and verdicts) were removed in #1818; what
// remains here is what the LIVE transcript receipts still use: the compact
// post-state chip text a receipt renders on creation/large/elided diffs
// (card.tsx's hero chip) via chipText / compositeChip / formulationProjection.
// Pure, tolerant, never throws; JSX-free so it is directly testable under
// `bun test`.
import { compactValue, formatSci } from "./facets"

// --- shared primitives --------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function shortValue(value: unknown): string {
  return compactValue(value) // spec §4: array/object-aware, never a JSON blob
}

// --- chip text ----------------------------------------------------------------

/** Compact per-kind chip text; undefined when the entity has nothing to show. */
export function chipText(kind: string, entity: Record<string, unknown>): string | undefined {
  if (kind === "system") {
    // composite (spec-20260709): a components[] array → summarize the composite.
    // Defensive in-place parse (this fork repo CANNOT import the plugin-side
    // normalizeSystem — spec §3 cross-repo note); a legacy flat entity falls through.
    if (Array.isArray(entity.components)) return compositeChip(entity)
    const params = (typeof entity.params === "object" && entity.params !== null ? entity.params : {}) as Record<
      string,
      unknown
    >
    const parts = [
      str(entity.platform),
      typeof entity.levels === "number" ? `${entity.levels} lvl` : undefined,
      typeof params.drive_max === "number" ? `cap ${formatSci(params.drive_max)}` : undefined,
    ].filter((p): p is string => Boolean(p))
    return parts.length > 0 ? parts.join(" · ") : undefined
  }
  if (kind === "formulation") {
    // Structured facets via formulationProjection (dual-shape) — NOT the phantom
    // `problem_type` the plugin never writes (spec §6.3 drift fix).
    const p = formulationProjection(entity)
    const parts = [
      p.trajectory_type,
      p.time_mode === "min_time" ? "min-time" : undefined,
      p.robustness.kind !== "none" ? p.robustness.kind : undefined,
      p.free_phase ? "free-phase" : undefined,
    ].filter((x): x is string => Boolean(x))
    return parts.length > 0 ? parts.join(" · ") : undefined
  }
  if (kind === "run") return undefined // a run receipt renders its captured diff, not a chip summary
  // generic: flatten one level of nesting to bare keys, skip null/notes/recorded
  const SKIP = new Set(["notes", "recorded"])
  const entries: string[] = []
  for (const [key, value] of Object.entries(entity)) {
    if (SKIP.has(key) || value === null || value === undefined) continue
    if (typeof value === "object" && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue === null || innerValue === undefined) continue
        entries.push(`${inner}=${shortValue(innerValue)}`)
      }
    } else entries.push(`${key}=${shortValue(value)}`)
  }
  if (entries.length === 0) return undefined
  return entries.length > 4 ? entries.slice(0, 4).join(" · ") + " · …" : entries.join(" · ")
}

/** Compact composite chip, e.g. "transmon · 3 lvl · cap 0.2" (N=1, back-compat look)
 *  or "transmon · 2×qubit · cross-resonance · per-component" (N>1). */
export function compositeChip(entity: Record<string, unknown>): string | undefined {
  const components = Array.isArray(entity.components) ? (entity.components as Record<string, unknown>[]) : []
  const couplings = Array.isArray(entity.couplings) ? (entity.couplings as Record<string, unknown>[]) : []
  const driveArch =
    entity.drive && typeof entity.drive === "object" ? str((entity.drive as Record<string, unknown>).arch) : undefined
  const parts: string[] = []
  const platform = str(entity.platform)
  if (platform) parts.push(platform)
  if (components.length === 1) {
    const c = components[0]
    if (typeof c.levels === "number") parts.push(`${c.levels} lvl`)
    const params = (typeof c.params === "object" && c.params !== null ? c.params : {}) as Record<string, unknown>
    if (typeof params.drive_max === "number") parts.push(`cap ${formatSci(params.drive_max)}`)
  } else if (components.length > 1) {
    const roles = new Set(components.map((c) => str(c.role)).filter(Boolean))
    parts.push(roles.size === 1 ? `${components.length}×${[...roles][0]}` : `${components.length} comps`)
  }
  if (couplings.length === 1) parts.push(str(couplings[0].kind) ?? "1 coupling")
  else if (couplings.length > 1) parts.push(`${couplings.length} couplings`)
  if (components.length > 1 && driveArch) parts.push(driveArch)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// --- formulation projection (spec §6.2) --------------------------------------
// Dual-shape (legacy free-form OR structured facets). The fork CANNOT import
// the plugin's normalizeFormulation, so this re-implements the §10 mapping IN
// PLACE, pinned by the shared fixture corpus (formulation-projection.test.ts).
// Never throws; unknown enums pass through raw.

export type PrimaryObjectiveKey =
  | "ket_infidelity"
  | "unitary_infidelity"
  | "unitary_free_phase"
  | "density_infidelity"
  | "min_time"
export interface FormulationTerm {
  kind: string
  params: Record<string, number>
  label?: string
}
export interface FormulationProjection {
  trajectory_type: string
  time_mode: string
  parameterization: string
  robustness: { kind: string; params: Record<string, unknown> }
  free_phase: boolean
  leakage: boolean
  leakage_params?: Record<string, number>
  time_params?: Record<string, number>
  target: string
  objectives: FormulationTerm[]
  constraints: FormulationTerm[]
  primaryKey: PrimaryObjectiveKey
  derivedFinalFidelity?: number
  solve?: Record<string, unknown>
  isStructured: boolean
}

const fmtTerm = (o: any): FormulationTerm => {
  const out: FormulationTerm = {
    kind: typeof o?.kind === "string" ? o.kind : "custom",
    params: o?.params && typeof o.params === "object" ? o.params : {},
  }
  if (typeof o?.label === "string") out.label = o.label
  return out
}
const fmtRobustness = (r: any): { kind: string; params: Record<string, unknown> } =>
  r && typeof r === "object" && typeof r.kind === "string"
    ? { kind: r.kind, params: r.params && typeof r.params === "object" ? r.params : {} }
    : { kind: "none", params: {} }
const inferTrajFromTarget = (target: string): string => (/^\s*\||prep|state/i.test(target) ? "ket" : "gate")
const fmtConstraintKind = (lc: string): string => {
  if (/slew|\bdu\b/.test(lc)) return "du_bound"
  if (/ddu|accel/.test(lc)) return "ddu_bound"
  if (/Δt|timestep|\bdt\b/.test(lc)) return "dt_bounds"
  if (/calibration|\bpin\b/.test(lc)) return "calibration_pin"
  if (/amplitude|bound/.test(lc)) return "bounds"
  return "custom"
}
const derivePrimaryKey = (trajectory_type: string, free_phase: boolean, time_mode: string): PrimaryObjectiveKey => {
  if (time_mode === "min_time") return "min_time"
  if (trajectory_type === "ket" || trajectory_type === "multiket") return "ket_infidelity"
  if (trajectory_type === "density" || trajectory_type === "multidensity") return "density_infidelity"
  if (trajectory_type === "gate") return free_phase ? "unitary_free_phase" : "unitary_infidelity"
  return "unitary_infidelity"
}

export function formulationProjection(input: Record<string, unknown>): FormulationProjection {
  const r = (input ?? {}) as Record<string, any>
  let trajectory_type: string
  let time_mode: string
  let parameterization: string
  let free_phase: boolean
  let leakage: boolean
  let target: string
  let robustness: { kind: string; params: Record<string, unknown> }
  let objectives: FormulationTerm[]
  let constraints: FormulationTerm[]
  let time_params: Record<string, number> | undefined
  let leakage_params: Record<string, number> | undefined
  let solve: Record<string, unknown> | undefined
  let isStructured: boolean

  if (typeof r.trajectory_type === "string") {
    isStructured = true
    trajectory_type = r.trajectory_type
    time_mode = r.time_mode === "min_time" ? "min_time" : "fixed"
    parameterization = typeof r.parameterization === "string" ? r.parameterization : "smooth"
    robustness = fmtRobustness(r.robustness)
    free_phase = r.free_phase === true
    leakage = r.leakage === true
    target = typeof r.target === "string" ? r.target : ""
    objectives = Array.isArray(r.objectives) ? r.objectives.map(fmtTerm) : []
    constraints = Array.isArray(r.constraints) ? r.constraints.map(fmtTerm) : []
    if (r.time_params && typeof r.time_params === "object") time_params = r.time_params
    if (r.leakage_params && typeof r.leakage_params === "object") leakage_params = r.leakage_params
    if (r.solve && typeof r.solve === "object") solve = r.solve
  } else {
    isStructured = false
    const problem = typeof r.problem === "string" ? r.problem : ""
    target = typeof r.target === "string" ? r.target : ""
    trajectory_type = "gate"
    time_mode = "fixed"
    if (problem === "state_prep") trajectory_type = "ket"
    else if (problem === "min_time") {
      time_mode = "min_time"
      trajectory_type = inferTrajFromTarget(target)
    }
    parameterization = "smooth"
    robustness = { kind: "none", params: {} }
    free_phase = false
    leakage = false
    objectives = []
    const objStr = typeof r.objective === "string" ? r.objective.trim() : ""
    if (objStr && !/infidelity/i.test(objStr)) objectives.push({ kind: "custom", params: {}, label: objStr })
    constraints = []
    for (const c of Array.isArray(r.constraints) ? r.constraints : []) {
      if (typeof c !== "string") continue
      const lc = c.toLowerCase()
      if (/leakage/.test(lc)) {
        leakage = true
        continue
      }
      if (/final.?fidelity/.test(lc)) {
        const m = c.match(/[\d.]+/)
        time_params = { ...(time_params ?? {}), final_fidelity: m ? Number(m[0]) : 0.99 }
        continue
      }
      constraints.push({ kind: fmtConstraintKind(lc), params: {}, label: c })
    }
    if (r.solve && typeof r.solve === "object") solve = r.solve
  }

  const out: FormulationProjection = {
    trajectory_type,
    time_mode,
    parameterization,
    robustness,
    free_phase,
    leakage,
    target,
    objectives,
    constraints,
    primaryKey: derivePrimaryKey(trajectory_type, free_phase, time_mode),
    isStructured,
  }
  if (time_params) out.time_params = time_params
  if (leakage_params) out.leakage_params = leakage_params
  if (solve) out.solve = solve
  if (time_mode === "min_time" && time_params && typeof time_params.final_fidelity === "number")
    out.derivedFinalFidelity = time_params.final_fidelity
  return out
}

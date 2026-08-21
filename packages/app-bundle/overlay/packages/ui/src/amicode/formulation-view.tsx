import { For, Show, createMemo } from "solid-js"
import katex from "katex"
import {
  formulationProjection,
  humanizeKey,
  type PrimaryObjectiveKey,
  type FormulationProjection,
  type FormulationTerm,
} from "./problem"
import { modeBadges } from "./facets"

// AMICODE Formulation hero (spec §6.2 / plan Task 14): a mode-badge header over
// the derived primary objective (LaTeX) + the FULL objective-term and constraint
// ledger, each rendered as LaTeX and grouped by category. The recorded facets
// (formulation.json) carry only the primary + any explicit terms; the rest of a
// Piccolo problem's structure (regularizers, integrators, boundary pins, bounds)
// is implied by the mode. We DERIVE that canonical structure here from the
// projection and merge recorded terms on top (recorded wins). This is static
// structure — not measured weights/values/norms (those live solver-side). Thin:
// logic lives in formulationProjection / modeBadges; styling in ./amicode.css.

// Keyed by the DERIVED primaryKey (disjoint from ObjectiveKind). Unknown → no math.
const OBJECTIVE_LATEX: Record<PrimaryObjectiveKey, string> = {
  ket_infidelity: "\\mathcal{F} = |\\langle \\psi_g | \\psi(T) \\rangle|^2",
  unitary_infidelity: "\\mathcal{F} = \\tfrac{1}{d^2}\\,|\\mathrm{Tr}(U_{\\mathrm{goal}}^\\dagger U)|^2",
  unitary_free_phase: "\\mathcal{F} = \\tfrac{1}{d^2}\\,|\\mathrm{Tr}(U_{\\mathrm{goal}}(\\theta)^\\dagger U)|^2",
  density_infidelity: "\\mathcal{F} = \\mathrm{Tr}(\\rho_g\\, \\rho(T))",
  min_time: "\\min\\; D \\textstyle\\sum_k \\Delta t_k \\quad \\mathrm{s.t.}\\; \\mathcal{F} \\ge \\mathcal{F}_0",
}
const PRIMARY_LABEL: Record<PrimaryObjectiveKey, string> = {
  ket_infidelity: "ket infidelity",
  unitary_infidelity: "unitary infidelity",
  unitary_free_phase: "free-phase unitary infidelity",
  density_infidelity: "density infidelity",
  min_time: "min-time (D · ΣΔt)",
}
// Ensemble robustness IS the primary fidelity averaged over the M sampled systems,
// so we fold it into the primary objective (not a separate row): when ensemble is
// on, the primary equation becomes its ensemble-averaged form (U/ψ/ρ → sample m).
// min_time is intentionally absent — its D·ΣΔt objective is unaffected (the
// ensemble acts on the fidelity constraint), so it keeps the base equation.
const OBJECTIVE_LATEX_ENSEMBLE: Partial<Record<PrimaryObjectiveKey, string>> = {
  ket_infidelity: "\\bar{\\mathcal{F}} = \\tfrac{1}{M}\\textstyle\\sum_{m} |\\langle \\psi_g | \\psi_m(T) \\rangle|^2",
  unitary_infidelity:
    "\\bar{\\mathcal{F}} = \\tfrac{1}{M}\\textstyle\\sum_{m} \\tfrac{1}{d^2}\\,|\\mathrm{Tr}(U_{\\mathrm{goal}}^\\dagger U_m)|^2",
  unitary_free_phase:
    "\\bar{\\mathcal{F}} = \\tfrac{1}{M}\\textstyle\\sum_{m} \\tfrac{1}{d^2}\\,|\\mathrm{Tr}(U_{\\mathrm{goal}}(\\theta)^\\dagger U_m)|^2",
  density_infidelity: "\\bar{\\mathcal{F}} = \\tfrac{1}{M}\\textstyle\\sum_{m} \\mathrm{Tr}(\\rho_g\\, \\rho_m(T))",
}

// Per-term LaTeX + label, keyed by FormulationTerm.kind (objective terms, dynamics
// integrators, and typed constraints). Unknown kind → label only, no equation.
const TERM_LATEX: Record<string, string> = {
  // objective terms — Piccolo QuadraticRegularizer on the control & its derivatives
  reg_u: "\\mathcal{R}_{u} = \\tfrac{1}{2}\\textstyle\\sum_k \\lVert u_k \\rVert^2",
  reg_du: "\\mathcal{R}_{\\dot u} = \\tfrac{1}{2}\\textstyle\\sum_k \\lVert \\dot u_k \\rVert^2",
  reg_ddu: "\\mathcal{R}_{\\ddot u} = \\tfrac{1}{2}\\textstyle\\sum_k \\lVert \\ddot u_k \\rVert^2",
  // [dyn] integrator constraints
  dyn_bilinear: "x_{k+1} = \\exp\\!\\big(\\Delta t_k\\, G(u_k)\\big)\\, x_k",
  dyn_derivative:
    "u_{k+1} = u_k + \\Delta t_k\\,\\dot u_k,\\quad \\dot u_{k+1} = \\dot u_k + \\Delta t_k\\,\\ddot u_k",
  // [eq] equality constraints
  state_pin: "x_1 = x_{\\mathrm{init}}",
  control_endpoints: "u_1 = u_N = 0",
  calibration_pin: "u_j = u_j^{\\mathrm{cal}}",
  time_consistency: "t_{k+1} = t_k + \\Delta t_k",
  equal_timesteps: "\\Delta t_1 = \\Delta t_2 = \\cdots = \\Delta t_N",
  // [ineq] inequality constraints
  final_fidelity: "\\mathcal{F}(T) \\ge \\mathcal{F}_0",
  leakage: "\\textstyle\\sum_{l \\notin \\mathcal{C}} \\lvert \\langle l | \\psi \\rangle \\rvert^2 \\le \\epsilon",
  // [bnd] bounds constraints
  bounds: "\\lvert u_k \\rvert \\le u_{\\max}",
  du_bound: "\\lvert \\dot u_k \\rvert \\le \\dot u_{\\max}",
  ddu_bound: "\\lvert \\ddot u_k \\rvert \\le \\ddot u_{\\max}",
  dt_bounds: "\\Delta t_{\\min} \\le \\Delta t_k \\le \\Delta t_{\\max}",
  state_bound: "-1 \\le \\vec{x}_k \\le 1",
}
const TERM_LABEL: Record<string, string> = {
  reg_u: "regularizer",
  reg_du: "regularizer",
  reg_ddu: "regularizer",
  dyn_bilinear: "quantum dynamics",
  dyn_derivative: "derivative chain",
  state_pin: "initial state",
  control_endpoints: "control endpoints",
  calibration_pin: "calibration pin",
  time_consistency: "time consistency",
  equal_timesteps: "equal timesteps",
  final_fidelity: "final fidelity",
  leakage: "leakage suppression",
  bounds: "amplitude bound",
  du_bound: "slew bound",
  ddu_bound: "accel bound",
  dt_bounds: "Δt bounds",
  state_bound: "state bound",
}
// Constraint category tags (mirrors Piccolo's [dyn]/[eq]/[ineq]/[bnd]). Unknown → untagged.
const CONSTRAINT_CATEGORY: Record<string, string> = {
  dyn_bilinear: "dyn",
  dyn_derivative: "dyn",
  state_pin: "eq",
  control_endpoints: "eq",
  calibration_pin: "eq",
  time_consistency: "eq",
  equal_timesteps: "eq",
  final_fidelity: "ineq",
  leakage: "ineq",
  bounds: "bnd",
  du_bound: "bnd",
  ddu_bound: "bnd",
  dt_bounds: "bnd",
  state_bound: "bnd",
}
const CATEGORY_ORDER = ["dyn", "eq", "ineq", "bnd", ""]

interface Term {
  kind: string
  label?: string
  params?: Record<string, number>
  latexRaw?: string
}

const paramsText = (params: Record<string, number>): string =>
  Object.entries(params)
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ")
const termHead = (t: Term): string => {
  const head = t.label ?? TERM_LABEL[t.kind] ?? t.kind
  const p = t.params ? paramsText(t.params) : ""
  return p ? `${head} · ${p}` : head
}
const renderMath = (kind: string): string | undefined => {
  const latex = TERM_LATEX[kind]
  return latex ? katex.renderToString(latex, { throwOnError: false }) : undefined
}
// A term may carry an inline LaTeX override (e.g. the consolidated regularizer,
// whose equation depends on which control derivatives the mode activates).
const renderTermMath = (t: Term): string | undefined =>
  t.latexRaw ? katex.renderToString(t.latexRaw, { throwOnError: false }) : renderMath(t.kind)
// The regularizer penalizes the control and (for a smooth pulse) its derivatives.
// Shown as ONE "regularizer" objective with a combined norm — not one row per order.
const regLatex = (smooth: boolean): string =>
  smooth
    ? "\\mathcal{R} = \\tfrac{1}{2}\\textstyle\\sum_k \\Delta t_k^2 \\big( \\lVert u_k \\rVert^2 + \\lVert \\dot u_k \\rVert^2 + \\lVert \\ddot u_k \\rVert^2 \\big)"
    : "\\mathcal{R} = \\tfrac{1}{2}\\textstyle\\sum_k \\Delta t_k^2 \\lVert u_k \\rVert^2"
const categoryOf = (kind: string): string => CONSTRAINT_CATEGORY[kind] ?? ""

// Merge canonical (derived) structure with recorded terms: keep EVERY recorded
// term (never collapse two of the same kind — e.g. amplitude + detuning bound),
// and add a derived term only when its kind wasn't recorded. Derived first so the
// canonical scaffold reads before problem-specific specializations.
const mergeTerms = (derived: Term[], recorded: FormulationTerm[]): Term[] => {
  const recordedKinds = new Set(recorded.map((r) => r.kind))
  const derivedOnly = derived.filter((d) => !recordedKinds.has(d.kind))
  return [...derivedOnly, ...recorded.map((r) => ({ kind: r.kind, label: r.label, params: r.params }))]
}

// The objective terms Piccolo attaches beyond the primary: the regularizer
// (smoothness). Robustness is NOT a separate term here — ensemble robustness is
// folded into the primary objective (see OBJECTIVE_LATEX_ENSEMBLE + `ensemble`).
const canonicalObjectives = (p: FormulationProjection): Term[] => [
  { kind: "reg", label: "regularizer", latexRaw: regLatex(p.parameterization === "smooth") },
]

// The constraint ledger implied by the mode. Mirrors what Piccolo actually builds
// for a smooth pulse (verified against DirectTrajOpt / Piccolo templates):
//   [dyn] quantum dynamics (BilinearIntegrator) — always
//   [dyn] derivative chain (u,u̇ integrators) — smooth pulse
//   [eq]  initial state pin; control endpoints u₁=u_N=0 (smooth)
//   [eq]  time consistency (t_{k+1}=tₖ+Δtₖ) + equal timesteps — whenever Δt is a
//         free variable (smooth pulses carry a free, uniform Δt; so does min-time)
//   [bnd] amplitude bound; accel bound (smooth); state box bound
//   [ineq] final-fidelity floor (min-time); leakage (when on)
// NOT emitted by default (Piccolo defaults): slew/du bound (du_bound = Inf) and a
// Δt box bound (Δt_bounds = nothing) — surfaced only if the recorded data has them.
const canonicalConstraints = (p: FormulationProjection): Term[] => {
  const smooth = p.parameterization === "smooth"
  const freeDt = smooth || p.time_mode === "min_time"
  const t: Term[] = [{ kind: "dyn_bilinear" }]
  if (smooth) t.push({ kind: "dyn_derivative" })
  t.push({ kind: "state_pin" })
  if (smooth) t.push({ kind: "control_endpoints" })
  if (freeDt) t.push({ kind: "time_consistency" }, { kind: "equal_timesteps" })
  t.push({ kind: "bounds" })
  if (smooth) t.push({ kind: "ddu_bound" })
  t.push({ kind: "state_bound" })
  if (p.time_mode === "min_time") t.push({ kind: "final_fidelity" })
  if (p.leakage) t.push({ kind: "leakage" })
  return t
}

// The Solve scalars, humanized so they read as parameters rather than a raw blob.
// Surfaced as mode-style badges (label + value); unknown keys fall back to the
// shared humanizeKey. No symbol/unit — the raw value carries the meaning.
const SOLVE_LABEL: Record<string, string> = {
  T: "duration",
  N: "timesteps",
  max_iter: "max iterations",
  integrator: "integrator",
  dt: "timestep",
}
const solveRows = (solve: Record<string, unknown>): { label: string; value: string }[] =>
  Object.entries(solve).map(([k, v]) => ({
    label: SOLVE_LABEL[k] ?? humanizeKey(k),
    value: String(v),
  }))

// The "type" chip surfaces the specific gate when the target names one:
// gate + target "X" → "x-gate", "CZ" → "cz-gate". No named target (or a non-gate
// trajectory) → undefined, leaving the plain trajectory type ("gate"/"ket"/…).
const gateKind = (p: FormulationProjection): string | undefined => {
  const t = p.target?.trim()
  if (!t || p.trajectory_type !== "gate") return undefined
  return /gate/i.test(t) ? t.toLowerCase() : `${t.toLowerCase()}-gate`
}

export function FormulationView(props: { entity: Record<string, unknown> }) {
  const proj = createMemo(() => formulationProjection(props.entity))
  // Leakage is surfaced as a constraint row below, so drop it from the mode bar
  // to avoid showing the same thing twice.
  const badges = createMemo(() => {
    const p = proj()
    const gk = gateKind(p)
    return modeBadges(p as unknown as Record<string, unknown>)
      .filter((b) => b.label !== "leakage")
      .map((b) => (b.label === "type" && gk ? { ...b, value: gk } : b))
  })
  // Ensemble robustness (the only kind in the data) folds into the primary: it
  // gates the averaged equation and the "M = n_systems" annotation on that row.
  const ensemble = createMemo(() => {
    const r = proj().robustness
    if (!r?.kind || r.kind === "none") return undefined
    const n = r.params?.n_systems
    return { m: typeof n === "number" ? n : undefined }
  })
  const primaryHtml = createMemo(() => {
    const key = proj().primaryKey
    const latex = (ensemble() && OBJECTIVE_LATEX_ENSEMBLE[key]) || OBJECTIVE_LATEX[key]
    return latex ? katex.renderToString(latex, { throwOnError: false }) : undefined
  })

  const objectiveRows = createMemo(() => {
    const p = proj()
    return mergeTerms(canonicalObjectives(p), p.objectives).map((t) => ({ ...t, latex: renderTermMath(t) }))
  })

  // Every constraint: the derived canonical ledger + recorded constraints, plus a
  // final-fidelity row carrying its threshold when the projection knows one.
  // Sorted by category so [dyn]/[eq]/[ineq]/[bnd] read as groups.
  const constraintRows = createMemo(() => {
    const p = proj()
    const merged = mergeTerms(canonicalConstraints(p), p.constraints)
    const ff = p.time_params?.final_fidelity ?? p.derivedFinalFidelity
    if (typeof ff === "number") {
      const existing = merged.find((r) => r.kind === "final_fidelity")
      if (existing) {
        if (!existing.label) existing.label = `final fidelity ≥ ${ff}`
      } else {
        merged.push({ kind: "final_fidelity", label: `final fidelity ≥ ${ff}` })
      }
    }
    return merged
      .map((t) => ({ ...t, cat: categoryOf(t.kind), latex: renderTermMath(t) }))
      .sort((a, b) => CATEGORY_ORDER.indexOf(a.cat) - CATEGORY_ORDER.indexOf(b.cat))
  })

  return (
    <div class="amc-formulation" data-component="amicode-formulation-view">
      <div class="amc-modebar" data-slot="amicode-formulation-modes">
        <For each={badges()}>
          {(b) => (
            <span class="amc-badge">
              <Show when={b.value} fallback={<span class="v">{b.label}</span>}>
                <span class="k">{b.label}</span>
                <span class="v">{b.value}</span>
              </Show>
            </span>
          )}
        </For>
        <Show when={proj().solve}>
          {(solve) => (
            <For each={solveRows(solve() as Record<string, unknown>)}>
              {(row) => (
                <span class="amc-badge" data-slot="amicode-formulation-solve">
                  <span class="k">{row.label}</span>
                  <span class="v">{row.value}</span>
                </span>
              )}
            </For>
          )}
        </Show>
      </div>

      <div class="amc-ev-sec">Objective</div>
      <div class="amc-obj" data-slot="amicode-formulation-objective">
        <div class="amc-term">
          <div class="amc-term-head">
            <span class="amc-obj-name">{PRIMARY_LABEL[proj().primaryKey]}</span>
            <Show when={ensemble()}>
              {(e) => <span class="amc-term-sub">ensemble{e().m ? ` · M = ${e().m}` : ""}</span>}
            </Show>
          </div>
          <Show when={primaryHtml()}>{(html) => <div class="amc-term-latex" innerHTML={html()} />}</Show>
        </div>
        <For each={objectiveRows()}>
          {(o) => (
            <div class="amc-term">
              <div class="amc-term-head">
                <span class="amc-term-name">{termHead(o)}</span>
              </div>
              <Show when={o.latex}>{(html) => <div class="amc-term-latex" innerHTML={html()} />}</Show>
            </div>
          )}
        </For>
      </div>

      <Show when={constraintRows().length > 0}>
        <div class="amc-ev-sec">Constraints</div>
        <div class="amc-constraints" data-slot="amicode-formulation-constraints">
          <For each={constraintRows()}>
            {(c) => (
              <div class="amc-term">
                <div class="amc-term-head">
                  <span class="amc-term-name">{termHead(c)}</span>
                </div>
                <Show when={c.latex}>{(html) => <div class="amc-term-latex" innerHTML={html()} />}</Show>
              </div>
            )}
          </For>
        </div>
      </Show>

    </div>
  )
}

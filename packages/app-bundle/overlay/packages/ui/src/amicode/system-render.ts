// system-render.ts — pure schematic + table models for the System hero
// (spec-20260709 §6.1 / plan Task 4). Consumes the existing systemProjection;
// no SolidJS. Never throws.
import { systemProjection, type SystemProjection } from "./problem"
import { formatSci } from "./facets"

/** The component-count claim the card is making — "2 atoms × 3 levels", or
 *  undefined when there are none. Rendered as its own badge so N is something
 *  the researcher can read and correct, not something they have to infer from
 *  the card's shape (an unanswered "how many atoms?" used to look like "one"). */
export function systemCountLabel(proj: SystemProjection): string | undefined {
  const comps = proj.components ?? []
  if (comps.length === 0) return undefined
  const roles = new Set(comps.map((c) => c.role))
  const levels = new Set(comps.map((c) => c.levels).filter((l): l is number => typeof l === "number"))
  // "other" is the honest role for an unclassified subsystem, but "3 others"
  // reads as a bug — say what it is structurally instead.
  const only = roles.size === 1 ? [...roles][0] : undefined
  const role = only === undefined || only === "other" || only === "?" ? "component" : only
  const seg = `${comps.length} ${comps.length === 1 ? role : `${role}s`}`
  return levels.size === 1 ? `${seg} × ${[...levels][0]} levels` : seg
}

/** One-line "what is this system" identity: platform · N role(s) × L levels ·
 *  <arch> drive. e.g. "rydberg · 2 atoms × 3 levels · global drive". Collapses
 *  the schematic+table into a scannable header line. Never throws. */
export function systemIdentityLine(proj: SystemProjection): string {
  return [proj.platform, systemCountLabel(proj), proj.driveArch ? `${proj.driveArch} drive` : undefined]
    .filter((p): p is string => p !== undefined && p !== "")
    .join(" · ")
}

export type SchematicNode = { id: string; label: string; levels?: number }
export type SchematicEdge = { a: string; b: string; label: string }
export type SchematicModel = {
  nodes: SchematicNode[]
  edges: SchematicEdge[]
  looseCouplings: { between: string[]; kind: string }[]
  topology?: string
}

/** Nodes = components; an edge is drawn only for a 2-id coupling between
 *  components ADJACENT in the components array (covers single-pair + linear-
 *  chain). Non-adjacent / >2-id / hyperedge couplings go to looseCouplings
 *  (listed, not drawn — no graph-layout engine). N=1 → single node, no edges. */
export function systemSchematicModel(proj: SystemProjection): SchematicModel {
  const nodes: SchematicNode[] = proj.components.map((c) => ({
    id: c.id,
    label: c.role,
    ...(typeof c.levels === "number" ? { levels: c.levels } : {}),
  }))
  const index = new Map(proj.components.map((c, i) => [c.id, i]))
  const edges: SchematicEdge[] = []
  const looseCouplings: { between: string[]; kind: string }[] = []
  for (const cp of proj.couplings) {
    const ids = cp.between
    if (ids.length === 2) {
      const i = index.get(ids[0])
      const j = index.get(ids[1])
      if (i !== undefined && j !== undefined && Math.abs(i - j) === 1) {
        edges.push({ a: ids[0], b: ids[1], label: cp.kind })
        continue
      }
    }
    looseCouplings.push({ between: ids, kind: cp.kind })
  }
  return { nodes, edges, looseCouplings, ...(proj.topology ? { topology: proj.topology } : {}) }
}

export type ComponentRow = { id: string; role: string; levels?: number; params: Record<string, number> }
export type CouplingRow = { between: string[]; kind: string; params: Record<string, number> }
export type TableModel = { components: ComponentRow[]; couplings: CouplingRow[] }

// Composite Hamiltonian LaTeX (spec §6.1 "show the system"), composed over the
// ACTUAL component and edge sets. The previous version deduped term STRINGS over
// the set of distinct roles, which meant a 2-atom register and a 20-atom register
// rendered the identical single-site Hamiltonian, an N-edge chain rendered one
// edge with hardcoded indices (1),(2), a qubit and a cavity in the same system
// both used â, and the drive-arch badge had no counterpart in the equation.
// Still ILLUSTRATIVE — the canonical model per role, not a derivation from the
// recorded numbers — but it has to be the Hamiltonian of THIS system.

type SiteKind = "spin" | "ladder" | "rydberg" | "opaque"
type Site = { idx: number; role: string; kind: SiteKind; key: string; letter: string }

/** Distinct bosonic groups get distinct operator letters, so a qubit ladder and
 *  a cavity in one system are never both â. */
const LADDER_LETTERS = ["a", "b", "c", "d", "e", "f", "g", "h"]
const KERR_KEYS = ["K", "K_c", "K_c_Hz", "kerr"]
const MODE_ROLES = new Set(["cavity", "resonator", "mode"])

/** The ONLY platforms whose `qubit` role is an anharmonic ladder. Nothing else
 *  may assume one — not the role (the plugin's platformDefaultRole maps every
 *  unfamiliar platform to "qubit"), and not the level count (three levels is a
 *  dimension, not an oscillator). Both of those leaks put the transmon
 *  Hamiltonian, and the transmon's anharmonicity row, on a spin qubit.
 *  A bosonic MODE is classified by its role instead, so it needs no entry here;
 *  "bosonic" covers a platform that calls its computational element a qubit. */
const LADDER_PLATFORMS = new Set(["transmon", "bosonic"])

/** The term shape a component contributes; `key` groups sites that share one
 *  (two linear cavities are one group, a Kerr cavity is its own) and selects the
 *  physics rows, so the equation and the table can never disagree. */
function classify(c: ComponentRow, platform?: string): { kind: SiteKind; key: string } {
  switch (c.role) {
    case "atom":
      return { kind: "rydberg", key: "rydberg" }
    case "qubit":
      // Two levels is a generic two-level system on ANY platform — every one of
      // them has an ω σ_z/2 splitting and σ_x/σ_y control, so that much is safe.
      //
      // MORE than two levels is NOT evidence of an anharmonic oscillator. It is
      // evidence of a Hilbert-space dimension and nothing else: an exchange-only
      // spin qubit at levels=3 is three dots, a spin-1 defect is three Zeeman
      // sublevels, and neither is a ladder. Only a platform that comes with a
      // ladder model may claim one.
      if (c.levels === 2) return { kind: "spin", key: "spin" }
      return LADDER_PLATFORMS.has((platform ?? "").toLowerCase())
        ? { kind: "ladder", key: "qubit" }
        : { kind: "opaque", key: `opaque:${c.role}` }
    case "cavity":
    case "resonator":
    case "mode":
      // A mode's Kerr is genuinely optional, so here the params ARE the evidence.
      return KERR_KEYS.some((k) => k in c.params) ? { kind: "ladder", key: "mode-kerr" } : { kind: "ladder", key: "mode" }
    default:
      return { kind: "opaque", key: `opaque:${c.role}` }
  }
}

const ann = (letter: string, i: string) => (i ? `\\hat ${letter}_{${i}}` : `\\hat ${letter}`)
const cre = (letter: string, i: string) => (i ? `\\hat ${letter}^\\dagger_{${i}}` : `\\hat ${letter}^\\dagger`)
const num = (i: string) => (i ? `\\hat n_{${i}}` : "\\hat n")
const pauli = (axis: string, i: string) => (i ? `\\hat\\sigma_${axis}^{(${i})}` : `\\hat\\sigma_${axis}`)
const sub = (sym: string, i: string) => (i ? `${sym}_{${i}}` : sym)

/** The index a CONTROL carries, bare: "" when one knob is shared by every site
 *  (a global drive, or a single-component system), the site index when each has
 *  its own, the zone when they are zoned. That distinction is the whole
 *  difference between a global-drive CZ and a locally-addressed one, and the
 *  card claims it in a badge. Bare so callers can compose it either as a
 *  subscript (`\Omega_{i}`) or into an existing one (`u_{1,i}`). */
const controlIdx = (i: string, arch?: string) => (!i || arch === "global" ? "" : arch === "zoned" ? `z(${i})` : i)
const control = (i: string, arch?: string) => {
  const c = controlIdx(i, arch)
  return c ? `_{${c}}` : ""
}

/** Sum prefix + index token for a group: no index at all in a single-component
 *  system, a literal site number for a lone member, `\sum_i` when the group is
 *  every site, else an explicit index set. */
function indexing(group: Site[], total: number): { sum: string; i: string } {
  if (total === 1) return { sum: "", i: "" }
  if (group.length === total) return { sum: "\\sum_i ", i: "i" }
  if (group.length === 1) return { sum: "", i: String(group[0].idx) }
  return { sum: `\\sum_{i \\in \\{${group.map((s) => s.idx).join(",")}\\}} `, i: "i" }
}

/** Parenthesize a summed body only when it has a top-level `+` — an h.c. inside
 *  its own parens must not trigger a redundant outer bracket. */
function wrap(sum: string, body: string): string {
  if (!sum) return body
  let depth = 0
  for (const ch of body) {
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === "+" && depth === 0) return `${sum}\\left(${body}\\right)`
  }
  return `${sum}${body}`
}

function driftLatex(g: Site[], total: number, arch?: string): string {
  const { sum, i } = indexing(g, total)
  switch (g[0].kind) {
    case "spin":
      return wrap(sum, `\\tfrac{${sub("\\omega", i)}}{2}\\,${pauli("z", i)}`)
    case "rydberg": {
      // Δ is set by the laser, so it is per-site exactly when the drive is.
      const c = control(i, arch)
      return c ? `-${sum}\\Delta${c}\\,${num(i)}` : `-\\Delta\\,${sum}${num(i)}`
    }
    case "ladder": {
      const L = g[0].letter
      const isMode = g[0].key.startsWith("mode")
      const w = isMode ? (i ? `\\omega_{c,${i}}` : "\\omega_c") : sub("\\omega", i)
      const linear = `${w}\\,${cre(L, i)} ${ann(L, i)}`
      if (g[0].key === "mode") return wrap(sum, linear)
      const k = isMode ? sub("K", i) : sub("\\delta", i)
      const sq = i ? `\\hat ${L}^{\\dagger 2}_{${i}}\\hat ${L}^{2}_{${i}}` : `\\hat ${L}^{\\dagger 2}\\hat ${L}^{2}`
      return wrap(sum, `${linear} + \\tfrac{${k}}{2}\\,${sq}`)
    }
    default:
      // No model for this role — name a drift, don't invent its algebra.
      return `${sum}${i ? `\\hat H_{\\mathrm{drift}}^{(${i})}` : "\\hat H_{\\mathrm{drift}}"}`
  }
}

/** Atoms are laser-driven on |1⟩↔|r⟩ (3-level Rydberg convention: |0⟩ dark); a
 *  strictly two-level component is driven in the Pauli basis its drift already
 *  uses; bosonic and bosonic-truncated components keep the quadrature drive; a
 *  role we have no model for gets a named control, not an invented operator. */
function driveLatex(g: Site[], total: number, arch?: string): string {
  const { sum, i } = indexing(g, total)
  const c = control(i, arch)
  switch (g[0].kind) {
    case "rydberg":
      return wrap(sum, `\\tfrac{\\Omega${c}(t)}{2}\\,(|r\\rangle\\langle 1|${i ? `_{${i}}` : ""} + \\mathrm{h.c.})`)
    case "spin":
      return wrap(sum, `u^x${c}(t)\\,${pauli("x", i)} + u^y${c}(t)\\,${pauli("y", i)}`)
    case "ladder": {
      // TWO quadratures. Piccolo drives a transmon with n_drives = 2, and the
      // plugin's TRANSMON_LATEX (what the agent shows in chat) always said so —
      // this table used to say `ε(t)(â+â†)`, one control, and nobody noticed the
      // card and the chat disagreeing about the same device.
      const q = controlIdx(i, arch)
      const u = (n: number) => `u_{${n}${q ? `,${q}` : ""}}(t)`
      const A = ann(g[0].letter, i)
      const Ad = cre(g[0].letter, i)
      return wrap(sum, `${u(1)}\\,(${A} + ${Ad}) + i\\,${u(2)}\\,(${A} - ${Ad})`)
    }
    default:
      return `${sum}\\hat H_{\\mathrm{c}}${i ? `^{(${i})}` : ""}(t)`
  }
}

type Edge = { a: Site; b: Site; rest: Site[] }

/** Raising / lowering operator for a site in whatever algebra it actually has.
 *  A coupling term must never assume its endpoints are bosonic: the ladder
 *  letter is empty for a spin, an atom, or an unmodeled role, and `\hat ^\dagger`
 *  is not LaTeX — it renders as an error box in the transcript. */
const raise = (s: Site, i: string) =>
  s.kind === "ladder" ? cre(s.letter, i) : s.kind === "rydberg" ? `|r\\rangle\\langle 1|_{${i}}` : `\\hat\\sigma_+^{(${i})}`
const lower = (s: Site, i: string) =>
  s.kind === "ladder" ? ann(s.letter, i) : s.kind === "rydberg" ? `|1\\rangle\\langle r|_{${i}}` : `\\hat\\sigma_-^{(${i})}`

/** One term for a set of edges that share a kind AND an endpoint shape. A lone
 *  edge names its actual sites; several become a sum over pairs — the old code
 *  printed one hardcoded `(1),(2)` term no matter how many edges existed. */
function couplingLatex(kind: string, edges: Edge[]): string {
  const many = edges.length > 1
  const e = edges[0]
  const x = many ? "i" : String(e.a.idx)
  const y = many ? "j" : String(e.b.idx)
  const pair = many ? "\\sum_{\\langle ij\\rangle} " : ""
  // For a role we have no model for — or a coupling kind we don't know — name
  // the interaction. Inventing its algebra would be a guess, and DROPPING it
  // (what an unknown kind used to do) left the card listing a coupling that the
  // equation silently didn't have.
  const generic = `${pair}\\hat H_{\\mathrm{int},${x}${y}}`
  if (e.a.kind === "opaque" || e.b.kind === "opaque") return generic
  switch (kind) {
    case "vdW":
      return `${pair}\\tfrac{C_6}{r_{${x}${y}}^6}\\,${num(x)} ${num(y)}`
    case "ZZ": {
      const spins = e.a.kind === "spin" && e.b.kind === "spin"
      const op = spins ? `${pauli("z", x)}${pauli("z", y)}` : `${num(x)} ${num(y)}`
      return `${pair}${many ? "J_{ij}" : "J"}\\,${op}`
    }
    case "cross-resonance": {
      // Drive on the control at the target's frequency. Pauli form only when
      // both ends really are two-level — otherwise it would put σ algebra on
      // components whose drift is an anharmonic ladder, in the same equation.
      const amp = many ? "\\Omega_{\\mathrm{CR},ij}" : "\\Omega_{\\mathrm{CR}}"
      return e.a.kind === "spin" && e.b.kind === "spin"
        ? `${pair}${amp}\\,${pauli("x", x)}${pauli("z", y)}`
        : `${pair}${amp}\\,(${lower(e.a, x)} + ${raise(e.a, x)})\\,${num(y)}`
    }
    case "exchange":
      return `${pair}${many ? "g_{ij}" : "g"}\\,(${raise(e.a, x)} ${lower(e.b, y)} + \\mathrm{h.c.})`
    case "dispersive-chi": {
      // `b` is the mode (oriented by the caller). Several qubits on ONE cavity
      // is the common readout layout, and there the cavity factors out.
      if (e.b.kind !== "ladder") return generic // a dispersive shift needs a mode
      const m = String(e.b.idx)
      const cav = `${cre(e.b.letter, m)} ${ann(e.b.letter, m)}`
      if (!many)
        return e.a.kind === "spin"
          ? `\\tfrac{\\chi}{2}\\,${cav}\\,${pauli("z", x)}`
          : `\\chi\\,${cav}\\,${num(x)}`
      if (edges.every((z) => z.b.idx === e.b.idx)) return `${cav}\\,\\sum_i \\chi_i\\,${num("i")}`
      return `\\sum_{\\langle ij\\rangle} \\chi_{ij}\\,${cre(e.b.letter, "j")} ${ann(e.b.letter, "j")}\\,${num("i")}`
    }
    case "mode-mediated": {
      // The shared mode is `b`; every other member couples into it.
      if (e.b.kind !== "ladder") return generic // nothing to mediate through
      const ids = [...new Set(edges.flatMap((z) => [z.a, ...z.rest]).map((s) => s.idx))].sort((p, q) => p - q)
      const qi = ids.length > 1 ? "i" : String(ids[0])
      const sum = ids.length > 1 ? `\\sum_{i \\in \\{${ids.join(",")}\\}} ` : ""
      return `${sum}g\\,(${raise(e.a, qi)} ${ann(e.b.letter, String(e.b.idx))} + \\mathrm{h.c.})`
    }
  }
  return generic
}

/** Terms carry their own sign, so a drift like `-Δ n̂` must not be pasted on
 *  with " + " (that printed a literal "+ -Δ"). */
function joinTerms(terms: string[]): string {
  return terms.reduce((acc, t) => (!acc ? t : t.startsWith("-") ? `${acc} - ${t.slice(1).trimStart()}` : `${acc} + ${t}`), "")
}

export type SystemHamiltonian = {
  latex: string
  /** recorded = the researcher confirmed these exact terms · inferred = the
   *  canonical form for the platform, which the card must SAY it is guessing. */
  source: "recorded" | "inferred"
  /** Conventions the recorded terms assume (frame, units, basis). */
  notes?: string
}

/** What the card should show. Recorded terms win outright: they are the model
 *  the researcher confirmed, and the fallback below can only ever be right for
 *  platforms someone hardcoded. undefined = say nothing, which is the honest
 *  answer for an off-template platform nobody has described yet. */
export function systemHamiltonian(proj: SystemProjection): SystemHamiltonian | undefined {
  const recorded = proj.hamiltonian
  if (recorded && recorded.terms.length > 0) {
    // Ordered drift → coupling → drive regardless of the order they were
    // recorded in, so the equation reads the way a physicist writes one.
    const rank = { drift: 0, coupling: 1, drive: 2 } as Record<string, number>
    const terms = [...recorded.terms].sort((a, b) => (rank[a.kind] ?? 0) - (rank[b.kind] ?? 0))
    return {
      latex: "\\hat H/\\hbar = " + joinTerms(terms.map((t) => t.latex.trim())),
      source: "recorded",
      ...(recorded.notes ? { notes: recorded.notes } : {}),
    }
  }
  const latex = systemHamiltonianLatex(proj)
  return latex ? { latex, source: "inferred" } : undefined
}

/** The canonical form for a platform we model, composed from the structure:
 *  one drift and one drive per component GROUP (summed over the group's sites)
 *  plus one term per set of like edges. This is a FALLBACK — it is a guess about
 *  physics nobody stated, and every caller must present it as one. undefined
 *  when there is nothing to say. Never throws. */
export function systemHamiltonianLatex(proj: SystemProjection): string | undefined {
  const total = proj.components.length
  if (total === 0) return undefined

  const sites: Site[] = proj.components.map((c, k) => ({
    idx: k + 1,
    role: c.role,
    letter: "",
    ...classify(c, proj.platform),
  }))
  const byKey = new Map<string, Site[]>()
  for (const s of sites) (byKey.get(s.key) ?? byKey.set(s.key, []).get(s.key)!).push(s)
  const groups = [...byKey.values()]
  let letters = 0
  for (const g of groups)
    if (g[0].kind === "ladder") {
      const L = LADDER_LETTERS[letters++ % LADDER_LETTERS.length]
      for (const s of g) s.letter = L
    }

  const byId = new Map(proj.components.map((c, k) => [c.id, sites[k]]))
  const edges = new Map<string, Edge[]>()
  for (const cp of proj.couplings) {
    const members = cp.between.map((id) => byId.get(id)).filter((s): s is Site => s !== undefined)
    if (members.length < 2) continue
    // dispersive / mode-mediated are oriented so the shared mode is always `b`.
    const mode = members.find((s) => MODE_ROLES.has(s.role))
    const others = mode ? members.filter((s) => s !== mode) : members
    const edge: Edge =
      mode && (cp.kind === "dispersive-chi" || cp.kind === "mode-mediated")
        ? { a: others[0], b: mode, rest: others.slice(1) }
        : { a: members[0], b: members[1], rest: members.slice(2) }
    const key = `${cp.kind}|${edge.a.kind}|${edge.b.kind}`
    ;(edges.get(key) ?? edges.set(key, []).get(key)!).push(edge)
  }

  // Nothing to say: every component is a model we don't have, so the only
  // "Hamiltonian" we could compose is `Ĥ_drift + Ĥ_c(t)` — true of literally
  // every control problem, and it would occupy the slot where the real model
  // belongs. Silence here is what makes the agent record one.
  if (groups.every((g) => g[0].kind === "opaque")) return undefined

  const terms = groups.map((g) => driftLatex(g, total, proj.driveArch))
  for (const [key, group] of edges) terms.push(couplingLatex(key.split("|")[0], group))
  terms.push(...groups.map((g) => driveLatex(g, total, proj.driveArch)))
  return "\\hat H/\\hbar = " + joinTerms(terms)
}

// --- physics rows -------------------------------------------------------------
// The card must never invent a slot the model doesn't have. It used to emit a
// fixed transmon spec (frequency · anharmonicity · drive bound · decay) for
// EVERY component, so a Rydberg atom was asked for its anharmonicity while the
// Hamiltonian directly above it — which IS role-aware — showed a 3-level ladder
// with no such term. The row list is derived from the role here, next to the
// Hamiltonian tables, because split sources are why the two halves disagreed.

/** Unitless params get a math symbol; unit-suffixed keys (chi_kHz, K_c_Hz,
 *  N_fock) keep their name so the unit isn't lost. */
export const PARAM_SYMBOL: Record<string, string> = {
  omega: "ω",
  delta: "δ",
  chi: "χ",
  strength: "J",
  drive_max: "|u|",
  du_bound: "|u̇|",
  Delta: "Δ",
  Omega: "Ω",
  kappa: "κ",
}

export type PhysicsRow = {
  label: string
  sym?: string
  /** Formatted number (+ unit when the recorded key spells one), or "not set". */
  value: string
  /** recorded = on file · missing = this role HAS this param, nobody has said
   *  what it is yet. Params the role doesn't have are absent, not "missing". */
  state: "recorded" | "missing"
}

type ParamSpec = {
  /** Accepted keys, canonical first. A `_GHz`-style suffix is matched
   *  automatically, so list only bare forms. Case-sensitive: an atom's `Delta`
   *  (detuning) must not silently absorb a transmon's `delta` (anharmonicity). */
  keys: string[]
  label: string
  sym: string
  /** Rendered before the number ("≤ " for a bound). */
  prefix?: string
}

/** Units are never assumed: transmon params are GHz, the Rydberg templates work
 *  in rad/μs, and a bare `omega` says which only by convention. So a unit is
 *  shown only when the recorded key spells it out. */
const UNIT_SUFFIX = /_(Hz|kHz|MHz|GHz|THz|s|ms|us|µs|ns|rad|deg)$/

const MODE_PARAMS: ParamSpec[] = [
  { keys: ["omega_c", "omega", "frequency"], label: "frequency", sym: "ω" },
  { keys: ["K", "K_c", "kerr"], label: "kerr", sym: "K" },
  { keys: ["kappa"], label: "linewidth", sym: "κ" },
]

/** Params each MODEL has, in card order — keyed by the same `classify` result
 *  that picks the Hamiltonian terms, so the equation and the table are always
 *  describing the same physics. A model we don't have (`opaque:*`) expects
 *  NOTHING and shows only what was recorded: that is the honest floor for a
 *  platform outside the templated set.  */
const MODEL_PARAMS: Record<string, ParamSpec[]> = {
  spin: [
    // A two-level system has a splitting and a drive bound — and no third level
    // to be anharmonic against.
    { keys: ["omega", "frequency", "f01"], label: "frequency", sym: "ω" },
    { keys: ["drive_max"], label: "drive bound", sym: "|u|", prefix: "≤ " },
  ],
  qubit: [
    { keys: ["omega", "frequency", "f01"], label: "frequency", sym: "ω" },
    { keys: ["delta", "alpha", "anharmonicity"], label: "anharmonicity", sym: "δ" },
    { keys: ["drive_max"], label: "drive bound", sym: "|u|", prefix: "≤ " },
  ],
  rydberg: [
    // Lowercase `delta_max`/`omega_max` are what the Rydberg template and the
    // interview actually record (Δ_max, Ω_max). They are safe to claim here and
    // ONLY here: the spec is keyed by model, so a transmon's δ can never reach
    // this row. A bare `delta` on an atom stays deliberately unclaimed — it is
    // far more likely a misfiled anharmonicity than a detuning.
    { keys: ["Delta", "Delta_max", "delta_max", "detuning"], label: "detuning", sym: "Δ", prefix: "≤ " },
    { keys: ["Omega", "Omega_max", "omega_max", "rabi_max", "rabi", "drive_max"], label: "rabi drive", sym: "Ω", prefix: "≤ " },
  ],
  mode: MODE_PARAMS,
  "mode-kerr": MODE_PARAMS,
}

/** First recorded key matching any alias. A zero keeps the old "0 means unset"
 *  reading — an all-zeros seed shouldn't look like a specified device. */
function matchParam(params: Record<string, number>, keys: string[]) {
  for (const key of keys)
    for (const [k, v] of Object.entries(params)) {
      if (typeof v !== "number" || v === 0) continue
      if (k === key || k.replace(UNIT_SUFFIX, "") === key) {
        const unit = k.match(UNIT_SUFFIX)?.[1]
        return { key: k, text: unit ? `${formatSci(v)} ${unit}` : formatSci(v) }
      }
    }
  return undefined
}

/** Rows for ONE component: levels, the params its MODEL actually has (unanswered
 *  ones read "not set" — that list doubles as the interview's to-do), then
 *  anything else recorded, so nothing on file is dropped. `platform` is what
 *  separates a transmon from a qubit we have no model for. Never throws. */
export function componentPhysicsRows(c: ComponentRow, platform?: string): PhysicsRow[] {
  const spec = MODEL_PARAMS[classify(c, platform).key] ?? []
  const claimed = new Set<string>()
  const rows: PhysicsRow[] =
    c.levels === undefined
      ? [{ label: "levels", value: "not set", state: "missing" }]
      : [{ label: "levels", value: String(c.levels), state: "recorded" }]
  for (const s of spec) {
    const hit = matchParam(c.params, s.keys)
    if (hit) claimed.add(hit.key)
    rows.push({
      label: s.label,
      sym: s.sym,
      value: hit ? `${s.prefix ?? ""}${hit.text}` : "not set",
      state: hit ? "recorded" : "missing",
    })
  }
  // Decay belongs to the environment rather than to any one role's Hamiltonian,
  // so it is asked for every role we model — and never invented for one we don't.
  if (spec.length > 0) {
    const t1 = matchParam(c.params, ["T1", "t1"])
    const t2 = matchParam(c.params, ["T2", "t2"])
    if (t1) claimed.add(t1.key)
    if (t2) claimed.add(t2.key)
    const decay = [t1 ? `T₁ ${t1.text}` : undefined, t2 ? `T₂ ${t2.text}` : undefined].filter(Boolean).join(" · ")
    rows.push({ label: "decay", sym: "T₁/T₂", value: decay || "not set", state: decay ? "recorded" : "missing" })
  }
  for (const [k, v] of Object.entries(c.params)) {
    if (claimed.has(k) || typeof v !== "number" || v === 0) continue
    const unit = k.match(UNIT_SUFFIX)?.[1]
    rows.push({
      label: k.replace(UNIT_SUFFIX, ""),
      ...(PARAM_SYMBOL[k] ? { sym: PARAM_SYMBOL[k] } : {}),
      value: unit ? `${formatSci(v)} ${unit}` : formatSci(v),
      state: "recorded",
    })
  }
  return rows
}

export function systemTableModel(proj: SystemProjection): TableModel {
  return {
    components: proj.components.map((c) => ({
      id: c.id,
      role: c.role,
      ...(typeof c.levels === "number" ? { levels: c.levels } : {}),
      params: c.params,
    })),
    couplings: proj.couplings.map((cp) => ({ between: cp.between, kind: cp.kind, params: cp.params })),
  }
}

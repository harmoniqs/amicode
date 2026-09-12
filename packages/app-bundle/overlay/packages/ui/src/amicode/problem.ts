// AMICODE: single consumer of the problem-endpoint wire shapes (spec B —
// GET /amicode/problems, /amicode/problem, /amicode/run-status served by
// packages/opencode/src/server/amicode/problems.ts). Pure, tolerant parsing +
// display derivations (chips, pending merge, run chip, rail failure states,
// entity-view rows). Same defensive style as ./vaults.ts: typeof checks on
// every field, drop non-conforming array entries, never throw. JSX-free so it
// is directly testable under `bun test`.
import { entityLabel } from "./receipt"
import { compactValue, formatSci } from "./facets"

// --- view types --------------------------------------------------------------

export type ProblemSummary = {
  slug: string
  name: string
  status: string
  recorded?: string
  entityKinds: string[]
}
export type ProblemsView = { ok: boolean; active?: string; problems: ProblemSummary[]; error?: string }

export type EventView = {
  seq: number
  ts?: string
  entity: string
  action: string
  diff?: Record<string, { from: unknown; to: unknown }>
  source?: { tool?: string; stage?: string }
}
export type RunRefView = { runId: string; lab?: string; tier?: string; recorded?: string }
export type ProblemView = {
  ok: boolean
  name?: string
  slug?: string
  status?: string
  entities: Record<string, Record<string, unknown>>
  scoreStages: string[]
  events: EventView[]
  runs: RunRefView[]
  error?: string
}
export type RunStatusView = {
  runId: string
  status: "solving" | "finished" | "failed" | "stalled" | "stopped" | "aborted"
  fidelity: number | null
  iteration: number | null
}
export type Chip = { kind: string; label: string; text?: string; pending: boolean }
export type RailState =
  | { kind: "loading" }
  | { kind: "ready"; view: ProblemView; stale: boolean }
  | { kind: "unavailable"; error?: string }

// --- wire parsers ------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

export function parseProblemsResponse(raw: unknown): ProblemsView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, problems: [], error: "bad_shape: response is not an object" }
  const data = raw as Record<string, unknown>
  if (data.ok !== true) {
    const error = str(data.error) ?? "problem endpoint reported a failure"
    return { ok: false, problems: [], error }
  }
  const problems = (Array.isArray(data.problems) ? data.problems : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .map(
      (entry): ProblemSummary => ({
        slug: str(entry.slug) ?? "(unknown)",
        name: str(entry.name) ?? str(entry.slug) ?? "(unknown)",
        status: str(entry.status) ?? "designing",
        recorded: str(entry.recorded),
        entityKinds: Array.isArray(entry.entity_kinds)
          ? entry.entity_kinds.filter((k): k is string => typeof k === "string")
          : [],
      }),
    )
  return { ok: true, active: str(data.active), problems }
}

export function parseProblemResponse(raw: unknown): ProblemView {
  const empty = { entities: {}, scoreStages: [], events: [], runs: [] }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, ...empty, error: "bad_shape: response is not an object" }
  const data = raw as Record<string, unknown>
  if (data.ok !== true) return { ok: false, ...empty, error: str(data.error) ?? "problem endpoint reported a failure" }
  const problem = (typeof data.problem === "object" && data.problem !== null ? data.problem : {}) as Record<
    string,
    unknown
  >
  const entities: Record<string, Record<string, unknown>> = {}
  if (typeof data.entities === "object" && data.entities !== null)
    for (const [kind, value] of Object.entries(data.entities as Record<string, unknown>))
      entities[kind] = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const events = (Array.isArray(data.events) ? data.events : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.seq === "number" && typeof entry.entity === "string")
    .map(
      (entry): EventView => ({
        seq: entry.seq as number,
        ts: str(entry.ts),
        entity: entry.entity as string,
        action: str(entry.action) ?? "",
        diff:
          typeof entry.diff === "object" && entry.diff !== null
            ? (entry.diff as Record<string, { from: unknown; to: unknown }>)
            : undefined,
        source:
          typeof entry.source === "object" && entry.source !== null
            ? (entry.source as { tool?: string; stage?: string })
            : undefined,
      }),
    )
  const runs = (Array.isArray(data.runs) ? data.runs : [])
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter((entry) => typeof entry.run_id === "string")
    .map(
      (entry): RunRefView => ({
        runId: entry.run_id as string,
        lab: str(entry.lab),
        tier: str(entry.tier),
        recorded: str(entry.recorded),
      }),
    )
  return {
    ok: true,
    name: str(problem.name),
    slug: str(problem.slug),
    status: str(problem.status),
    entities,
    scoreStages: (Array.isArray(data.score_stages) ? data.score_stages : []).filter(
      (k): k is string => typeof k === "string",
    ),
    events,
    runs,
  }
}

export function parseRunStatusResponse(raw: unknown): RunStatusView[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return []
  const data = raw as Record<string, unknown>
  if (data.ok !== true || !Array.isArray(data.runs)) return []
  return data.runs
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .filter(
      (entry) =>
        typeof entry.run_id === "string" &&
        (entry.status === "solving" ||
          entry.status === "finished" ||
          entry.status === "failed" ||
          entry.status === "stalled" ||
          entry.status === "stopped" ||
          entry.status === "aborted"),
    )
    .map(
      (entry): RunStatusView => ({
        runId: entry.run_id as string,
        status: entry.status as RunStatusView["status"],
        fidelity: typeof entry.fidelity === "number" ? entry.fidelity : null,
        iteration: typeof entry.iteration === "number" ? entry.iteration : null,
      }),
    )
}

// --- chips -------------------------------------------------------------------

const CHIP_ORDER = ["system", "formulation", "run", "device_session", "calibration"]

function shortValue(value: unknown): string {
  return compactValue(value) // spec §4: array/object-aware, never a JSON blob
}

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
  if (kind === "run") return undefined // run chip text comes from runChipText
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

/** Present chips in canonical-then-first-seen order, then dimmed pending chips
 *  for score stages not yet recorded (the path ahead, filled left to right). */
export function mergeChips(entities: Record<string, Record<string, unknown>>, scoreStages: string[]): Chip[] {
  const present = Object.keys(entities)
  const ordered = [
    ...CHIP_ORDER.filter((kind) => present.includes(kind)),
    ...present.filter((kind) => !CHIP_ORDER.includes(kind)),
  ]
  const chips: Chip[] = ordered.map((kind) => ({
    kind,
    label: entityLabel(kind),
    text: chipText(kind, entities[kind]),
    pending: false,
  }))
  for (const kind of scoreStages) {
    if (present.includes(kind)) continue
    chips.push({ kind, label: entityLabel(kind), pending: true })
  }
  return chips
}

// --- run chip ----------------------------------------------------------------

function formatFidelity(value: number): string {
  // 4 decimals for ordinary values (trailing zeros trimmed) — but NEVER let
  // rounding collapse a near-unity or near-zero fidelity into exactly "1"/"0":
  // the gap from perfect IS the result (Kate 2026-07-28, a 0.99997 run showed
  // "F = 1"). Precision extends one digit at a time until the gap survives,
  // capped at 10; only a true 1 or 0 renders bare.
  if (value === 1 || value === 0) return String(value)
  for (let digits = 4; digits <= 10; digits++) {
    const rounded = Number(value.toFixed(digits))
    if (rounded !== 1 && rounded !== 0) return String(rounded)
  }
  return String(value)
}

export function runChipText(statuses: RunStatusView[]): string | undefined {
  if (statuses.length === 0) return undefined
  const solving = [...statuses].reverse().find((s) => s.status === "solving")
  if (solving) {
    const f = solving.fidelity
    // wire carries the raw objective f (≈ infidelity) for solving runs; only
    // render F = 1 - f when f plausibly IS an infidelity (result.toml's
    // finished fidelity needs no transform)
    if (f !== null && f >= 0 && f <= 1) return `solving… F=${formatFidelity(1 - f)}`
    return "solving…"
  }
  const finished = [...statuses].reverse().find((s) => s.status === "finished")
  if (finished && finished.fidelity !== null) {
    const iter = finished.iteration !== null ? ` · ${finished.iteration} iter` : ""
    return `F=${formatFidelity(finished.fidelity)}${iter}`
  }
  if (finished) return "finished"
  const stalled = [...statuses].reverse().find((s) => s.status === "stalled")
  if (stalled) return stalled.iteration !== null ? `stalled · iter ${stalled.iteration}` : "stalled"
  // A deliberate user stop/abort is a successful action — it must never read
  // as "failed" or vanish from the rail (one-spine: run-terminal.ts).
  const stopped = [...statuses].reverse().find((s) => s.status === "stopped" || s.status === "aborted")
  if (stopped) return stopped.status
  return "failed"
}

// --- run verdict (ring-2 Run dialog hero) ------------------------------------

export type RunVerdict = {
  /** formatted fidelity F, or null when the status carries no usable number */
  fidelity: string | null
  status: RunStatusView["status"] | "recorded"
  iteration: number | null
  tier: string | null
}

/** Verdict for the latest run of the active problem — fidelity + status +
 *  iteration + tier — the fact the Run dialog used to omit while the inline
 *  chip showed it. Prefers the live run-status entry matching the latest run
 *  ref, falls back to the last status, then to a bare "recorded" when only a
 *  run ref exists. Null when there are no runs at all (→ no hero). Fidelity
 *  conventions mirror runChipText: finished = raw F, solving = 1 - f. */
export function runVerdict(statuses: RunStatusView[], runs: RunRefView[]): RunVerdict | null {
  const latestRef = runs.length > 0 ? runs[runs.length - 1] : undefined
  const tier = latestRef ? (latestRef.tier ?? "vetted") : null
  let status: RunStatusView | undefined
  if (latestRef) status = statuses.find((s) => s.runId === latestRef.runId)
  if (!status && statuses.length > 0) status = statuses[statuses.length - 1]
  if (!status) return latestRef ? { fidelity: null, status: "recorded", iteration: null, tier } : null
  let fidelity: string | null = null
  if (status.status === "solving") {
    if (status.fidelity !== null && status.fidelity >= 0 && status.fidelity <= 1)
      fidelity = formatFidelity(1 - status.fidelity)
  } else if (status.fidelity !== null) {
    fidelity = formatFidelity(status.fidelity)
  }
  return { fidelity, status: status.status, iteration: status.iteration, tier }
}

// --- device verdict (ring-2 Device dialog hero) ------------------------------
// device_session has no dedicated schema yet (real entities carry only
// pulse_ref/run_dir/note). This reads the PROPOSED v2 fields (connection /
// provider / ready / queue) when present and always surfaces the real pulse/run
// linkage — design-leads-schema-follows. Returns null only for an empty entity.

export type DeviceVerdict = {
  connection: "online" | "offline" | "maintenance" | null
  provider: string | null
  ready: boolean | null
  queue: string | null
  pulseRef: string | null
  runDir: string | null
  note: string | null
}

export function deviceVerdict(entity: Record<string, unknown>): DeviceVerdict | null {
  if (!entity || Object.keys(entity).length === 0) return null
  let connection: DeviceVerdict["connection"] = null
  const statusStr = str(entity.status)
  if (statusStr === "online" || statusStr === "offline" || statusStr === "maintenance") connection = statusStr
  else if (typeof entity.online === "boolean") connection = entity.online ? "online" : "offline"
  const provider = str(entity.provider) ?? null
  const ready = typeof entity.ready === "boolean" ? entity.ready : null
  const queue =
    str(entity.queue) ?? (typeof entity.queue === "number" ? `${entity.queue} in queue` : null)
  const pulseRef = str(entity.pulse_ref) ?? null
  const runDir = str(entity.run_dir) ?? null
  const note = str(entity.note) ?? str(entity.notes) ?? null
  if (connection === null && !provider && ready === null && !queue && !pulseRef && !runDir && !note) return null
  return { connection, provider, ready, queue, pulseRef, runDir, note }
}

// --- calibration verdict (ring-2 Calibration dialog hero) --------------------
// No calibration entity or schema exists in Phase 0 (amico-catalog: `calibrated`
// lands later). This reads the PROPOSED fields (a timestamp + source) and
// derives a freshness verdict; nowMs is injected for testability. Returns null
// when there is no timestamp and no source → the dialog falls back to the raw
// field table.

export type CalibrationVerdict = {
  freshness: "fresh" | "stale" | null
  ageLabel: string | null
  source: string | null
  calibratedAt: string | null
}

/** Proposed heuristic until real calibration validity windows exist: ≤12h fresh. */
const CALIB_FRESH_MS = 12 * 60 * 60 * 1000

function relAge(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 48) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

export function calibrationVerdict(entity: Record<string, unknown>, nowMs: number): CalibrationVerdict | null {
  if (!entity || Object.keys(entity).length === 0) return null
  const calibratedAt =
    str(entity.calibrated) ?? str(entity.calibrated_at) ?? str(entity.recorded) ?? str(entity.timestamp) ?? null
  const source = str(entity.source) ?? str(entity.device) ?? str(entity.provider) ?? str(entity.lab) ?? null
  let freshness: CalibrationVerdict["freshness"] = null
  let ageLabel: string | null = null
  if (calibratedAt) {
    const ms = Date.parse(calibratedAt)
    if (Number.isFinite(ms)) {
      const age = nowMs - ms
      freshness = age <= CALIB_FRESH_MS ? "fresh" : "stale"
      ageLabel = relAge(age)
    }
  }
  if (freshness === null && !source && !calibratedAt) return null
  return { freshness, ageLabel, source, calibratedAt }
}

// --- rail state --------------------------------------------------------------

export function railState(current: ProblemView | undefined, lastGood: ProblemView | undefined): RailState {
  if (current === undefined) return { kind: "loading" }
  if (current.ok) return { kind: "ready", view: current, stale: false }
  if (lastGood?.ok) return { kind: "ready", view: lastGood, stale: true }
  return { kind: "unavailable", error: current.error }
}

// --- entity view helpers -------------------------------------------------------

export type EntityRow = { key: string; value: string }

/** Field/label humanizer for the entity view: last dotted segment, underscores
 *  to spaces, sentence case — `params.drive_max` → "Drive max", `problem_type`
 *  → "Problem type". Presentation only; the raw key is still shown alongside. */
export function humanizeKey(key: string): string {
  const raw = (key.split(".").pop() ?? key).replaceAll("_", " ").trim()
  if (!raw) return key
  return raw.charAt(0).toUpperCase() + raw.slice(1)
}

/** The dotted prefix of a flattened row key (the group it belongs to), or
 *  undefined for a top-level scalar. `params.drive_max` → "params". */
export function fieldGroup(key: string): string | undefined {
  const dot = key.indexOf(".")
  return dot === -1 ? undefined : key.slice(0, dot)
}

/** Stable field rows: scalars in object order, one level of object nesting
 *  flattened to dotted keys, undefined skipped. */
export function entityRows(entity: Record<string, unknown>): EntityRow[] {
  // composite system (spec-20260709): a components[] array → component-table +
  // coupling-list rows instead of one JSON blob. Defensive; legacy flat falls through.
  if (Array.isArray(entity.components)) return compositeSystemRows(entity)
  const rows: EntityRow[] = []
  for (const [key, value] of Object.entries(entity)) {
    if (value === undefined) continue
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        if (innerValue === undefined) continue
        rows.push({ key: `${key}.${inner}`, value: shortValue(innerValue) })
      }
      continue
    }
    rows.push({ key, value: shortValue(value) })
  }
  return rows
}

export function historyRows(events: EventView[], kind: string): EventView[] {
  return events.filter((event) => event.entity === kind).sort((a, b) => b.seq - a.seq)
}

/** Draft-only edit-in-chat prompt: trailing space so the user types the value. */
export function editPromptText(kind: string, key: string, value: unknown): string {
  const bare = key.split(".").pop() ?? key
  return `Change the ${kind} ${bare} (currently ${shortValue(value)}) to `
}

// --- composite system display (spec-20260709 §3) -----------------------------
// All of the below parse BOTH the flat-legacy and composite shapes defensively
// in place — this fork repo cannot import the plugin-side normalizeSystem, so
// tolerance lives in the reader (spec §3 cross-repo note). Never throw.

const paramBits = (params: unknown): string[] => {
  if (typeof params !== "object" || params === null) return []
  return Object.entries(params as Record<string, unknown>).map(([k, v]) => `${k}=${shortValue(v)}`)
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

/** Component-table + coupling-list rows for a composite system entity. */
export function compositeSystemRows(entity: Record<string, unknown>): EntityRow[] {
  const rows: EntityRow[] = []
  const platform = str(entity.platform)
  if (platform) rows.push({ key: "platform", value: platform })
  const driveArch =
    entity.drive && typeof entity.drive === "object" ? str((entity.drive as Record<string, unknown>).arch) : undefined
  if (driveArch) rows.push({ key: "drive", value: driveArch })
  if (typeof entity.topology === "string") rows.push({ key: "topology", value: entity.topology })
  for (const c of (Array.isArray(entity.components) ? entity.components : []) as Record<string, unknown>[]) {
    const bits = [
      str(c.role),
      typeof c.levels === "number" ? `${c.levels} lvl` : undefined,
      ...paramBits(c.params),
    ].filter((b): b is string => Boolean(b))
    rows.push({ key: `component ${str(c.id) ?? "?"}`, value: bits.join(", ") || "—" })
  }
  for (const cp of (Array.isArray(entity.couplings) ? entity.couplings : []) as Record<string, unknown>[]) {
    const between = Array.isArray(cp.between) ? (cp.between as unknown[]).map(String).join("↔") : ""
    const params = paramBits(cp.params).join(", ")
    rows.push({ key: `coupling ${between}`, value: `${str(cp.kind) ?? "?"}${params ? ` (${params})` : ""}` })
  }
  if (typeof entity.notes === "string") rows.push({ key: "notes", value: entity.notes })
  return rows
}

export interface SystemProjection {
  platform?: string
  driveArch?: string
  topology?: string
  components: { id: string; role: string; levels?: number; params: Record<string, number> }[]
  couplings: { between: string[]; kind: string; params: Record<string, number> }[]
  /** The model the researcher CONFIRMED, term by term (amicode_set_model's
   *  `hamiltonian`). Present → the card renders exactly this; absent → it falls
   *  back to a canonical form for the platform and labels it as inferred. */
  hamiltonian?: { terms: HamiltonianTermProjection[]; notes?: string }
  notes?: string
  /** false = a legacy FLAT entity read-collapsed to N=1 (no couplings). */
  isComposite: boolean
}

export interface HamiltonianTermProjection {
  kind: string
  latex: string
  acts_on?: string[]
  label?: string
}

const asNumberRecord = (v: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (typeof v === "object" && v !== null) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === "number") out[k] = val
  }
  return out
}

/** Recorded Hamiltonian, tolerant of raw JSON: a term without usable `latex` is
 *  dropped rather than rendered as a hole, and an empty result reads as "nothing
 *  recorded" so the card falls back to inference instead of showing `Ĥ/ℏ = `. */
const asHamiltonian = (v: unknown): SystemProjection["hamiltonian"] => {
  if (typeof v !== "object" || v === null) return undefined
  const raw = v as Record<string, unknown>
  if (!Array.isArray(raw.terms)) return undefined
  const terms = (raw.terms as Record<string, unknown>[])
    .filter((t) => t && typeof t.latex === "string" && t.latex.trim() !== "")
    .map((t) => ({
      kind: typeof t.kind === "string" ? t.kind : "drift",
      latex: t.latex as string,
      ...(Array.isArray(t.acts_on) ? { acts_on: (t.acts_on as unknown[]).map(String) } : {}),
      ...(typeof t.label === "string" ? { label: t.label } : {}),
    }))
  return terms.length === 0 ? undefined : { terms, ...(typeof raw.notes === "string" ? { notes: raw.notes } : {}) }
}

/** Structured projection for the entity view (spec §3 point 3). Composite → read
 *  through; legacy flat → collapse to N=1 in place (role from platform: rydberg→atom
 *  else qubit — mirrors normalizeSystem without importing it). Never throws. */
export function systemProjection(input: Record<string, unknown>): SystemProjection {
  const entity = (input ?? {}) as Record<string, unknown>
  const platform = str(entity.platform)
  const driveArch =
    entity.drive && typeof entity.drive === "object" ? str((entity.drive as Record<string, unknown>).arch) : undefined
  if (Array.isArray(entity.components)) {
    return {
      platform,
      driveArch,
      topology: typeof entity.topology === "string" ? entity.topology : undefined,
      components: (entity.components as Record<string, unknown>[]).map((c) => ({
        id: str(c.id) ?? "?",
        role: str(c.role) ?? "?",
        ...(typeof c.levels === "number" ? { levels: c.levels } : {}),
        params: asNumberRecord(c.params),
      })),
      couplings: (Array.isArray(entity.couplings) ? (entity.couplings as Record<string, unknown>[]) : []).map((cp) => ({
        between: Array.isArray(cp.between) ? (cp.between as unknown[]).map(String) : [],
        kind: str(cp.kind) ?? "?",
        params: asNumberRecord(cp.params),
      })),
      ...(asHamiltonian(entity.hamiltonian) ? { hamiltonian: asHamiltonian(entity.hamiltonian) } : {}),
      ...(typeof entity.notes === "string" ? { notes: entity.notes } : {}),
      isComposite: true,
    }
  }
  // legacy flat → N=1
  const role = platform?.toLowerCase() === "rydberg" ? "atom" : "qubit"
  const comp: SystemProjection["components"][number] = { id: "q1", role, params: asNumberRecord(entity.params) }
  if (typeof entity.levels === "number") comp.levels = entity.levels
  return {
    platform,
    driveArch: driveArch ?? (platform?.toLowerCase() === "rydberg" ? "global" : "per-component"),
    components: [comp],
    couplings: [],
    ...(typeof entity.notes === "string" ? { notes: entity.notes } : {}),
    isComposite: false,
  }
}

// --- formulation projection (spec §6.2) --------------------------------------
// Dual-shape (legacy free-form OR structured facets). The fork CANNOT import the
// plugin's normalizeFormulation, so this re-implements the §10 mapping IN PLACE,
// pinned by the shared fixture corpus (formulation-projection.test.ts). Never
// throws; unknown enums pass through raw.

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

/** Compact an ISO timestamp for the entity-view ("2026-07-10T15:53:30.450Z" →
 *  "07-10 15:53") — the full ISO is wide and clips the dialog. Non-ISO passes through. */
export function formatTs(ts: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(ts)
  return m ? `${m[2]}-${m[3]} ${m[4]}` : ts
}

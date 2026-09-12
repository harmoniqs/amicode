// facets.ts — pure, dependency-free rendering helpers for the amicode entity
// visualization language (spec-20260709 §4). No SolidJS, no imports.

/** Physicists' number formatter for display. Drive/detuning bounds are integer
 *  multiples of π, so 125.66370614359172 → "40π", 62.83… → "20π"; other values
 *  trim to ~4 significant figures with trailing zeros dropped (0.2 → "0.2",
 *  28.9 → "28.9"). Keeps the full float out of chips, tables, and history. */
export function formatSci(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return "0"
  const ratio = value / Math.PI
  const n = Math.round(ratio)
  if (n !== 0 && Math.abs(ratio - n) < 1e-6) return n === 1 ? "π" : n === -1 ? "-π" : `${n}π`
  return String(Number(value.toPrecision(4)))
}

/** Array/object-aware compact renderer. Replaces the JSON.stringify branch that
 *  the old short()/shortValue() used, so a components[]/constraints[] value never
 *  becomes a raw blob. Scalars pass through; arrays → "N items" (+ head id/kind if
 *  present); objects → compact "k:v · k:v" (first few keys). Never throws. */
export function compactValue(value: unknown): string {
  if (value === null || value === undefined) return "—"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return "none"
    const head = value
      .slice(0, 3)
      .map((v) => (v && typeof v === "object" ? headLabel(v as Record<string, unknown>) : String(v)))
      .filter(Boolean)
      .join(", ")
    return value.length <= 3 ? head : `${value.length} items (${head}…)`
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 3)
      .map(([k, v]) => `${k}:${typeof v === "object" ? "…" : String(v)}`)
    return entries.join(" · ") || "{}"
  }
  return "—"
}

/** Best label for one object in an array: id → kind → between → first string field. */
function headLabel(o: Record<string, unknown>): string {
  for (const k of ["id", "kind", "between", "name"]) {
    const v = o[k]
    if (typeof v === "string" && v) return v
    if (Array.isArray(v) && v.length) return v.map(String).join("↔")
  }
  return "item"
}

export type FieldChange = { field: string; from: unknown; to: unknown }
export type SetDiff<T> = { added: T[]; removed: T[]; changed: { key: string; item: T; changes: FieldChange[] }[] }

/** Set delta by a UNIQUE key (keyFn MUST be unique within the set — for
 *  objectives/constraints use `kind:(label??index)`; kind alone collides). */
export function setDiff<T>(from: T[], to: T[], keyFn: (t: T, i: number) => string): SetDiff<T> {
  const fromMap = new Map(from.map((t, i) => [keyFn(t, i), t]))
  const toMap = new Map(to.map((t, i) => [keyFn(t, i), t]))
  const added = [...toMap].filter(([k]) => !fromMap.has(k)).map(([, t]) => t)
  const removed = [...fromMap].filter(([k]) => !toMap.has(k)).map(([, t]) => t)
  const changed: SetDiff<T>["changed"] = []
  for (const [k, toItem] of toMap) {
    const fromItem = fromMap.get(k)
    if (fromItem === undefined) continue
    const changes = flatFieldChanges(fromItem, toItem)
    if (changes.length) changed.push({ key: k, item: toItem, changes })
  }
  return { added, removed, changed }
}

/** One-level-deep field comparison (dotted keys for nested params). */
function flatFieldChanges(a: unknown, b: unknown, prefix = ""): FieldChange[] {
  const out: FieldChange[] = []
  const ao = (a ?? {}) as Record<string, unknown>
  const bo = (b ?? {}) as Record<string, unknown>
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    const av = ao[k],
      bv = bo[k]
    const field = prefix ? `${prefix}.${k}` : k
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av)) {
      out.push(...flatFieldChanges(av, bv, field))
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ field, from: av, to: bv })
    }
  }
  return out
}

export type Badge = { label: string; value: string; tone?: "neutral" | "active" }

const badgeStr = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined)

/** Mode facets → badges. Defensive over a loose record (serves both System
 *  drive/topology and Formulation trajectory/time/param/robustness/flags).
 *  Skips none-robustness, false flags, and the "fixed" time default. */
export function modeBadges(p: Record<string, unknown>): Badge[] {
  const out: Badge[] = []
  const tt = badgeStr(p.trajectory_type)
  if (tt) out.push({ label: "type", value: tt })
  const pm = badgeStr(p.parameterization)
  if (pm) out.push({ label: "pulse", value: pm.replace(/_/g, "-") })
  const tm = badgeStr(p.time_mode)
  if (tm && tm !== "fixed") out.push({ label: "time", value: tm.replace(/_/g, "-"), tone: "active" })
  const rob =
    p.robustness && typeof p.robustness === "object"
      ? badgeStr((p.robustness as Record<string, unknown>).kind)
      : undefined
  if (rob && rob !== "none") out.push({ label: "robust", value: rob, tone: "active" })
  if (p.free_phase === true) out.push({ label: "free-phase", value: "", tone: "active" })
  if (p.leakage === true) out.push({ label: "leakage", value: "", tone: "active" })
  // System modes share the badge language.
  const drive =
    p.drive && typeof p.drive === "object" ? badgeStr((p.drive as Record<string, unknown>).arch) : undefined
  if (drive) out.push({ label: "drive", value: drive })
  const topo = badgeStr(p.topology)
  if (topo) out.push({ label: "topology", value: topo })
  return out
}

// ---- receipt piece builders (spec §5) --------------------------------------
// The receipt sees only the diff (from/to per key), not the full entity.

export type DiffMap = Record<string, { from: unknown; to: unknown }>
export type ReceiptPiece = { text: string; tone: "add" | "remove" | "change" }
/** chip = render the post-state compositeChip (creation / large / elided);
 *  pieces = a semantic delta. The card owns turning `entity` into a chip
 *  (via problem.ts compositeChip) — kept out of here to avoid an import cycle. */
export type EntityReceipt = { kind: "chip"; entity: Record<string, unknown> } | { kind: "pieces"; pieces: ReceiptPiece[] }

const ELIDED = "…"

function describeComponent(item: Record<string, unknown>): string {
  const bits = [item.role, typeof item.levels === "number" ? `${item.levels}lvl` : undefined].filter(Boolean).join("·")
  return `${item.id ?? "?"}${bits ? ` (${bits})` : ""}`
}
function describeCoupling(item: Record<string, unknown>): string {
  const between = Array.isArray(item.between) ? item.between.map(String).join("↔") : "?"
  return `${between} ${item.kind ?? ""}`.trim()
}
function setDotted(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".")
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

/** System diff → semantic pieces, or a post-state chip on creation/large/elided.
 *  `components`/`couplings` diff via setDiff (add/remove/param-change); other keys
 *  render as `key old→new`. Pure; never throws. */
export function systemReceiptPieces(diff: DiffMap): EntityReceipt {
  const keys = Object.keys(diff)
  const elided = keys.includes(ELIDED) || Object.values(diff).some((e) => e.to === ELIDED || e.from === ELIDED)
  const comp = diff["components"]
  const isCreation =
    !!comp && (comp.from === null || comp.from === undefined || (Array.isArray(comp.from) && comp.from.length === 0))

  const pieces: ReceiptPiece[] = []
  for (const [key, entry] of Object.entries(diff)) {
    if (key === ELIDED) continue
    if (key === "components" || key === "couplings") {
      const from = (Array.isArray(entry.from) ? entry.from : []) as Record<string, unknown>[]
      const to = (Array.isArray(entry.to) ? entry.to : []) as Record<string, unknown>[]
      const keyFn =
        key === "components"
          ? (c: Record<string, unknown>) => String(c.id)
          : (c: Record<string, unknown>) => `${(Array.isArray(c.between) ? c.between : []).join("↔")}:${c.kind}`
      const describe = key === "components" ? describeComponent : describeCoupling
      const d = setDiff(from, to, keyFn)
      for (const a of d.added) pieces.push({ text: `+ ${describe(a)}`, tone: "add" })
      for (const r of d.removed) pieces.push({ text: `− ${describe(r)}`, tone: "remove" })
      for (const c of d.changed)
        for (const ch of c.changes)
          pieces.push({ text: `${c.key} ${ch.field.split(".").pop()} ${compactValue(ch.from)}→${compactValue(ch.to)}`, tone: "change" })
    } else {
      pieces.push({ text: `${key.split(".").pop()} ${compactValue(entry.from)}→${compactValue(entry.to)}`, tone: "change" })
    }
  }

  if (isCreation || elided || pieces.length > 4) {
    const entity: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(diff)) {
      if (key === ELIDED || entry.to === ELIDED) continue
      setDotted(entity, key, entry.to)
    }
    return { kind: "chip", entity }
  }
  return { kind: "pieces", pieces }
}

const FORM_MODE_TAG: Record<string, string> = {
  trajectory_type: "type",
  time_mode: "time",
  parameterization: "pulse",
  "robustness.kind": "robust",
}

/** Formulation diff → semantic pieces, or a post-state chip on creation/large/
 *  elided. Modes render as `tag: from → to`, flags as `+/− flag`, objectives/
 *  constraints via setDiff, everything else `key old→new`. Pure; never throws. */
export function formulationReceiptPieces(diff: DiffMap): EntityReceipt {
  const keys = Object.keys(diff)
  const elided = keys.includes(ELIDED) || Object.values(diff).some((e) => e.to === ELIDED || e.from === ELIDED)
  const tt = diff["trajectory_type"]
  const isCreation = !!tt && (tt.from === null || tt.from === undefined)

  const pieces: ReceiptPiece[] = []
  for (const [key, entry] of Object.entries(diff)) {
    if (key === ELIDED) continue
    if (key === "objectives" || key === "constraints") {
      const from = (Array.isArray(entry.from) ? entry.from : []) as Record<string, unknown>[]
      const to = (Array.isArray(entry.to) ? entry.to : []) as Record<string, unknown>[]
      const keyFn = (t: Record<string, unknown>, i: number) => `${t.kind}:${t.label ?? i}`
      const d = setDiff(from, to, keyFn)
      for (const a of d.added) pieces.push({ text: `+ ${a.label ?? a.kind}`, tone: "add" })
      for (const r of d.removed) pieces.push({ text: `− ${r.label ?? r.kind}`, tone: "remove" })
      for (const c of d.changed)
        for (const ch of c.changes)
          pieces.push({ text: `${c.key.split(":")[0]} ${ch.field.split(".").pop()} ${compactValue(ch.from)}→${compactValue(ch.to)}`, tone: "change" })
    } else if (key === "free_phase" || key === "leakage") {
      const flag = key.replace(/_/g, "-")
      if (entry.to === true) pieces.push({ text: `+ ${flag}`, tone: "add" })
      else if (entry.to === false) pieces.push({ text: `− ${flag}`, tone: "remove" })
    } else if (key in FORM_MODE_TAG) {
      pieces.push({ text: `${FORM_MODE_TAG[key]}: ${compactValue(entry.from)} → ${compactValue(entry.to)}`, tone: "change" })
    } else {
      pieces.push({ text: `${key.split(".").pop()} ${compactValue(entry.from)}→${compactValue(entry.to)}`, tone: "change" })
    }
  }

  if (isCreation || elided || pieces.length > 4) {
    const entity: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(diff)) {
      if (key === ELIDED || entry.to === ELIDED) continue
      setDotted(entity, key, entry.to)
    }
    return { kind: "chip", entity }
  }
  return { kind: "pieces", pieces }
}

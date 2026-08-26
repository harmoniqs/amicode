// AMICODE (widget kernel): client-side wire parsers for GET /amicode/widgets
// and GET|POST /amicode/dashboard, plus the config-form model generated from
// a widget's manifest schema. JSX-free, defensive (problems.ts discipline:
// one schema per route, never throw), unit-tested.

export type ConfigFieldWire =
  | { type: "boolean"; default: boolean }
  | { type: "select"; options: string[]; default: string }
  | { type: "multi-select"; options: string[]; default: string[] }
  | { type: "string"; default: string; max_length?: number }
  | { type: "number"; default: number; min?: number; max?: number }

export interface WidgetInfo {
  id: string
  name: string
  version: string
  bridge: number
  description: string
  size: "hero" | "tile"
  height: number
  config: Record<string, ConfigFieldWire>
  builtin: boolean
  overridden: boolean
  hash: string
  path: string | null
}

export interface DashboardEntry {
  key: string
  id: string
  hidden: boolean
  config: Record<string, unknown>
  missing?: boolean
  /** reserved-key pass-through (spec T3.6): group, view, … survive the client round-trip */
  [reserved: string]: unknown
}

export interface DashboardState {
  version: 1
  widget: DashboardEntry[]
  /** reserved top-level keys (spec T3.6): views, scope */
  [reserved: string]: unknown
}

const CLIENT_CORE_ENTRY_KEYS = new Set(["key", "id", "hidden", "config", "missing"])
const CLIENT_RESERVED_TOP_KEYS = ["views", "scope"] as const

const FIELD_TYPES = new Set(["boolean", "select", "multi-select", "string", "number"])

function parseConfigSchema(raw: unknown): Record<string, ConfigFieldWire> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, ConfigFieldWire> = {}
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val !== "object" || val === null) continue
    const f = val as Record<string, unknown>
    if (typeof f.type !== "string" || !FIELD_TYPES.has(f.type)) continue
    out[key] = f as unknown as ConfigFieldWire
  }
  return out
}

export function parseWidgetsResponse(raw: unknown): WidgetInfo[] {
  if (typeof raw !== "object" || raw === null) return []
  const data = raw as { ok?: unknown; widgets?: unknown }
  if (data.ok !== true || !Array.isArray(data.widgets)) return []
  return data.widgets
    .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
    .filter((w) => typeof w.id === "string" && typeof w.name === "string")
    .map((w) => ({
      id: w.id as string,
      name: w.name as string,
      version: typeof w.version === "string" ? w.version : "0.0.0",
      bridge: typeof w.bridge === "number" ? w.bridge : 1,
      description: typeof w.description === "string" ? w.description : "",
      size: w.size === "hero" ? "hero" : "tile",
      height: typeof w.height === "number" && w.height > 0 ? w.height : 96,
      config: parseConfigSchema(w.config),
      builtin: w.builtin === true,
      overridden: w.overridden === true,
      hash: typeof w.hash === "string" ? w.hash : "",
      path: typeof w.path === "string" ? w.path : null,
    }))
}

export function parseDashboardResponse(raw: unknown): DashboardState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const data = raw as { ok?: unknown; dashboard?: unknown }
  if (data.ok !== true || typeof data.dashboard !== "object" || data.dashboard === null) return undefined
  const d = data.dashboard as { widget?: unknown }
  if (!Array.isArray(d.widget)) return undefined
  const widget: DashboardEntry[] = d.widget
    .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
    .filter((e) => typeof e.id === "string")
    .map((e) => {
      // T3.6: unrecognized keys pass through so a grid save can't erase them
      const passthrough: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(e)) if (!CLIENT_CORE_ENTRY_KEYS.has(k)) passthrough[k] = v
      return {
        ...passthrough,
        key: typeof e.key === "string" ? e.key : (e.id as string),
        id: e.id as string,
        hidden: e.hidden === true,
        config: typeof e.config === "object" && e.config !== null ? (e.config as Record<string, unknown>) : {},
        ...(e.missing === true ? { missing: true } : {}),
      }
    })
  const state: DashboardState = { version: 1, widget }
  for (const k of CLIENT_RESERVED_TOP_KEYS) {
    const v = (data.dashboard as Record<string, unknown>)[k]
    if (v !== undefined) state[k] = v
  }
  return state
}

// --- config form model -------------------------------------------------------

export type FormField =
  | { key: string; kind: "boolean"; value: boolean }
  | { key: string; kind: "select"; options: string[]; value: string }
  | { key: string; kind: "multi-select"; options: string[]; value: string[] }
  | { key: string; kind: "string"; value: string; maxLength?: number }
  | { key: string; kind: "number"; value: number; min?: number; max?: number }

/** Build the ⚙-form model: one entry per schema field, current value = stored
 *  config where valid, else the field default. */
export function formModel(schema: Record<string, ConfigFieldWire>, config: Record<string, unknown>): FormField[] {
  const fields: FormField[] = []
  for (const [key, f] of Object.entries(schema)) {
    switch (f.type) {
      case "boolean":
        fields.push({ key, kind: "boolean", value: typeof config[key] === "boolean" ? (config[key] as boolean) : f.default })
        break
      case "select": {
        const v = config[key]
        fields.push({
          key,
          kind: "select",
          options: f.options,
          value: typeof v === "string" && f.options.includes(v) ? v : f.default,
        })
        break
      }
      case "multi-select": {
        const v = config[key]
        const valid = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && f.options.includes(x)) : []
        fields.push({ key, kind: "multi-select", options: f.options, value: valid.length > 0 ? valid : f.default })
        break
      }
      case "string": {
        const v = config[key]
        fields.push({
          key,
          kind: "string",
          value: typeof v === "string" ? v : f.default,
          ...(typeof f.max_length === "number" ? { maxLength: f.max_length } : {}),
        })
        break
      }
      case "number": {
        const v = config[key]
        fields.push({
          key,
          kind: "number",
          value: typeof v === "number" && Number.isFinite(v) ? v : f.default,
          ...(typeof f.min === "number" ? { min: f.min } : {}),
          ...(typeof f.max === "number" ? { max: f.max } : {}),
        })
        break
      }
    }
  }
  return fields
}

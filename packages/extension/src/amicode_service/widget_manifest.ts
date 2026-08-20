// AMICODE: widget manifest parse + validate (spec T2.1) and config-value
// sanitization (spec T2.5: bad values fall back to field defaults, never an
// error). Manifests are TOML (human/agent-authored, read via toml-lite);
// this module owns the schema rules so the registry, dashboard merge, and
// fork all validate one way.
import { parseTomlLite } from "./toml_lite"

export type ConfigField =
  | { type: "boolean"; default: boolean }
  | { type: "select"; options: string[]; default: string }
  | { type: "multi-select"; options: string[]; default: string[] }
  | { type: "string"; default: string; max_length?: number }
  | { type: "number"; default: number; min?: number; max?: number }

export interface WidgetManifest {
  id: string
  name: string
  version: string
  bridge: number
  description: string
  size: "hero" | "tile"
  height: number
  config: Record<string, ConfigField>
  origin: { session?: string; date?: string } | null
}

export type ManifestResult =
  | { ok: true; manifest: WidgetManifest; warning?: string }
  | { ok: false; error: string }

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

function bad(detail: string): ManifestResult {
  return { ok: false, error: `bad_manifest: ${detail}` }
}

function parseField(name: string, raw: Record<string, unknown>): ConfigField | string {
  const type = raw.type
  switch (type) {
    case "boolean": {
      const d = raw.default
      if (typeof d !== "boolean") return `${name}: boolean default required`
      return { type, default: d }
    }
    case "select": {
      const options = raw.options
      if (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== "string"))
        return `${name}: select requires string options`
      const d = raw.default
      if (typeof d !== "string" || !options.includes(d)) return `${name}: default must be one of options`
      return { type, options: options as string[], default: d }
    }
    case "multi-select": {
      const options = raw.options
      if (!Array.isArray(options) || options.length === 0 || options.some((o) => typeof o !== "string"))
        return `${name}: multi-select requires string options`
      const d = raw.default
      if (!Array.isArray(d) || d.some((v) => typeof v !== "string" || !(options as string[]).includes(v)))
        return `${name}: default must be a subset of options`
      return { type, options: options as string[], default: d as string[] }
    }
    case "string": {
      const d = raw.default
      if (typeof d !== "string") return `${name}: string default required`
      const max = raw.max_length
      if (max !== undefined && typeof max !== "number") return `${name}: max_length must be a number`
      return { type, default: d, ...(typeof max === "number" ? { max_length: max } : {}) }
    }
    case "number": {
      const d = raw.default
      if (typeof d !== "number") return `${name}: number default required`
      const min = raw.min
      const max = raw.max
      if ((min !== undefined && typeof min !== "number") || (max !== undefined && typeof max !== "number"))
        return `${name}: min/max must be numbers`
      if (typeof min === "number" && d < min) return `${name}: default below min`
      if (typeof max === "number" && d > max) return `${name}: default above max`
      return {
        type,
        default: d,
        ...(typeof min === "number" ? { min } : {}),
        ...(typeof max === "number" ? { max } : {}),
      }
    }
    default:
      return `${name}: unknown field type ${JSON.stringify(type)}`
  }
}

export function parseManifest(tomlSrc: string, dirname: string): ManifestResult {
  const parsed = parseTomlLite(tomlSrc)
  if (!parsed.ok) return bad(parsed.error)
  const v = parsed.value

  const id = v.id
  if (typeof id !== "string" || !KEBAB.test(id)) return bad("id must be kebab-case")
  if (id !== dirname) return bad(`id ${JSON.stringify(id)} must equal dirname ${JSON.stringify(dirname)}`)
  const name = v.name
  if (typeof name !== "string" || name.trim() === "") return bad("name required")

  // T3.6 forward-compat: unknown sizes (e.g. the reserved "strip") degrade to
  // tile with a warning instead of rejecting the widget — a newer widget must
  // render on an older host, not vanish.
  const rawSize = v.size ?? "tile"
  let sizeWarning: string | undefined
  let size: "hero" | "tile"
  if (rawSize === "hero" || rawSize === "tile") size = rawSize
  else {
    size = "tile"
    sizeWarning = `unknown size ${JSON.stringify(rawSize)} rendered as "tile"`
  }
  const bridge = v.bridge ?? 1
  if (typeof bridge !== "number" || !Number.isInteger(bridge) || bridge < 1) return bad("bridge must be a positive int")
  const height = v.height ?? 96
  if (typeof height !== "number" || height <= 0) return bad("height must be a positive number")

  const config: Record<string, ConfigField> = {}
  const rawConfig = v.config
  if (rawConfig !== undefined) {
    if (typeof rawConfig !== "object" || rawConfig === null || Array.isArray(rawConfig))
      return bad("config must be a table")
    for (const [key, rawField] of Object.entries(rawConfig as Record<string, unknown>)) {
      if (!KEBAB.test(key.replace(/_/g, "-"))) return bad(`config field ${key}: bad name`)
      if (typeof rawField !== "object" || rawField === null || Array.isArray(rawField))
        return bad(`config field ${key}: must be a table`)
      const field = parseField(key, rawField as Record<string, unknown>)
      if (typeof field === "string") return bad(field)
      config[key] = field
    }
  }

  const rawOrigin = v.origin
  const origin =
    typeof rawOrigin === "object" && rawOrigin !== null && !Array.isArray(rawOrigin)
      ? {
          session: typeof (rawOrigin as any).session === "string" ? ((rawOrigin as any).session as string) : undefined,
          date: typeof (rawOrigin as any).date === "string" ? ((rawOrigin as any).date as string) : undefined,
        }
      : null

  return {
    ok: true,
    ...(sizeWarning ? { warning: sizeWarning } : {}),
    manifest: {
      id,
      name,
      version: typeof v.version === "string" ? v.version : "0.0.0",
      bridge,
      description: typeof v.description === "string" ? v.description : "",
      size,
      height,
      config,
      origin,
    },
  }
}

/** Spec T2.4/T2.5: sanitize stored config against the schema — bad values fall
 *  back to the field default (multi-select filters to valid options), unknown
 *  keys are dropped, missing keys get defaults. Never throws, never rejects. */
export function sanitizeConfig(
  schema: Record<string, ConfigField>,
  values: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const input = values ?? {}
  for (const [key, field] of Object.entries(schema)) {
    const v = input[key]
    switch (field.type) {
      case "boolean":
        out[key] = typeof v === "boolean" ? v : field.default
        break
      case "select":
        out[key] = typeof v === "string" && field.options.includes(v) ? v : field.default
        break
      case "multi-select": {
        if (Array.isArray(v)) {
          const kept = v.filter((x): x is string => typeof x === "string" && field.options.includes(x))
          out[key] = kept.length > 0 ? kept : field.default
        } else out[key] = field.default
        break
      }
      case "string": {
        if (typeof v === "string" && (field.max_length === undefined || v.length <= field.max_length)) out[key] = v
        else out[key] = field.default
        break
      }
      case "number": {
        const okNum =
          typeof v === "number" &&
          Number.isFinite(v) &&
          (field.min === undefined || v >= field.min) &&
          (field.max === undefined || v <= field.max)
        out[key] = okNum ? v : field.default
        break
      }
    }
  }
  return out
}

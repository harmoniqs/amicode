// AMICODE (Stage 2 chat authoring): parse the AMICODE_WIDGET sentinel that the
// amicode_author_widget tool appends to its output — the LAST line, shaped
// `AMICODE_WIDGET {id,name,size,height,hash,warnings}`. Pure + unit-tested,
// mirroring parseDiffSentinel (receipt.ts). The preview card uses {id,hash} to
// build the live frame src (/amicode/widget-frame?id=&h=); the hash changing on
// re-author is the hot-reload signal.

const PREFIX = "AMICODE_WIDGET "

export interface WidgetPreview {
  id: string
  name: string
  size: "hero" | "tile"
  height: number
  hash: string
  warnings: string[]
}

export function parseWidgetSentinel(output: unknown): WidgetPreview | undefined {
  if (typeof output !== "string") return undefined
  const lines = output.trimEnd().split("\n")
  const last = lines[lines.length - 1]
  if (!last?.startsWith(PREFIX)) return undefined
  let raw: any
  try {
    raw = JSON.parse(last.slice(PREFIX.length))
  } catch {
    return undefined
  }
  if (typeof raw !== "object" || raw === null) return undefined
  if (typeof raw.id !== "string" || typeof raw.hash !== "string") return undefined
  const size: "hero" | "tile" = raw.size === "hero" ? "hero" : "tile"
  const height = typeof raw.height === "number" && raw.height > 0 ? raw.height : 96
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((w: unknown): w is string => typeof w === "string")
    : []
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name : raw.id,
    size,
    height,
    hash: raw.hash,
    warnings,
  }
}

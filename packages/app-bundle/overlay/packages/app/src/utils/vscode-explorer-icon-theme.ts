import { createSignal } from "solid-js"

type AssetMime = "image/svg+xml" | "font/woff" | "font/woff2" | "font/ttf" | "font/otf"
type FontFormat = "woff" | "woff2" | "truetype" | "opentype"

export type ExplorerFileIcon =
  | { kind: "font"; glyph: string; color?: string }
  | { kind: "svg"; asset: string }

export interface ExplorerIconTheme {
  mode: "font" | "svg" | "none"
  assets: Record<string, { mime: AssetMime; data: string }>
  fileExtensions: Record<string, ExplorerFileIcon>
  fileNames: Record<string, ExplorerFileIcon>
  defaultFile?: ExplorerFileIcon
  font?: { asset: string; format: FontFormat; size: string }
}

const FONT_FAMILY = "amicode-vscode-explorer-icon"
const ASSET_ID = /^asset-\d+$/
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const COLOR = /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d.%\s,]+\)|currentColor|inherit|transparent)$/i
const FONT_SIZE = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:%|px|em|rem)$/
const FONT_MIMES = new Set<AssetMime>(["font/woff", "font/woff2", "font/ttf", "font/otf"])
const FONT_FORMATS = new Set<FontFormat>(["woff", "woff2", "truetype", "opentype"])
const MAX_ASSET_BYTES = 1_500_000
const MAX_THEME_BYTES = 12_000_000
const MAX_MAP_ENTRIES = 10_000

const emptyTheme = (): ExplorerIconTheme => ({ mode: "none", assets: {}, fileExtensions: {}, fileNames: {} })
const [theme, setTheme] = createSignal<ExplorerIconTheme>(emptyTheme())
let fontFaceStyle: HTMLStyleElement | undefined

export const explorerIconTheme = theme
export const explorerIconFontFamily = FONT_FAMILY

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function parseAssets(value: unknown): Record<string, { mime: AssetMime; data: string }> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > MAX_MAP_ENTRIES) return undefined
  let total = 0
  const assets: Record<string, { mime: AssetMime; data: string }> = {}
  for (const [id, asset] of entries) {
    if (!ASSET_ID.test(id) || !isRecord(asset) || typeof asset.mime !== "string" || typeof asset.data !== "string") return undefined
    if (!(["image/svg+xml", "font/woff", "font/woff2", "font/ttf", "font/otf"] as string[]).includes(asset.mime)) return undefined
    if (asset.data.length > MAX_ASSET_BYTES || !BASE64.test(asset.data)) return undefined
    total += asset.data.length
    if (total > MAX_THEME_BYTES) return undefined
    assets[id] = { mime: asset.mime as AssetMime, data: asset.data }
  }
  return assets
}

function parseIcon(value: unknown, mode: "font" | "svg", assets: Record<string, { mime: AssetMime; data: string }>): ExplorerFileIcon | undefined {
  if (!isRecord(value) || value.kind !== mode) return undefined
  if (mode === "svg") {
    if (typeof value.asset !== "string" || !ASSET_ID.test(value.asset) || assets[value.asset]?.mime !== "image/svg+xml") return undefined
    return { kind: "svg", asset: value.asset }
  }
  if (typeof value.glyph !== "string" || value.glyph.length === 0 || value.glyph.length > 32) return undefined
  if (value.color !== undefined && (typeof value.color !== "string" || !COLOR.test(value.color))) return undefined
  return { kind: "font", glyph: value.glyph, ...(typeof value.color === "string" ? { color: value.color } : {}) }
}

function parseIconMap(
  value: unknown,
  mode: "font" | "svg",
  assets: Record<string, { mime: AssetMime; data: string }>,
): Record<string, ExplorerFileIcon> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  if (entries.length > MAX_MAP_ENTRIES) return undefined
  const icons: Record<string, ExplorerFileIcon> = {}
  for (const [name, icon] of entries) {
    if (name.length === 0 || name.length > 255) return undefined
    const parsed = parseIcon(icon, mode, assets)
    if (!parsed) return undefined
    icons[name] = parsed
  }
  return icons
}

function parseTheme(value: unknown): ExplorerIconTheme | undefined {
  if (!isRecord(value) || (value.mode !== "font" && value.mode !== "svg" && value.mode !== "none")) return undefined
  if (value.mode === "none") return emptyTheme()
  const assets = parseAssets(value.assets)
  if (!assets) return undefined
  const fileExtensions = parseIconMap(value.fileExtensions, value.mode, assets)
  const fileNames = parseIconMap(value.fileNames, value.mode, assets)
  const defaultFile = value.defaultFile === undefined ? undefined : parseIcon(value.defaultFile, value.mode, assets)
  if (!fileExtensions || !fileNames || (value.defaultFile !== undefined && !defaultFile)) return undefined
  if (value.mode === "svg") return { mode: "svg", assets, fileExtensions, fileNames, ...(defaultFile ? { defaultFile } : {}) }
  if (!isRecord(value.font) || typeof value.font.asset !== "string" || typeof value.font.format !== "string" || typeof value.font.size !== "string") return undefined
  if (!ASSET_ID.test(value.font.asset) || !FONT_MIMES.has(assets[value.font.asset]?.mime) || !FONT_FORMATS.has(value.font.format as FontFormat) || !FONT_SIZE.test(value.font.size)) return undefined
  return {
    mode: "font",
    assets,
    fileExtensions,
    fileNames,
    ...(defaultFile ? { defaultFile } : {}),
    font: { asset: value.font.asset, format: value.font.format as FontFormat, size: value.font.size },
  }
}

function syncFontFace(next: ExplorerIconTheme): void {
  fontFaceStyle?.remove()
  fontFaceStyle = undefined
  if (next.mode !== "font" || !next.font || typeof document === "undefined") return
  const source = explorerIconAssetUrlFrom(next, next.font.asset)
  if (!source) return
  fontFaceStyle = document.createElement("style")
  fontFaceStyle.dataset.amicodeExplorerIconTheme = "true"
  fontFaceStyle.textContent = `@font-face{font-family:"${FONT_FAMILY}";src:url("${source}") format("${next.font.format}");font-weight:normal;font-style:normal;}`
  document.head.appendChild(fontFaceStyle)
}

/** Accepts only the extension's bounded, opaque icon-theme payload. */
export function adoptExplorerIconTheme(value: unknown): boolean {
  const next = parseTheme(value)
  if (!next) return false
  setTheme(next)
  syncFontFace(next)
  return true
}

export function resetExplorerIconTheme(): void {
  setTheme(emptyTheme())
  syncFontFace(emptyTheme())
}

function explorerIconAssetUrlFrom(source: ExplorerIconTheme, asset: string): string | undefined {
  const entry = source.assets[asset]
  return entry ? `data:${entry.mime};base64,${entry.data}` : undefined
}

/** Resolves a theme asset by opaque ID. This deliberately has no path argument. */
export function explorerIconAssetUrl(asset: string): string | undefined {
  return explorerIconAssetUrlFrom(theme(), asset)
}

/** Mirrors VS Code's file-name-first, longest-extension resolution order. */
export function resolveExplorerFileIcon(filePath: string): ExplorerFileIcon | undefined {
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath
  const current = theme()
  const named = current.fileNames[fileName] ?? current.fileNames[fileName.toLowerCase()]
  if (named) return named
  for (let dot = fileName.indexOf("."); dot >= 0; dot = fileName.indexOf(".", dot + 1)) {
    const extension = fileName.slice(dot + 1).toLowerCase()
    if (current.fileExtensions[extension]) return current.fileExtensions[extension]
  }
  return current.defaultFile
}

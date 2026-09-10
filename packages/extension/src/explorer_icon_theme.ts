import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export type ExplorerIconAssetMime = "image/svg+xml" | "font/woff" | "font/woff2" | "font/ttf" | "font/otf";

export interface ExplorerIconAsset {
  mime: ExplorerIconAssetMime;
  /** Base64 bytes. Asset keys are opaque; source paths never leave the host. */
  data: string;
}

export type ExplorerFileIcon =
  | { kind: "font"; glyph: string; color?: string }
  | { kind: "svg"; asset: string };

export interface ExplorerIconTheme {
  mode: "font" | "svg" | "none";
  assets: Record<string, ExplorerIconAsset>;
  fileExtensions: Record<string, ExplorerFileIcon>;
  fileNames: Record<string, ExplorerFileIcon>;
  defaultFile?: ExplorerFileIcon;
  font?: { asset: string; format: "woff" | "woff2" | "truetype" | "opentype"; size: string };
}

const MAX_ICON_ASSET_BYTES = 1_000_000;
const MAX_ICON_THEME_BYTES = 8_000_000;
const MAX_ICON_MAP_ENTRIES = 2_000;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function emptyTheme(): ExplorerIconTheme {
  return { mode: "none", assets: {}, fileExtensions: {}, fileNames: {} };
}

function isWithin(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function assetMime(file: string): ExplorerIconAssetMime | undefined {
  switch (path.extname(file).toLowerCase()) {
    case ".svg": return "image/svg+xml";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    case ".ttf": return "font/ttf";
    case ".otf": return "font/otf";
    default: return undefined;
  }
}

/**
 * Returns bytes only from the active icon theme's own directory. This is the
 * entire asset boundary for the framed app: it receives opaque IDs and bytes,
 * never a local path or a general-purpose file endpoint.
 */
function createAssetReader(basePath: string): (assetPath: string) => ExplorerIconAsset | undefined {
  let root: string;
  try {
    root = fs.realpathSync(basePath);
  } catch {
    return () => undefined;
  }
  let totalBytes = 0;
  return (assetPath) => {
    const mime = assetMime(assetPath);
    if (!mime) return undefined;
    try {
      const realPath = fs.realpathSync(assetPath);
      if (!isWithin(root, realPath)) return undefined;
      const stat = fs.statSync(realPath);
      if (!stat.isFile() || stat.size > MAX_ICON_ASSET_BYTES || totalBytes + stat.size > MAX_ICON_THEME_BYTES) return undefined;
      totalBytes += stat.size;
      return { mime, data: fs.readFileSync(realPath).toString("base64") };
    } catch {
      return undefined;
    }
  };
}

function effectiveTheme(themeJson: any, colorThemeKind?: "light" | "dark"): any {
  if (colorThemeKind !== "light" || !themeJson.light) return themeJson;
  const light = themeJson.light;
  return {
    ...themeJson,
    file: light.file ?? themeJson.file,
    fileExtensions: { ...themeJson.fileExtensions, ...light.fileExtensions },
    fileNames: { ...themeJson.fileNames, ...light.fileNames },
    languageIds: { ...themeJson.languageIds, ...light.languageIds },
  };
}

function safeFontSize(value: unknown): string {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?(?:%|px|em|rem)$/.test(value)
    ? value
    : "100%";
}

function safeColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^(?:#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([\d.%\s,]+\)|currentColor|inherit|transparent)$/i.test(trimmed)
    ? trimmed
    : undefined;
}

function fileNameVariants(target: Record<string, ExplorerFileIcon>, name: string, icon: ExplorerFileIcon): void {
  target[name] = icon;
  const lower = name.toLowerCase();
  const upper = name.toUpperCase();
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot) : "";
  const upperBase = (dot >= 0 ? name.slice(0, dot) : name).toUpperCase() + extension;
  if (!target[lower]) target[lower] = icon;
  if (!target[upper]) target[upper] = icon;
  if (!target[upperBase]) target[upperBase] = icon;
}

function buildLanguageExtensionMap(extensionList: readonly any[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const extension of extensionList ?? []) {
    for (const language of extension.packageJSON?.contributes?.languages ?? []) {
      if (!language.id) continue;
      for (const fileExtension of language.extensions ?? []) {
        const extensionName = String(fileExtension).replace(/^\./, "");
        if (extensionName && !map[extensionName]) map[extensionName] = language.id;
      }
    }
  }
  return map;
}

/**
 * Converts the active Explorer icon theme into a path-free payload for the
 * sandboxed app. Only definitions selected by a file mapping become assets.
 */
export function buildExplorerIconTheme(
  themeJson: any,
  basePath: string,
  readAsset: (assetPath: string) => ExplorerIconAsset | undefined,
  langExtMap?: Record<string, string>,
  colorThemeKind?: "light" | "dark",
): ExplorerIconTheme {
  if (!themeJson || typeof themeJson !== "object") return emptyTheme();
  const theme = effectiveTheme(themeJson, colorThemeKind);
  const definitions: Record<string, any> = themeJson.iconDefinitions ?? {};
  const assets: Record<string, ExplorerIconAsset> = {};
  const assetIds = new Map<string, string>();

  const addAsset = (relativePath: unknown, allowed: readonly ExplorerIconAssetMime[]): string | undefined => {
    if (typeof relativePath !== "string") return undefined;
    const absolutePath = path.resolve(basePath, relativePath);
    if (!isWithin(path.resolve(basePath), absolutePath)) return undefined;
    const existing = assetIds.get(absolutePath);
    if (existing) return existing;
    const asset = readAsset(absolutePath);
    if (!asset || !allowed.includes(asset.mime) || !BASE64.test(asset.data)) return undefined;
    const id = `asset-${assetIds.size}`;
    assetIds.set(absolutePath, id);
    assets[id] = asset;
    return id;
  };

  if (Array.isArray(theme.fonts) && theme.fonts.length > 0) {
    const font = theme.fonts[0];
    const source = font?.src?.[0];
    const asset = addAsset(source?.path, ["font/woff", "font/woff2", "font/ttf", "font/otf"]);
    if (!asset) return emptyTheme();
    const formatByMime: Record<Exclude<ExplorerIconAssetMime, "image/svg+xml">, "woff" | "woff2" | "truetype" | "opentype"> = {
      "font/woff": "woff",
      "font/woff2": "woff2",
      "font/ttf": "truetype",
      "font/otf": "opentype",
    };
    const fontAsset = assets[asset];
    const definitionIcon = (definitionName: unknown): ExplorerFileIcon | undefined => {
      const definition = definitions[definitionName as string];
      if (typeof definition?.fontCharacter !== "string" || definition.fontCharacter.length === 0 || definition.fontCharacter.length > 32) return undefined;
      const color = safeColor(definition.fontColor);
      return { kind: "font", glyph: definition.fontCharacter, ...(color ? { color } : {}) };
    };
    return buildFileMappings(theme, definitionIcon, {
      mode: "font",
      assets,
      font: { asset, format: formatByMime[fontAsset.mime as Exclude<ExplorerIconAssetMime, "image/svg+xml">], size: safeFontSize(font?.size) },
    }, langExtMap);
  }

  const definitionIcon = (definitionName: unknown): ExplorerFileIcon | undefined => {
    const definition = definitions[definitionName as string];
    const asset = addAsset(definition?.iconPath, ["image/svg+xml"]);
    return asset ? { kind: "svg", asset } : undefined;
  };
  return buildFileMappings(theme, definitionIcon, { mode: "svg", assets }, langExtMap);
}

function buildFileMappings(
  theme: any,
  iconForDefinition: (definitionName: unknown) => ExplorerFileIcon | undefined,
  base: Pick<ExplorerIconTheme, "mode" | "assets" | "font">,
  langExtMap?: Record<string, string>,
): ExplorerIconTheme {
  const fileExtensions: Record<string, ExplorerFileIcon> = {};
  const fileNames: Record<string, ExplorerFileIcon> = {};
  const extensionEntries = Object.entries(theme.fileExtensions ?? {});
  const fileNameEntries = Object.entries(theme.fileNames ?? {});
  if (extensionEntries.length > MAX_ICON_MAP_ENTRIES || fileNameEntries.length > MAX_ICON_MAP_ENTRIES) {
    return { ...base, fileExtensions, fileNames };
  }
  for (const [extension, definitionName] of extensionEntries) {
    if (extension.length === 0 || extension.length > 255) continue;
    const icon = iconForDefinition(definitionName);
    if (icon) fileExtensions[extension] = icon;
  }
  if (langExtMap) {
    for (const [extension, languageId] of Object.entries(langExtMap)) {
      if (Object.keys(fileExtensions).length >= MAX_ICON_MAP_ENTRIES) break;
      if (extension.length === 0 || extension.length > 255) continue;
      if (fileExtensions[extension]) continue;
      const icon = iconForDefinition((theme.languageIds ?? {})[languageId]);
      if (icon) fileExtensions[extension] = icon;
    }
  }
  for (const [name, definitionName] of fileNameEntries) {
    if (name.length === 0 || name.length > 255) continue;
    const icon = iconForDefinition(definitionName);
    if (icon) fileNameVariants(fileNames, name, icon);
  }
  return {
    ...base,
    fileExtensions,
    fileNames,
    ...(iconForDefinition(theme.file) ? { defaultFile: iconForDefinition(theme.file) } : {}),
  };
}

/** Read the current VS Code Explorer icon theme without granting the app file access. */
export function resolveExplorerIconTheme(): ExplorerIconTheme {
  try {
    const themeId = vscode.workspace.getConfiguration("workbench").get<string>("iconTheme");
    if (!themeId) return emptyTheme();
    const langExtMap = buildLanguageExtensionMap(vscode.extensions.all as any[]);
    for (const extension of vscode.extensions.all ?? []) {
      const contribution = (extension.packageJSON?.contributes?.iconThemes ?? []).find((theme: any) => theme.id === themeId);
      if (!contribution?.path) continue;
      const themePath = path.resolve(extension.extensionPath, contribution.path);
      const basePath = path.dirname(themePath);
      const themeJson = JSON.parse(fs.readFileSync(themePath, "utf8"));
      const colorThemeKind = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
        ? "light"
        : "dark";
      return buildExplorerIconTheme(themeJson, basePath, createAssetReader(basePath), langExtMap, colorThemeKind);
    }
  } catch {
    // Themes are optional. A malformed extension contribution simply has no icon transport.
  }
  return emptyTheme();
}

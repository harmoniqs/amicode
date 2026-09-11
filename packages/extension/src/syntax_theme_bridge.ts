/**
 * syntax_theme_bridge — Extract the active VS Code color theme's token colors
 * and resolve them to a Shiki-compatible theme for the webview.
 *
 * Follows the same host-side pattern as explorer_icon_theme.ts: a pure resolver
 * function called by ChatPanel, posting the result to the framed app.
 *
 * @module
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

// ---------------------------------------------------------------------------
// Known VS Code theme → Shiki built-in name mapping.
//
// When the user's active theme matches a key here, we send just the string
// name to the webview — Shiki resolves it from its bundledThemes, no file
// reading needed. This covers the majority of users.
// ---------------------------------------------------------------------------

export const SHIKI_BUILTIN_MAP: Record<string, string> = {
  // VS Code built-in themes
  "Default Dark+": "dark-plus",
  "Default Light+": "light-plus",
  "Default Dark Modern": "dark-plus",
  "Default Light Modern": "light-plus",
  "Visual Studio Dark": "dark-plus",
  "Visual Studio Light": "light-plus",
  "Monokai": "monokai",
  "Monokai Dimmed": "monokai",

  // Popular third-party themes (by their VS Code marketplace label)
  "Dracula": "dracula",
  "Dracula Soft": "dracula-soft",
  "Dracula Theme": "dracula",
  "One Dark Pro": "one-dark-pro",
  "Nord": "nord",
  "Night Owl": "night-owl",
  "GitHub Dark": "github-dark",
  "GitHub Dark Default": "github-dark-default",
  "GitHub Dark Dimmed": "github-dark-dimmed",
  "GitHub Light": "github-light",
  "GitHub Light Default": "github-light-default",
  "Material Theme": "material-theme",
  "Material Theme Darker": "material-theme-darker",
  "Material Theme Lighter": "material-theme-lighter",
  "Material Theme Ocean": "material-theme-ocean",
  "Material Theme Palenight": "material-theme-palenight",
  "Vitesse Dark": "vitesse-dark",
  "Vitesse Light": "vitesse-light",
  "Min Dark": "min-dark",
  "Min Light": "min-light",
  "Rosé Pine": "rose-pine",
  "Rosé Pine Dawn": "rose-pine-dawn",
  "Rosé Pine Moon": "rose-pine-moon",
  "Catppuccin Mocha": "catppuccin-mocha",
  "Catppuccin Latte": "catppuccin-latte",
  "Catppuccin Frappé": "catppuccin-frappe",
  "Catppuccin Macchiato": "catppuccin-macchiato",
  "Tokyo Night": "tokyo-night",
  "Slack Theme Dark Mode": "slack-dark",
  "Synthwave '84": "synthwave-84",
  "Poimandres": "poimandres",
};

// ---------------------------------------------------------------------------
// Theme extraction types
// ---------------------------------------------------------------------------

/** A TextMate token color rule — the shape VS Code theme JSON uses. */
export interface TextMateTokenRule {
  scope?: string | string[];
  settings: { foreground?: string; fontStyle?: string };
}

/**
 * A resolved TextMate theme object that Shiki can consume directly.
 * Subset of Shiki's ThemeRegistrationRaw.
 */
export interface TextMateThemeObject {
  name: string;
  type?: "light" | "dark";
  colors?: Record<string, string>;
  tokenColors: TextMateTokenRule[];
}

/** The result of resolveSyntaxTheme: either a Shiki built-in name or a full theme object. */
export type SyntaxThemeResult = string | TextMateThemeObject;

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

const MAX_INCLUDE_DEPTH = 5;

/**
 * Resolve the active VS Code theme to a Shiki-compatible result.
 *
 * Returns:
 * - A string (Shiki built-in name) if the theme matches SHIKI_BUILTIN_MAP.
 * - A TextMateThemeObject if the theme was extracted from the extension filesystem.
 * - null if the theme could not be resolved (caller should use the fallback).
 */
export function resolveSyntaxTheme(): SyntaxThemeResult | null {
  try {
    const themeName = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
    if (!themeName) return null;

    // Fast path: check the built-in map
    const builtinName = SHIKI_BUILTIN_MAP[themeName];
    if (builtinName) return builtinName;

    // Slow path: extract from the VS Code extension filesystem
    return extractThemeFromExtensions(themeName);
  } catch {
    return null;
  }
}

/**
 * Search vscode.extensions.all for the extension contributing the named theme,
 * read its theme JSON, resolve includes, and merge user overrides.
 */
function extractThemeFromExtensions(themeName: string): TextMateThemeObject | null {
  for (const extension of vscode.extensions.all ?? []) {
    const themes: any[] = (extension as any).packageJSON?.contributes?.themes ?? [];
    const contribution = themes.find(
      (t: any) => t.label === themeName || t.id === themeName,
    );
    if (!contribution?.path) continue;
    const extensionPath: string = (extension as any).extensionPath;
    const themePath = path.resolve(extensionPath, contribution.path);
    return readThemeFile(themePath, themeName);
  }
  return null;
}

/**
 * Read a theme JSON file, resolving `include` chains up to MAX_INCLUDE_DEPTH.
 * Cycle detection via a visited-set of resolved paths.
 */
function readThemeFile(
  themePath: string,
  themeName: string,
  depth: number = 0,
  visited: Set<string> = new Set(),
): TextMateThemeObject | null {
  if (depth > MAX_INCLUDE_DEPTH) return null;

  let realPath: string;
  try {
    realPath = fs.realpathSync(themePath);
  } catch {
    return null;
  }

  if (visited.has(realPath)) return null; // cycle
  visited.add(realPath);

  let themeJson: any;
  try {
    const content = fs.readFileSync(realPath, "utf8");
    themeJson = JSON.parse(content);
  } catch {
    return null;
  }

  // Resolve include chain
  let parentTokenColors: TextMateTokenRule[] = [];
  let parentColors: Record<string, string> = {};
  if (typeof themeJson.include === "string") {
    const includePath = path.resolve(path.dirname(realPath), themeJson.include);
    const parent = readThemeFile(includePath, themeName, depth + 1, visited);
    if (parent) {
      parentTokenColors = parent.tokenColors ?? [];
      parentColors = parent.colors ?? {};
    }
  }

  // Merge: parent tokenColors first, then this theme's tokenColors on top
  const tokenColors = [
    ...parentTokenColors,
    ...(Array.isArray(themeJson.tokenColors) ? themeJson.tokenColors : []),
  ];
  const colors = { ...parentColors, ...(themeJson.colors ?? {}) };

  // Apply user overrides
  const customizations = vscode.workspace
    .getConfiguration("editor")
    .get<any>("tokenColorCustomizations");
  const userRules: TextMateTokenRule[] = customizations?.textMateRules ?? [];

  const isDark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

  return {
    name: themeName,
    type: isDark ? "dark" : "light",
    colors,
    tokenColors: [...tokenColors, ...userRules],
  };
}

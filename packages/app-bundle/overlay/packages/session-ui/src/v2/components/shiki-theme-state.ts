/**
 * shiki-theme-state — Reactive Shiki theme state for the webview.
 *
 * Receives theme data from the extension's syntax-theme bridge and makes it
 * available to all Shiki consumers (CM6 decoration plugin, markdown worker,
 * @pierre/diffs pool). Falls back to "OpenCode" when no VS Code theme has
 * been received.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The fallback theme name used when no VS Code theme is available. */
const FALLBACK_THEME = "OpenCode"

/** Current active theme name (a Shiki built-in name or "vscode-active" for custom themes). */
let activeThemeName: string = FALLBACK_THEME

/** Full TextMate theme object for custom themes (null when using a built-in name). */
let activeThemeObject: object | null = null

/** Listeners notified when the theme changes. */
const listeners: Set<(name: string) => void> = new Set()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current active Shiki theme name.
 * Returns either a Shiki built-in name (e.g. "dark-plus", "dracula") or
 * "vscode-active" for custom themes extracted from the extension filesystem.
 */
export function getActiveShikiTheme(): string {
  return activeThemeName
}

/**
 * Get the full TextMate theme object for custom themes.
 * Returns null when the active theme is a Shiki built-in (resolved by name).
 */
export function getActiveThemeObject(): object | null {
  return activeThemeObject
}

/**
 * Subscribe to theme changes. The callback receives the new theme name.
 * Returns an unsubscribe function.
 */
export function onThemeChange(cb: (name: string) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Handle an incoming syntax-theme message from the extension host.
 * Called from the app's message bridge (AmicodeThemeBridge in app.tsx).
 *
 * @param theme — either a string (Shiki built-in name) or a full TextMate theme object
 */
export function handleSyntaxThemeMessage(theme: string | object): void {
  if (typeof theme === "string") {
    // Shiki built-in name
    activeThemeName = theme
    activeThemeObject = null
  } else if (theme && typeof theme === "object") {
    // Full TextMate theme object — register under a fixed name
    activeThemeName = "vscode-active"
    activeThemeObject = theme
    // Inject the theme's token colors as CSS custom properties so that
    // lezer's HighlightStyle, markdown code blocks, and every other
    // consumer of --syntax-* picks up the VS Code theme colors immediately.
    applySyntaxCSSVariables(theme as TextMateThemeData)
  } else {
    return
  }

  for (const cb of listeners) {
    try { cb(activeThemeName) } catch { /* listener errors don't break the bridge */ }
  }
}

// ---------------------------------------------------------------------------
// CSS variable injection — map VS Code tokenColors to --syntax-* variables
// ---------------------------------------------------------------------------

interface TokenColorRule {
  scope?: string | string[]
  settings?: { foreground?: string; fontStyle?: string }
}

interface TextMateThemeData {
  tokenColors?: TokenColorRule[]
  colors?: Record<string, string>
}

/**
 * Map from --syntax-* CSS variable names to the TextMate scopes they represent.
 * Order within each array is precedence: first match wins.
 */
const SCOPE_TO_VAR: [string, string[]][] = [
  ["--syntax-comment",  ["comment", "punctuation.definition.comment"]],
  ["--syntax-keyword",  ["keyword", "keyword.control", "keyword.operator", "storage", "storage.type", "storage.modifier"]],
  ["--syntax-string",   ["string", "string.quoted", "punctuation.definition.string"]],
  ["--syntax-primitive",["constant.numeric", "constant.language", "constant.character"]],
  ["--syntax-type",     ["entity.name.type", "support.type", "entity.name.class", "entity.name.namespace"]],
  ["--syntax-property", ["entity.name.function", "support.function", "entity.other.attribute-name", "variable.other.property"]],
  ["--syntax-constant", ["constant", "constant.other", "variable.language", "entity.name.constant"]],
]

/**
 * Extract foreground colors from the theme's tokenColors and set them as
 * CSS custom properties on <html>. This makes every --syntax-* consumer
 * (lezer HighlightStyle, markdown code blocks, inline code) reflect the
 * VS Code theme instantly — no Worker or Shiki needed.
 */
function applySyntaxCSSVariables(theme: TextMateThemeData): void {
  if (typeof document === "undefined") return
  const rules = theme.tokenColors
  if (!Array.isArray(rules) || rules.length === 0) return

  // Build a scope → foreground map (last rule wins, matching VS Code's semantics)
  const scopeColors = new Map<string, string>()
  for (const rule of rules) {
    const fg = rule.settings?.foreground
    if (!fg) continue
    const scopes = Array.isArray(rule.scope) ? rule.scope
      : typeof rule.scope === "string" ? rule.scope.split(",").map(s => s.trim())
      : []
    for (const scope of scopes) {
      scopeColors.set(scope, fg)
    }
  }

  // Also extract editor.foreground for the base text color
  const editorFg = theme.colors?.["editor.foreground"]

  const root = document.documentElement
  for (const [varName, scopes] of SCOPE_TO_VAR) {
    // Find the first matching scope
    for (const scope of scopes) {
      const color = scopeColors.get(scope)
      if (color) {
        root.style.setProperty(varName, color)
        break
      }
    }
  }

  // Set editor foreground as the base text color if available
  if (editorFg) {
    root.style.setProperty("--syntax-base", editorFg)
  }
}

/**
 * Reset to the fallback theme (for tests or when the bridge disconnects).
 */
export function resetToFallback(): void {
  activeThemeName = FALLBACK_THEME
  activeThemeObject = null
}

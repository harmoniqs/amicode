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
  } else {
    return
  }

  for (const cb of listeners) {
    try { cb(activeThemeName) } catch { /* listener errors don't break the bridge */ }
  }
}

/**
 * Reset to the fallback theme (for tests or when the bridge disconnects).
 */
export function resetToFallback(): void {
  activeThemeName = FALLBACK_THEME
  activeThemeObject = null
}

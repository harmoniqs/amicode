/**
 * shiki-highlight-plugin — CM6 ViewPlugin that applies Shiki-tokenized
 * syntax highlighting as decorations, replacing the lezer-based
 * syntaxHighlighting for visual coloring while keeping lezer for
 * structural features (bracket matching, folding, auto-indent).
 *
 * @module
 */

import {
  type Extension,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state"
import {
  Decoration,
  type DecorationSet,
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"
import type { ShikiTokenizeResult } from "./shiki-highlight-worker"
import { getActiveShikiTheme, getActiveThemeObject, onThemeChange } from "./shiki-theme-state"

// ---------------------------------------------------------------------------
// Decoration effect — the plugin dispatches this to update the decoration set
// ---------------------------------------------------------------------------

const setShikiDecorations = StateEffect.define<DecorationSet>()

const shikiDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setShikiDecorations)) return e.value
    }
    // Map decorations through document changes (shift offsets)
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---------------------------------------------------------------------------
// Worker management — single shared worker for all CM6 instances
// ---------------------------------------------------------------------------

let sharedWorker: Worker | null = null
let workerReady = false
const pendingRequests = new Map<number, (result: ShikiTokenizeResult) => void>()
let nextRequestId = 1

function getWorker(): Worker | null {
  if (sharedWorker) return sharedWorker
  try {
    sharedWorker = new Worker(
      new URL("./shiki-highlight-worker.ts", import.meta.url),
      { type: "module" },
    )
    sharedWorker.onmessage = (event: MessageEvent<ShikiTokenizeResult>) => {
      if (event.data.type === "tokenize-result") {
        const cb = pendingRequests.get(event.data.id)
        if (cb) {
          pendingRequests.delete(event.data.id)
          cb(event.data)
        }
      }
    }
    // Initialize with the current theme
    const themeObj = getActiveThemeObject()
    const themeName = getActiveShikiTheme()
    if (themeObj) {
      sharedWorker.postMessage({
        type: "init",
        theme: { ...themeObj, name: "vscode-active" },
        name: "vscode-active",
      })
    } else {
      // For built-in themes, we still need a theme object for init.
      // The worker will load it by name from Shiki's bundled themes.
      sharedWorker.postMessage({
        type: "init",
        theme: { name: themeName, tokenColors: [] },
        name: themeName,
      })
    }
    workerReady = true
    return sharedWorker
  } catch {
    return null
  }
}

function sendThemeUpdate(name: string, theme: string | object): void {
  const worker = sharedWorker
  if (!worker) return
  worker.postMessage({
    type: "theme-update",
    theme,
    name,
  })
}

function tokenize(
  text: string,
  lang: string,
  theme: string,
): Promise<ShikiTokenizeResult> {
  const worker = getWorker()
  if (!worker) return Promise.resolve({ type: "tokenize-result" as const, id: 0, lines: [] })

  const id = nextRequestId++
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id)
      resolve({ type: "tokenize-result", id, lines: [] })
    }, 2000)

    pendingRequests.set(id, (result) => {
      clearTimeout(timeout)
      resolve(result)
    })

    worker.postMessage({ type: "tokenize", id, text, lang, theme })
  })
}

// ---------------------------------------------------------------------------
// Token → Decoration conversion
// ---------------------------------------------------------------------------

function tokensToDecorations(result: ShikiTokenizeResult, docText: string): DecorationSet {
  if (result.lines.length === 0) return Decoration.none

  const ranges: Range<Decoration>[] = []
  let lineStart = 0

  for (let i = 0; i < result.lines.length && lineStart <= docText.length; i++) {
    const line = result.lines[i]
    for (const token of line.tokens) {
      const from = lineStart + token.offset
      const to = from + token.length
      if (from >= to || from < 0 || to > docText.length) continue
      if (!token.color) continue

      let style = `color: ${token.color}`
      if (token.fontStyle) {
        if (token.fontStyle & 1) style += "; font-style: italic"
        if (token.fontStyle & 2) style += "; font-weight: bold"
        if (token.fontStyle & 4) style += "; text-decoration: underline"
      }
      ranges.push(Decoration.mark({ attributes: { style } }).range(from, to))
    }

    // Move past this line's content + the newline
    const newlineIdx = docText.indexOf("\n", lineStart)
    lineStart = newlineIdx >= 0 ? newlineIdx + 1 : docText.length + 1
  }

  // Decorations must be sorted by from position
  ranges.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(ranges)
}

// ---------------------------------------------------------------------------
// CM6 ViewPlugin
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 150

class ShikiHighlightPluginValue implements PluginValue {
  private view: EditorView
  private lang: string
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private currentTokenizeId = 0
  private unsubTheme: (() => void) | null = null

  constructor(view: EditorView, lang: string) {
    this.view = view
    this.lang = lang

    // Subscribe to theme changes
    this.unsubTheme = onThemeChange(() => {
      this.scheduleTokenize()
    })

    // Initial tokenization
    this.scheduleTokenize()
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.scheduleTokenize()
    }
  }

  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.unsubTheme) this.unsubTheme()
  }

  private scheduleTokenize(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => this.doTokenize(), DEBOUNCE_MS)
  }

  private async doTokenize(): Promise<void> {
    const id = ++this.currentTokenizeId
    const view = this.view
    const doc = view.state.doc
    const text = doc.toString()
    const theme = getActiveShikiTheme()

    const result = await tokenize(text, this.lang, theme)

    // Stale check: if another tokenization was started, discard this one
    if (id !== this.currentTokenizeId) return
    // View may have been destroyed
    if (!this.view) return

    const decorations = tokensToDecorations(result, text)
    view.dispatch({ effects: setShikiDecorations.of(decorations) })
  }
}

// ---------------------------------------------------------------------------
// Public API — the CM6 extension to add to baseExtensions()
// ---------------------------------------------------------------------------

/**
 * Create a CM6 extension that applies Shiki-based syntax highlighting.
 * The `lang` parameter is the file extension (e.g. "ts", "py", "jl").
 *
 * Returns an array of extensions: the StateField (decorations) and the
 * ViewPlugin (tokenization + debounce + worker communication).
 */
export function shikiHighlightExtension(lang: string): Extension[] {
  return [
    shikiDecorationField,
    ViewPlugin.define(
      (view) => new ShikiHighlightPluginValue(view, lang),
    ),
  ]
}

/**
 * Notify the Shiki worker about a theme change. Called when the
 * shiki-theme-state receives a new theme from the extension bridge.
 */
export function updateWorkerTheme(): void {
  const name = getActiveShikiTheme()
  const obj = getActiveThemeObject()
  sendThemeUpdate(name, obj ?? name)
}

// Re-export for tests
export { tokensToDecorations, setShikiDecorations, shikiDecorationField }
export type { ShikiTokenizeResult }

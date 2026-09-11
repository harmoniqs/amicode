/**
 * shiki-highlight-plugin — CM6 ViewPlugin that applies Shiki-tokenized
 * syntax highlighting as decorations, replacing the lezer-based
 * syntaxHighlighting for visual coloring while keeping lezer for
 * structural features (bracket matching, folding, auto-indent).
 *
 * @module
 */

import { type Extension } from "@codemirror/state"
import {
  EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view"
import {
  type ShikiTokenizeResult,
  setShikiDecorations,
  shikiDecorationField,
  tokensToDecorations,
} from "./shiki-highlight-decorations"
import { getActiveShikiTheme, getActiveThemeObject, onThemeChange } from "./shiki-theme-state"
import { OpenCodeTheme } from "@opencode-ai/ui/context/marked"
import ShikiHighlightWorkerUrl from "./shiki-highlight-worker.ts?worker&url"

// ---------------------------------------------------------------------------
// Worker management — single shared worker for all CM6 instances
// ---------------------------------------------------------------------------

let sharedWorker: Worker | null = null
const pendingRequests = new Map<number, (result: ShikiTokenizeResult) => void>()
let nextRequestId = 1

function getWorker(): Worker | null {
  if (sharedWorker) return sharedWorker
  try {
    sharedWorker = new Worker(ShikiHighlightWorkerUrl, { type: "module" })
    sharedWorker.onmessage = (event: MessageEvent<ShikiTokenizeResult>) => {
      if (event.data.type === "tokenize-result") {
        const cb = pendingRequests.get(event.data.id)
        if (cb) {
          pendingRequests.delete(event.data.id)
          cb(event.data)
        }
      }
    }
    // Initialize with the current theme — if a VS Code theme has been
    // received, use it; otherwise use the full OpenCodeTheme (the same
    // CSS-variable-based theme the markdown worker uses).
    const themeObj = getActiveThemeObject()
    const themeName = getActiveShikiTheme()
    if (themeObj) {
      sharedWorker.postMessage({
        type: "init",
        theme: { ...themeObj, name: "vscode-active" },
        name: "vscode-active",
      })
    } else {
      // Use the actual OpenCodeTheme object — it has 30+ TextMate scope
      // rules with CSS variable colors that resolve in the DOM context.
      sharedWorker.postMessage({
        type: "init",
        theme: OpenCodeTheme,
        name: themeName,
      })
    }
    return sharedWorker
  } catch {
    return null
  }
}

function sendThemeUpdate(name: string, theme: string | object): void {
  const worker = sharedWorker
  if (!worker) return
  worker.postMessage({ type: "theme-update", theme, name })
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
    if (!this.view) return

    const decorations = tokensToDecorations(result, text)
    view.dispatch({ effects: setShikiDecorations.of(decorations) })
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a CM6 extension that applies Shiki-based syntax highlighting.
 * The `lang` parameter is the file extension (e.g. "ts", "py", "jl").
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
 * Notify the Shiki worker about a theme change.
 */
export function updateWorkerTheme(): void {
  const name = getActiveShikiTheme()
  const obj = getActiveThemeObject()
  sendThemeUpdate(name, obj ?? name)
}

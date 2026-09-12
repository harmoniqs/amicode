/**
 * shiki-highlight-plugin — CM6 ViewPlugin that applies Shiki-tokenized
 * syntax highlighting as decorations, replacing the lezer-based
 * syntaxHighlighting for visual coloring while keeping lezer for
 * structural features (bracket matching, folding, auto-indent).
 *
 * Runs Shiki on the main thread with the pure-JS regex engine — no Worker,
 * no WASM, no URL resolution issues in webview contexts.
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

// ---------------------------------------------------------------------------
// Main-thread Shiki highlighter — lazy singleton
// ---------------------------------------------------------------------------

import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import { bundledLanguages, type BundledLanguage } from "shiki/langs"
import type { ThemeRegistrationRaw } from "shiki/types"

const jsEngine = createJavaScriptRegexEngine()

let highlighterPromise: Promise<HighlighterCore> | null = null
let currentThemeName: string | undefined

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise

  const themeObj = getActiveThemeObject()
  const themeName = getActiveShikiTheme()

  if (themeObj) {
    currentThemeName = "vscode-active"
    highlighterPromise = createHighlighterCore({
      themes: [{ ...(themeObj as ThemeRegistrationRaw), name: "vscode-active" }],
      langs: [],
      engine: jsEngine,
    })
  } else {
    currentThemeName = themeName
    highlighterPromise = createHighlighterCore({
      themes: [{ ...(OpenCodeTheme as ThemeRegistrationRaw), name: themeName }],
      langs: [],
      engine: jsEngine,
    })
  }

  return highlighterPromise
}

async function handleThemeUpdate(): Promise<void> {
  if (!highlighterPromise) return
  const instance = await highlighterPromise
  const themeObj = getActiveThemeObject()
  const name = getActiveShikiTheme()

  if (themeObj) {
    const themed = { ...(themeObj as ThemeRegistrationRaw), name: "vscode-active" }
    await instance.loadTheme(themed)
    currentThemeName = "vscode-active"
  } else {
    currentThemeName = name
  }
}

async function tokenize(
  text: string,
  lang: string,
): Promise<ShikiTokenizeResult> {
  try {
    const instance = await getHighlighter()
    if (!currentThemeName) {
      return { type: "tokenize-result", id: 0, lines: [] }
    }

    const langId = lang as BundledLanguage
    const language = langId in bundledLanguages ? langId : null
    if (language && !instance.getLoadedLanguages().includes(language)) {
      await instance.loadLanguage(bundledLanguages[language])
    }

    const result = instance.codeToTokens(text, {
      lang: language ?? "text",
      theme: currentThemeName,
    })

    return {
      type: "tokenize-result",
      id: 0,
      lines: result.tokens.map((lineTokens) => ({
        tokens: lineTokens.map((token) => ({
          offset: token.offset,
          length: token.content.length,
          color: token.color ?? "",
          ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
        })),
      })),
    }
  } catch (err) {
    console.error("[shiki] tokenize failed:", err)
    return { type: "tokenize-result", id: 0, lines: [] }
  }
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
      void handleThemeUpdate()
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
    const text = view.state.doc.toString()

    const result = await tokenize(text, this.lang)

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
 * Notify the highlighter about a theme change (called from editor-core).
 */
export function updateWorkerTheme(): void {
  void handleThemeUpdate()
}

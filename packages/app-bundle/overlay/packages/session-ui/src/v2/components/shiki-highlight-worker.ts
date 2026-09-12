/// <reference lib="webworker" />

/**
 * shiki-highlight-worker — Dedicated Web Worker for Shiki tokenization
 * of CM6 editor content. Receives text + language + theme, returns tokens
 * with colors for the CM6 decoration plugin.
 *
 * Uses the pure-JS regex engine (no oniguruma WASM) so the Worker
 * initializes without fetching any binary — works in VS Code webviews,
 * iframes, and any restricted context.
 *
 * @module
 */

import { bundledLanguages, type BundledLanguage } from "shiki/langs"
import { createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import type { ThemeRegistrationRaw } from "shiki/types"

const jsEngine = createJavaScriptRegexEngine()

let highlighter: Promise<HighlighterCore> | undefined
let currentThemeName: string | undefined

export interface ShikiTokenizeRequest {
  type: "tokenize"
  id: number
  text: string
  lang: string
  theme: string
}

export interface ShikiThemeUpdateRequest {
  type: "theme-update"
  theme: string | ThemeRegistrationRaw
  name: string
}

export interface ShikiInitRequest {
  type: "init"
  theme: ThemeRegistrationRaw
  name: string
}

export type ShikiHighlightWorkerRequest =
  | ShikiTokenizeRequest
  | ShikiThemeUpdateRequest
  | ShikiInitRequest

export interface ShikiTokenizeResult {
  type: "tokenize-result"
  id: number
  lines: Array<{
    tokens: Array<{ offset: number; length: number; color: string; fontStyle?: number }>
  }>
}

function post(msg: ShikiTokenizeResult): void {
  ;(self as unknown as Worker).postMessage(msg)
}

self.onmessage = async (event: MessageEvent<ShikiHighlightWorkerRequest>) => {
  const data = event.data

  if (data.type === "init") {
    currentThemeName = data.name
    highlighter ??= createHighlighterCore({
      themes: [data.theme],
      langs: [],
      engine: jsEngine,
    })
    return
  }

  if (data.type === "theme-update") {
    if (!highlighter) return
    const instance = await highlighter
    if (typeof data.theme === "object") {
      // Custom theme from VS Code — register under its own name, then
      // also ensure currentThemeName matches what the plugin requests.
      const themed = { ...(data.theme as ThemeRegistrationRaw), name: data.name }
      await instance.loadTheme(themed)
    }
    currentThemeName = data.name
    return
  }

  if (data.type === "tokenize") {
    try {
      const instance = await highlighter
      if (!instance || !currentThemeName) {
        post({ type: "tokenize-result", id: data.id, lines: [] })
        return
      }

      const langId = data.lang
      const language = langId in bundledLanguages ? langId as BundledLanguage : null
      if (language && !instance.getLoadedLanguages().includes(language)) {
        await instance.loadLanguage(bundledLanguages[language])
      }

      const result = instance.codeToTokens(data.text, {
        lang: language ?? "text",
        theme: currentThemeName,
      })

      const lines = result.tokens.map((lineTokens) => ({
        tokens: lineTokens.map((token) => ({
          offset: token.offset,
          length: token.content.length,
          color: token.color ?? "",
          ...(token.fontStyle ? { fontStyle: token.fontStyle } : {}),
        })),
      }))

      post({ type: "tokenize-result", id: data.id, lines })
    } catch {
      // On error, return empty — the editor falls back to lezer highlighting
      post({ type: "tokenize-result", id: data.id, lines: [] })
    }
  }
}

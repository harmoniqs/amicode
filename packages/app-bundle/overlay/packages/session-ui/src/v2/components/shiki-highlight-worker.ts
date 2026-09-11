/// <reference lib="webworker" />

/**
 * shiki-highlight-worker — Dedicated Web Worker for Shiki tokenization
 * of CM6 editor content. Receives text + language + theme, returns tokens
 * with colors for the CM6 decoration plugin.
 *
 * @module
 */

import {
  bundledLanguages,
  createHighlighter,
  type BundledLanguage,
  type ThemeRegistrationRaw,
} from "shiki"

let highlighter: ReturnType<typeof createHighlighter> | undefined
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
    highlighter ??= createHighlighter({ themes: [data.theme], langs: [] })
    return
  }

  if (data.type === "theme-update") {
    if (!highlighter) return
    const instance = await highlighter
    if (typeof data.theme === "object") {
      // Register a custom theme
      await instance.loadTheme(data.theme as ThemeRegistrationRaw)
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

      const language = data.lang in bundledLanguages ? data.lang : "text"
      if (!instance.getLoadedLanguages().includes(language)) {
        await instance.loadLanguage(bundledLanguages[language as BundledLanguage])
      }

      const result = instance.codeToTokens(data.text, {
        lang: language as BundledLanguage,
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

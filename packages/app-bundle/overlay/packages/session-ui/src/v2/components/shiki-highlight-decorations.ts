/**
 * shiki-highlight-decorations — Pure token-to-decoration conversion logic.
 *
 * Separated from the plugin (which imports a Vite ?worker&url) so this
 * module is testable in bun without Worker URL resolution issues.
 *
 * @module
 */

import { type Range, StateEffect, StateField } from "@codemirror/state"
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view"

// ---------------------------------------------------------------------------
// Types — shared between the worker and the plugin
// ---------------------------------------------------------------------------

export interface ShikiTokenLine {
  tokens: Array<{ offset: number; length: number; color: string; fontStyle?: number }>
}

export interface ShikiTokenizeResult {
  type: "tokenize-result"
  id: number
  lines: ShikiTokenLine[]
}

// ---------------------------------------------------------------------------
// Decoration effect + field
// ---------------------------------------------------------------------------

export const setShikiDecorations = StateEffect.define<DecorationSet>()

export const shikiDecorationField = StateField.define<DecorationSet>({
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
// Token → Decoration conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Shiki tokenization result into a CM6 DecorationSet.
 * Each token becomes a Decoration.mark with an inline `style` attribute
 * carrying the foreground color (and optional fontStyle).
 */
export function tokensToDecorations(result: ShikiTokenizeResult, docText: string): DecorationSet {
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

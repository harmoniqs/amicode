/**
 * editor-core — General-purpose CodeMirror 6 setup functions.
 *
 * Extracted from editable-diff-view-core.ts (#912 Slice 1) so that both
 * the diff view and the new preview editor share the same theme, language
 * loading, and extension setup without duplicating logic.
 *
 * All signatures are preserved exactly from the original — this is a pure
 * move, not a rewrite. The diff view re-imports from here.
 *
 * @module
 */

import { Annotation, EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view"
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands"
import { type LanguageSupport, bracketMatching } from "@codemirror/language"
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language"
import { tags } from "@lezer/highlight"
import { shikiHighlightExtension, updateWorkerTheme } from "./shiki-highlight-plugin"
import { onThemeChange } from "./shiki-theme-state"

// ---------------------------------------------------------------------------
// External-update annotation — marks programmatic content dispatches so the
// onChange listener can distinguish them from user keystrokes (#837).
// ---------------------------------------------------------------------------

/**
 * CM6 annotation that marks a transaction as a programmatic (external) update.
 * Transactions annotated with `externalUpdate.of(true)` are filtered out by
 * the `editableExtensions` updateListener — they do NOT fire the `onChange`
 * callback. This prevents `updateModified` / `updateOriginal` dispatches
 * (server diff refreshes, agent file edits) from setting false dirty state.
 */
export const externalUpdate = Annotation.define<boolean>()

// ---------------------------------------------------------------------------
// Language loader — uses a manual map for common extensions (with specific
// options like jsx/typescript flags) and falls back to @codemirror/language-data
// for broader coverage (~150 languages including Rust, Go, YAML, SQL, etc.).
// Shiki handles visual highlighting for 200+ languages via TextMate grammars;
// this loader provides lezer grammars for structural features (bracket
// matching, code folding, auto-indent).
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, () => Promise<LanguageSupport>> = {
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false, typescript: false })),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: false })),
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false, typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true, typescript: true })),
  mjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false, typescript: false })),
  cjs: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: false, typescript: false })),
  py: () => import("@codemirror/lang-python").then((m) => m.python()),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  jsonc: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  scss: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  htm: () => import("@codemirror/lang-html").then((m) => m.html()),
  xml: () => import("@codemirror/lang-html").then((m) => m.html()),
  svg: () => import("@codemirror/lang-html").then((m) => m.html()),
}

/**
 * Dynamically load a CodeMirror language support by file extension.
 *
 * Uses the manual EXTENSION_MAP first (covers common extensions with specific
 * options), then falls back to @codemirror/language-data's LanguageDescription
 * auto-detection for broader coverage.
 *
 * Returns null for extensions with no known lezer grammar. Note: Shiki still
 * provides visual highlighting for these files via TextMate grammars — only
 * structural features (bracket matching, folding) degrade to CM6's generic
 * behavior.
 */
export async function loadLanguage(
  ext: string,
): Promise<LanguageSupport | null> {
  const normalized = ext.replace(/^\./, "").toLowerCase()

  // Fast path: manual map with specific options
  const loader = EXTENSION_MAP[normalized]
  if (loader) {
    try {
      return await loader()
    } catch {
      return null
    }
  }

  // Slow path: @codemirror/language-data auto-detection
  try {
    const { languages } = await import("@codemirror/language-data")
    const filename = `file.${normalized}`
    const desc = languages.find((lang) =>
      lang.extensions.some((e) => filename.endsWith(e)) ||
      lang.filename?.test(filename),
    )
    if (desc) {
      return await desc.load()
    }
  } catch {
    // language-data not available or failed to load — fall through
  }

  return null
}

// ---------------------------------------------------------------------------
// Theme builder — maps app CSS custom properties to CM6 theme selectors.
//
// Uses the app's v2 design tokens (--v2-*) for structural chrome and the
// OpenCode Shiki token variables (--syntax-*) for syntax highlighting. Both
// systems switch light/dark purely via CSS — the CM6 theme is the same
// object in either mode, referencing variables that the app's theme resolver
// redefines for each color scheme.
// ---------------------------------------------------------------------------

/**
 * Build a CM6 theme extension using the app's design tokens.
 * The `mode` parameter sets the CM6 `dark` flag (which controls default
 * fallback colors); actual colors come from CSS custom properties.
 */
export function buildThemeExtension(mode: "light" | "dark"): Extension {
  const isDark = mode === "dark"

  return EditorView.theme(
    {
      "&": {
        backgroundColor: "var(--v2-background-bg-base, var(--background-base))",
        color: "var(--v2-text-text-base, var(--text-strong))",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
        fontSize: "13px",
        lineHeight: "1.5",
      },
      ".cm-content": {
        caretColor: "var(--v2-text-text-base, var(--text-strong))",
        fontFamily: "var(--font-mono, ui-monospace, monospace)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--v2-text-text-base, var(--text-strong))",
      },
      // Selection highlight — override CM6's built-in defaults (#d7d4f0 light,
      // #233 dark) with our theme tokens. The child-combinator selector matches
      // CM6's internal specificity so our rule wins.
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        background: "var(--v2-background-bg-layer-03, var(--background-weak))",
      },
      ".cm-selectionBackground": {
        backgroundColor: "var(--v2-background-bg-layer-03, var(--background-weak))",
      },
      ".cm-panels": {
        backgroundColor: "var(--v2-background-bg-base, var(--background-base))",
        color: "var(--v2-text-text-base, var(--text-strong))",
      },
      ".cm-gutters": {
        backgroundColor: "var(--v2-background-bg-layer-01, var(--background-weak))",
        color: "var(--v2-text-text-muted, var(--text-weak))",
        borderRight: "1px solid var(--v2-border-border-base, var(--border-base))",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--v2-background-bg-layer-02, var(--background-weak))",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--v2-background-bg-layer-01, var(--background-weak))",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--v2-text-text-faint, var(--text-weaker))",
      },
      // Diff highlights — softer backgrounds that read well in both modes.
      // The v2 state-bg tokens are designed for small badges; for full-line
      // backgrounds we mix them down to ~40% so they tint without obscuring text.
      ".cm-changedLine": {
        backgroundColor: "color-mix(in srgb, var(--v2-state-bg-warning, var(--surface-warning-weak)) 40%, transparent)",
      },
      ".cm-changedText": {
        backgroundColor: "color-mix(in srgb, var(--v2-state-bg-warning, var(--surface-warning-base)) 60%, transparent)",
      },
      ".cm-insertedLine": {
        backgroundColor: "color-mix(in srgb, var(--v2-state-bg-success, var(--surface-success-weak)) 40%, transparent)",
      },
      ".cm-deletedLine": {
        backgroundColor: "color-mix(in srgb, var(--v2-state-bg-danger, var(--surface-critical-weak)) 30%, transparent)",
      },
    },
    { dark: isDark },
  )
}

// ---------------------------------------------------------------------------
// Syntax highlight style — maps CM6 lezer tags to the app's --syntax-*
// CSS variables so highlighting matches the user's selected theme.
// ---------------------------------------------------------------------------

/**
 * Build a HighlightStyle that uses the app's --syntax-* CSS variables.
 * Returns a syntaxHighlighting extension.
 */
export function buildSyntaxHighlightStyle(): Extension {
  const style = HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment],
      color: "var(--syntax-comment, var(--text-weak))" },
    { tag: [tags.keyword, tags.controlKeyword, tags.operatorKeyword, tags.moduleKeyword],
      color: "var(--syntax-keyword, var(--text-weak))" },
    { tag: [tags.string, tags.special(tags.string), tags.character],
      color: "var(--syntax-string)" },
    { tag: [tags.number, tags.bool, tags.null],
      color: "var(--syntax-primitive)" },
    { tag: [tags.typeName, tags.className, tags.namespace],
      color: "var(--syntax-type)" },
    { tag: [tags.propertyName, tags.attributeName, tags.labelName],
      color: "var(--syntax-property)" },
    { tag: [tags.variableName, tags.definition(tags.variableName)],
      color: "var(--v2-text-text-base, var(--text-strong))" },
    { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
      color: "var(--syntax-property)" },
    { tag: [tags.constant(tags.variableName), tags.atom],
      color: "var(--syntax-constant)" },
    { tag: [tags.operator, tags.punctuation, tags.separator],
      color: "var(--v2-text-text-muted, var(--text-base))" },
    { tag: [tags.meta, tags.annotation, tags.processingInstruction],
      color: "var(--syntax-comment, var(--text-weak))" },
    { tag: tags.heading,
      color: "var(--syntax-keyword, var(--text-strong))", fontWeight: "bold" },
    { tag: tags.emphasis,
      fontStyle: "italic" },
    { tag: tags.strong,
      fontWeight: "bold" },
    { tag: tags.link,
      color: "var(--syntax-string)", textDecoration: "underline" },
    { tag: tags.invalid,
      color: "var(--v2-state-fg-danger, var(--text-on-critical-base))" },
  ])

  return syntaxHighlighting(style)
}

// ---------------------------------------------------------------------------
// Shared extensions — base setup shared by all editor instances.
// ---------------------------------------------------------------------------

/**
 * Build the mutable extensions that live inside a Compartment and can be
 * swapped via `setReadOnly()` without re-creating the editor.
 */
export function editableExtensions(opts: {
  readOnly: boolean
  onChange?: (content: string) => void
}): Extension[] {
  const exts: Extension[] = [
    EditorView.editable.of(!opts.readOnly),
    EditorState.readOnly.of(opts.readOnly),
  ]

  if (!opts.readOnly) {
    exts.push(history())
  }

  if (opts.onChange && !opts.readOnly) {
    exts.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !update.transactions.some(tr => tr.annotation(externalUpdate))) {
          opts.onChange!(update.state.doc.toString())
        }
      }),
    )
  }

  return exts
}

export function baseExtensions(opts: {
  theme: Extension
  language?: LanguageSupport | null
  /** File extension for Shiki highlighting (e.g. "ts", "py", "jl"). */
  lang?: string
}): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    bracketMatching(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    EditorView.lineWrapping,
    buildSyntaxHighlightStyle(), // first-paint bridge: lezer colors until Shiki responds
    opts.theme,
    ...(opts.language ? [opts.language] : []),
    ...(opts.lang ? shikiHighlightExtension(opts.lang) : []),
  ]
}

// ---------------------------------------------------------------------------
// Theme detection — reads the app's color scheme from the DOM.
// ---------------------------------------------------------------------------

/**
 * Detect dark/light mode from DOM — reads `data-color-scheme` attribute
 * on <html> (set by the app's theme system).
 */
export function detectMode(): "light" | "dark" {
  if (typeof document === "undefined") return "dark"
  const html = document.documentElement
  // The app sets data-color-scheme on <html>
  const scheme = html.getAttribute("data-color-scheme")
  if (scheme === "light") return "light"
  if (scheme === "dark") return "dark"
  // Fallbacks for other conventions
  if (html.classList.contains("dark")) return "dark"
  if (html.getAttribute("data-theme") === "dark") return "dark"
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  )
    return "dark"
  return "light"
}

// ---------------------------------------------------------------------------
// Wire theme changes to the Shiki highlight worker
// ---------------------------------------------------------------------------

onThemeChange(() => updateWorkerTheme())

/**
 * EditableDiffView — CodeMirror 6 core logic.
 *
 * Pure logic layer: language loading, theme building, editor construction.
 * The SolidJS component wrapper lives in editable-diff-view.tsx and uses
 * these functions. Tests import this file directly (no JSX transform needed).
 *
 * @module
 */

import { Compartment, EditorState, Transaction, ChangeSet, type Extension } from "@codemirror/state"
import {
  EditorView,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
} from "@codemirror/view"
import {
  MergeView,
  unifiedMergeView,
  originalDocChangeEffect,
  getOriginalDoc,
} from "@codemirror/merge"
import { type LanguageSupport } from "@codemirror/language"
import {
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language"
import { tags } from "@lezer/highlight"

// ---------------------------------------------------------------------------
// Language loader — dynamic imports so unused grammars stay out of the bundle.
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
 * Returns null for unknown extensions.
 */
export async function loadLanguage(
  ext: string,
): Promise<LanguageSupport | null> {
  const normalized = ext.replace(/^\./, "").toLowerCase()
  const loader = EXTENSION_MAP[normalized]
  if (!loader) return null
  try {
    return await loader()
  } catch {
    return null
  }
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
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        {
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
      color: "var(--syntax-function, var(--syntax-property))" },
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

  if (opts.onChange && !opts.readOnly) {
    exts.push(
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
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
}): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightSpecialChars(),
    drawSelection(),
    EditorView.lineWrapping,
    buildSyntaxHighlightStyle(),
    opts.theme,
    ...(opts.language ? [opts.language] : []),
  ]
}

// ---------------------------------------------------------------------------
// Editor construction — imperative helpers for tests and the SolidJS wrapper.
// ---------------------------------------------------------------------------

export interface DiffEditorHandle {
  /** The active EditorView for the modified (editable) pane. */
  editorView: EditorView | null
  /** The MergeView instance (split mode only). */
  mergeView: MergeView | null
  /** The scrollable DOM element (split: mergeView.dom, unified: editorView.scrollDOM). */
  scrollDOM: HTMLElement | null
  /** Destroy all editor instances. */
  destroy: () => void
  /** Revert to original: replace content, clear undo history. */
  revert: (original: string) => void
  /** Get the current document content. */
  getContent: () => string
  /**
   * Update the original (left/before) document in place via CM6 dispatch.
   * No editor re-creation. No-op if text is unchanged.
   */
  updateOriginal: (text: string) => void
  /**
   * Update the modified (right/after) document in place via CM6 dispatch.
   * No editor re-creation. No-op if text is unchanged.
   */
  updateModified: (text: string) => void
  /**
   * Toggle readOnly state in place via Compartment reconfigure.
   * No editor re-creation, no scroll displacement.
   * Pass `onChange` when switching to editable to re-attach the listener.
   */
  setReadOnly: (readOnly: boolean, onChange?: (content: string) => void) => void
}

export function createDiffEditor(opts: {
  parent: HTMLElement
  original: string
  modified: string
  diffStyle: "unified" | "split"
  readOnly: boolean
  theme: Extension
  language?: LanguageSupport | null
  onChange?: (content: string) => void
}): DiffEditorHandle {
  let mergeView: MergeView | null = null
  let editorView: EditorView | null = null

  // Compartment for the mutable readOnly/onChange extensions on the
  // modifiable pane. Reconfigured in-place by setReadOnly() — no editor
  // teardown, no scroll displacement.
  const editableCompartment = new Compartment()

  const base = baseExtensions({
    theme: opts.theme,
    language: opts.language,
  })

  if (opts.diffStyle === "split") {
    mergeView = new MergeView({
      parent: opts.parent,
      a: {
        doc: opts.original,
        extensions: [
          ...base,
          // Original pane is always readOnly, no compartment needed
          ...editableExtensions({ readOnly: true }),
        ],
      },
      b: {
        doc: opts.modified,
        extensions: [
          ...base,
          editableCompartment.of(
            editableExtensions({
              readOnly: opts.readOnly,
              onChange: opts.readOnly ? undefined : opts.onChange,
            }),
          ),
        ],
      },
    })

    // MergeView.dom is the PARENT of .cm-editor, so EditorView.theme()
    // selectors (scoped under .cm-editor) can't target it. Set height
    // directly so the MergeView fills its container and scrolls.
    mergeView.dom.style.height = "100%"
    mergeView.dom.style.overflow = "auto"
  } else {
    // Unified mode: @codemirror/merge's unifiedMergeView — the standard CM6
    // inline diff that interleaves deleted lines with the editable document.
    const extensions: Extension[] = [
      ...base,
      editableCompartment.of(
        editableExtensions({
          readOnly: opts.readOnly,
          onChange: opts.readOnly ? undefined : opts.onChange,
        }),
      ),
      unifiedMergeView({
        original: EditorState.create({ doc: opts.original }).doc,
        mergeControls: false,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
      }),
    ]

    editorView = new EditorView({
      state: EditorState.create({
        doc: opts.modified,
        extensions,
      }),
      parent: opts.parent,
    })

    // Ensure the editor fills and scrolls within its container
    editorView.dom.style.height = "100%"
  }

  function getActiveView(): EditorView | null {
    if (mergeView) return mergeView.b
    return editorView
  }

  return {
    get editorView() {
      return getActiveView()
    },
    get mergeView() {
      return mergeView
    },
    get scrollDOM(): HTMLElement | null {
      // Split mode: mergeView.dom is the scrollable container (overflow: auto)
      if (mergeView) return mergeView.dom
      // Unified mode: EditorView.scrollDOM is the CM6 scroll element
      if (editorView) return editorView.scrollDOM
      return null
    },
    destroy() {
      mergeView?.destroy()
      editorView?.destroy()
      mergeView = null
      editorView = null
    },
    revert(original: string) {
      const view = getActiveView()
      if (!view) return

      // Replace entire document with original
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: original,
        },
      })
    },
    getContent() {
      const view = getActiveView()
      return view?.state.doc.toString() ?? ""
    },
    updateOriginal(text: string) {
      if (mergeView) {
        // Split mode: dispatch minimal change to the A (original) pane
        const aView = mergeView.a
        const current = aView.state.doc.toString()
        const change = minimalChanges(current, text)
        if (!change) return
        aView.dispatch({
          changes: change,
          annotations: Transaction.addToHistory.of(false),
        })
      } else if (editorView) {
        // Unified mode: update via originalDocChangeEffect
        const origDoc = getOriginalDoc(editorView.state)
        const currentText = origDoc.toString()
        if (currentText === text) return
        const changes = ChangeSet.of(
          { from: 0, to: origDoc.length, insert: text },
          origDoc.length,
        )
        editorView.dispatch({
          effects: originalDocChangeEffect(editorView.state, changes),
          annotations: Transaction.addToHistory.of(false),
        })
      }
    },
    updateModified(text: string) {
      const view = getActiveView()
      if (!view) return
      const current = view.state.doc.toString()
      const change = minimalChanges(current, text)
      if (!change) return
      view.dispatch({
        changes: change,
        annotations: Transaction.addToHistory.of(false),
      })
    },
    setReadOnly(readOnly: boolean, onChange?: (content: string) => void) {
      const view = getActiveView()
      if (!view) return
      view.dispatch({
        effects: editableCompartment.reconfigure(
          editableExtensions({ readOnly, onChange }),
        ),
      })
    },
  }
}

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
// Minimal change computation — shared by updateOriginal / updateModified
// ---------------------------------------------------------------------------

/**
 * Compute the smallest `{from, to, insert}` that transforms `oldText` into
 * `newText`, via common-prefix / common-suffix scan.  Returns `null` when the
 * two strings are identical (no change needed).
 *
 * This gives CM6 a focused change description so its internal scroll mapping
 * adjusts the viewport correctly — a full-document replace (`{from: 0,
 * to: doc.length, insert: newText}`) would reset scroll to the top.
 */
export function minimalChanges(
  oldText: string,
  newText: string,
): { from: number; to: number; insert: string } | null {
  if (oldText === newText) return null

  // Find common prefix length
  let prefix = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (prefix < minLen && oldText[prefix] === newText[prefix]) prefix++

  // Find common suffix length (must not overlap with prefix)
  let oldSuffix = oldText.length
  let newSuffix = newText.length
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix--
    newSuffix--
  }

  return {
    from: prefix,
    to: oldSuffix,
    insert: newText.slice(prefix, newSuffix),
  }
}

// ---------------------------------------------------------------------------
// Scroll preservation helper
// ---------------------------------------------------------------------------

/**
 * Walk up from `el` to find the nearest ancestor with a non-zero scrollTop.
 * Returns the element and its scrollTop, or null if nothing is scrolled.
 *
 * Used by the SolidJS wrapper to save/restore the parent scroll container's
 * position across CM6 teardown/recreate cycles — the container's innerHTML
 * clear resets the parent's scrollTop before any async event can capture it.
 */
export function findScrollParent(
  el: HTMLElement,
): { element: HTMLElement; scrollTop: number } | null {
  let node: HTMLElement | null = el.parentElement
  while (node) {
    if (node.scrollTop > 0) {
      return { element: node, scrollTop: node.scrollTop }
    }
    node = node.parentElement
  }
  return null
}

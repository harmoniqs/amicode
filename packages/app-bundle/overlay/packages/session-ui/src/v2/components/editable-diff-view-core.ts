/**
 * EditableDiffView — CodeMirror 6 core logic.
 *
 * Pure logic layer: editor construction, diff-specific helpers.
 * General-purpose CM6 setup (theme, language, extensions) lives in
 * editor-core.ts and is re-exported here for backward compatibility.
 * The SolidJS component wrapper lives in editable-diff-view.tsx and uses
 * these functions. Tests import this file directly (no JSX transform needed).
 *
 * @module
 */

import { Compartment, EditorState, Transaction, ChangeSet, type Extension } from "@codemirror/state"
import {
  EditorView,
} from "@codemirror/view"
import { isolateHistory } from "@codemirror/commands"
import {
  MergeView,
  unifiedMergeView,
  originalDocChangeEffect,
  getOriginalDoc,
} from "@codemirror/merge"
import type { LanguageSupport } from "@codemirror/language"

// Re-export everything from editor-core for backward compatibility.
// Existing consumers that import from this file continue to work unchanged.
export {
  externalUpdate,
  loadLanguage,
  buildThemeExtension,
  buildSyntaxHighlightStyle,
  editableExtensions,
  baseExtensions,
  detectMode,
} from "./editor-core"

import {
  externalUpdate,
  baseExtensions,
  editableExtensions,
} from "./editor-core"

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
  /** Revert to original: replace content (the revert itself is undoable via Cmd+Z). */
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

  // Stash a lightweight bridge on the parent element so the global clipboard
  // handler can read/cut the CM6 model selection without importing @codemirror/*.
  ;(opts.parent as any).__amcEditor = {
    getSelectedText(): string {
      const view = getActiveView()
      if (!view) return ""
      const { from, to } = view.state.selection.main
      return from < to ? view.state.sliceDoc(from, to) : ""
    },
    cutSelectedText(): string {
      const view = getActiveView()
      if (!view) return ""
      const { from, to } = view.state.selection.main
      if (from >= to) return ""
      const text = view.state.sliceDoc(from, to)
      if (!view.state.readOnly) {
        view.dispatch({ changes: { from, to }, userEvent: "delete.cut" })
      }
      return text
    },
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
      delete (opts.parent as any).__amcEditor
    },
    revert(original: string) {
      const view = getActiveView()
      if (!view) return

      // Replace entire document with original — mark as external so
      // the onChange listener does not fire (the caller handles state).
      // isolateHistory ensures the revert is its own undo group so
      // Cmd+Z after revert restores the pre-revert edits (D7).
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: original,
        },
        annotations: [
          externalUpdate.of(true),
          isolateHistory.of("full"),
        ],
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
          annotations: [
            Transaction.addToHistory.of(false),
            externalUpdate.of(true),
          ],
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
          annotations: [
            Transaction.addToHistory.of(false),
            externalUpdate.of(true),
          ],
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
        annotations: [
          Transaction.addToHistory.of(false),
          externalUpdate.of(true),
        ],
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

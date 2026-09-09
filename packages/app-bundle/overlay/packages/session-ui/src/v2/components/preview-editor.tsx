/**
 * preview-editor — CodeMirror 6 editor for the Preview tab.
 *
 * A plain EditorView (no MergeView, no diff) using the shared editor-core.ts
 * functions. Supports debounced autosave, Cmd/Ctrl+S, and the VS Code
 * clipboard bridge (data-amc-clipboard attribute + __amcEditor stash).
 *
 * Slice 4 of #912.
 *
 * @module
 */

import { createEffect, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { EditorView } from "@codemirror/view"
import { Compartment, EditorState } from "@codemirror/state"
import { keymap } from "@codemirror/view"
import type { LanguageSupport } from "@codemirror/language"
import {
  baseExtensions,
  editableExtensions,
  loadLanguage,
  buildThemeExtension,
  detectMode,
  externalUpdate,
} from "./editor-core"

export function PreviewEditor(props: {
  content: string
  filePath: string
  onChange: (content: string) => void
  onSave: () => void
  zoom?: () => number
}) {
  let containerRef!: HTMLDivElement
  let editorView: EditorView | null = null
  const [langSupport, setLangSupport] = createSignal<LanguageSupport | null>(null)
  const editableCompartment = new Compartment()
  const zoomCompartment = new Compartment()

  // Base editor font size (matches editor-core.ts buildThemeExtension "&" fontSize)
  const BASE_FONT_SIZE = 13

  /** Build a CM6 theme extension that scales fontSize by zoom level. */
  const buildZoomTheme = (zoomPercent: number) =>
    EditorView.theme({
      "&": { fontSize: `${BASE_FONT_SIZE * zoomPercent / 100}px` },
    })

  // Load language support
  onMount(async () => {
    // Extract extension from filepath
    const parts = props.filePath.split(".")
    const ext = parts.length > 1 ? parts[parts.length - 1] : "txt"
    const lang = await loadLanguage(ext)
    setLangSupport(lang)
  })

  // Create editor on mount + when language changes
  createEffect(() => {
    const lang = langSupport()
    const mode = detectMode()
    const theme = buildThemeExtension(mode)

    // Read content without tracking to avoid re-creation on every change
    const content = untrack(() => props.content)
    const onChange = untrack(() => props.onChange)
    const onSave = untrack(() => props.onSave)

    // Tear down previous editor
    if (editorView) {
      editorView.destroy()
      editorView = null
    }
    if (!containerRef) return
    containerRef.innerHTML = ""

    const saveKeymap = keymap.of([{
      key: "Mod-s",
      run: () => {
        onSave()
        return true
      },
    }])

    editorView = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          ...baseExtensions({ theme, language: lang }),
          editableCompartment.of(
            editableExtensions({
              readOnly: false,
              onChange,
            }),
          ),
          zoomCompartment.of(buildZoomTheme(props.zoom?.() ?? 100)),
          saveKeymap,
        ],
      }),
      parent: containerRef,
    })

    // Fill the container
    editorView.dom.style.height = "100%"

    // Stash the clipboard bridge on the container
    ;(containerRef as any).__amcEditor = {
      getSelectedText(): string {
        if (!editorView) return ""
        const { from, to } = editorView.state.selection.main
        return from < to ? editorView.state.sliceDoc(from, to) : ""
      },
      cutSelectedText(): string {
        if (!editorView) return ""
        const { from, to } = editorView.state.selection.main
        if (from >= to) return ""
        const text = editorView.state.sliceDoc(from, to)
        if (!editorView.state.readOnly) {
          editorView.dispatch({ changes: { from, to }, userEvent: "delete.cut" })
        }
        return text
      },
    }
  })

  // Update content when it changes externally (e.g. file reload)
  createEffect(() => {
    const content = props.content
    if (!editorView) return
    const current = editorView.state.doc.toString()
    if (current === content) return

    // External update — don't trigger onChange
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: content },
      annotations: [externalUpdate.of(true)],
    })
  })

  // Reactively reconfigure zoom font-size when the zoom prop changes
  createEffect(() => {
    const zoomValue = props.zoom?.() ?? 100
    if (!editorView) return
    editorView.dispatch({
      effects: zoomCompartment.reconfigure(buildZoomTheme(zoomValue)),
    })
  })

  onCleanup(() => {
    if (editorView) {
      editorView.destroy()
      editorView = null
    }
    if (containerRef) {
      delete (containerRef as any).__amcEditor
    }
  })

  return (
    <div
      ref={containerRef!}
      data-amc-clipboard="codemirror"
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        position: "relative",
      }}
    />
  )
}

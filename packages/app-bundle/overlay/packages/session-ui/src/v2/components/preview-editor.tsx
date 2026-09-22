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
import { clampEditorSelection, shouldCaptureOnUpdate, type PreviewEditorViewState } from "./preview-view-state"
import { clampVisibleLine, anchoredScrollTop, initialHidden } from "./preview-editor-helpers"

export function PreviewEditor(props: {
  content: string
  filePath: string
  /** #1365/#1366: true when this preview tab is selected (retained-pool visibility). */
  active?: () => boolean
  onChange: (content: string) => void
  onSave: () => void
  zoom?: () => number
  /** #1250: last-saved view-state for this document (from the layout cache). */
  viewState?: () => PreviewEditorViewState | undefined
  /** #1250: persist a view-state change back to the layout cache. */
  onViewStateChange?: (state: PreviewEditorViewState) => void
}) {
  let containerRef!: HTMLDivElement
  let editorView: EditorView | null = null
  const [langSupport, setLangSupport] = createSignal<LanguageSupport | null>(null)
  const [fileExt, setFileExt] = createSignal<string>("txt")
  const editableCompartment = new Compartment()
  const zoomCompartment = new Compartment()

  // #1366: retained-pool tab-switch lifecycle. `hidden` gates the capture
  // listeners so the geometry collapse on display:none never writes a bogus
  // scrollTop=0 into the cache. `hadFocus` is sticky: once the editor receives
  // focus, it stays true for this instance's lifetime so we always refocus on
  // return from any tab switch (side-panel, session, or preview-tab). Clearing
  // it on focusout was unreliable across all transition types.
  let hidden = initialHidden(props.active)
  let hadFocus = false
  let prevActive = props.active ? props.active() : true
  const onFocusIn = () => { hadFocus = true }

  // Base editor font size (matches editor-core.ts buildThemeExtension "&" fontSize)
  const BASE_FONT_SIZE = 13

  /** Build a CM6 theme extension that scales fontSize by zoom level. */
  const buildZoomTheme = (zoomPercent: number) =>
    EditorView.theme({
      "&": { fontSize: `${BASE_FONT_SIZE * zoomPercent / 100}px` },
    })

  /** Snapshot the live selection + scroll of a view. */
  const snapshot = (view: EditorView): PreviewEditorViewState => {
    const sel = view.state.selection.main
    const scroller = view.scrollDOM
    return {
      anchor: sel.anchor,
      head: sel.head,
      scrollTop: scroller?.scrollTop ?? 0,
      scrollLeft: scroller?.scrollLeft ?? 0,
    }
  }

  /** Persist the live view-state to the caller-owned store. */
  const captureViewState = () => {
    if (hidden) return
    if (!editorView || !props.onViewStateChange) return
    props.onViewStateChange(snapshot(editorView))
  }

  /**
   * Restore a saved scroll offset in CM6's measure cycle — after layout, no
   * timer. Selection is restored separately (in the creating state or the
   * content-reload transaction) so it never flashes at the top first.
   */
  const restoreScroll = (view: EditorView, state: PreviewEditorViewState) => {
    view.requestMeasure({
      read: () => null,
      write: () => {
        const scroller = view.scrollDOM
        if (!scroller) return
        scroller.scrollTop = state.scrollTop
        scroller.scrollLeft = state.scrollLeft
      },
    })
  }

  // Load language support
  onMount(async () => {
    // Extract extension from filepath
    const parts = props.filePath.split(".")
    const ext = parts.length > 1 ? parts[parts.length - 1] : "txt"
    setFileExt(ext)
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
    // Read the saved view-state untracked — restoring must not make this
    // effect reactive to cursor moves (that would recreate the editor).
    const saved = untrack(() => props.viewState?.())

    // Tear down previous editor (persisting its state first).
    if (editorView) {
      captureViewState()
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

    // Restore the selection range in the creating state so it is present on
    // the first paint (no top-of-doc flash). Clamp to the current document.
    const selection = saved ? clampEditorSelection(saved, content.length) : undefined

    // Live capture of selection + scroll into the caller-owned store. Excludes
    // geometryChanged (see shouldCaptureOnUpdate) — capturing there forces a
    // reflow inside CM6's measure cycle and freezes the webview.
    const captureListener = EditorView.updateListener.of((update) => {
      if (shouldCaptureOnUpdate(update)) captureViewState()
    })

    editorView = new EditorView({
      state: EditorState.create({
        doc: content,
        ...(selection ? { selection } : {}),
        extensions: [
          ...baseExtensions({ theme, language: lang, lang: fileExt() }),
          editableCompartment.of(
            editableExtensions({
              readOnly: false,
              onChange,
            }),
          ),
          zoomCompartment.of(buildZoomTheme(props.zoom?.() ?? 100)),
          captureListener,
          saveKeymap,
        ],
      }),
      parent: containerRef,
    })

    // Fill the container
    editorView.dom.style.height = "100%"

    // Save scroll on scroller events too (updateListener catches selection/doc,
    // but a plain user scroll with no doc/selection change is a scroll event).
    const scroller = editorView.scrollDOM
    if (scroller) scroller.addEventListener("scroll", captureViewState, { passive: true })

    // #1366: track focus for tab-switch restoration.
    editorView.dom.addEventListener("focusin", onFocusIn)

    // Restore scroll after layout (deterministic, in the measure cycle).
    if (saved) restoreScroll(editorView, saved)

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

  // Update content when it changes externally (e.g. file reload after compile,
  // agent edit, external tool). Preserve the user's reading position by
  // anchoring to the FIRST VISIBLE line and its viewport offset — a full doc
  // replacement shifts absolute scrollTop when lines are added/removed above the
  // viewport, and anchoring to the cursor jumps the view when the user has
  // scrolled away from it. (#1250, #1414)
  createEffect(() => {
    const content = props.content
    if (!editorView) return
    const view = editorView
    const current = view.state.doc.toString()
    if (current === content) return

    const before = snapshot(view)
    const selection = clampEditorSelection(before, content.length)

    // Record the first visible line + its offset within the viewport before swap
    const firstVisiblePos = view.viewport.from
    const firstVisibleLine = view.state.doc.lineAt(firstVisiblePos).number
    const viewportOffset = before.scrollTop - view.lineBlockAt(firstVisiblePos).top

    // External update — don't trigger onChange — with selection preserved in
    // the same transaction so it never resets to offset 0.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection,
      annotations: [externalUpdate.of(true)],
    })

    // Scroll so the same first-visible line sits at the same viewport offset in
    // the new document. Double-rAF ensures CM6 has fully laid out the new
    // content before we read coordinates and scroll.
    const newDoc = view.state.doc
    const targetLine = clampVisibleLine(firstVisibleLine, newDoc.lines)
    const targetPos = newDoc.line(targetLine).from
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!editorView) return
      const scroller = editorView.scrollDOM
      if (!scroller) return
      try {
        const lineBlock = editorView.lineBlockAt(targetPos)
        scroller.scrollTop = anchoredScrollTop(lineBlock.top, viewportOffset)
        scroller.scrollLeft = before.scrollLeft
      } catch {}
    }))
  })

  // #1366: retained-pool show/hide lifecycle. On hide we freeze capture;
  // on show we restore the last-good scroll and refocus iff editor had focus.
  createEffect(() => {
    const isActive = props.active ? props.active() : true
    const wasActive = prevActive
    prevActive = isActive
    if (isActive === wasActive) return
    const view = editorView
    if (!view) return
    if (isActive) {
      hidden = false
      const saved = untrack(() => props.viewState?.())
      if (saved) restoreScroll(view, saved)
      // Defer focus restore past the inert-removal frame: the side-panel's
      // inert attribute is removed in the same Solid batch, and the browser's
      // focus restoration from inert removal runs before a single rAF.
      // A double-rAF ensures we run after that browser-level focus move.
      if (hadFocus) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (editorView) editorView.focus()
      }))
    } else {
      hidden = true
    }
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
      // Final capture — belt-and-suspenders alongside the live listeners.
      captureViewState()
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

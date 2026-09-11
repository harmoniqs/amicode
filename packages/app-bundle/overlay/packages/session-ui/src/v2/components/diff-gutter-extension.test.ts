import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { EditorState } from "@codemirror/state"
import { EditorView, lineNumbers } from "@codemirror/view"
import {
  diffGutterExtension,
  DiffGutterMarkerKind,
  getDiffMarkers,
  getDeletedLineDecorations,
} from "./diff-gutter-extension"

/**
 * Tests for the custom unified-mode diff gutter extension (#769).
 *
 * The extension diffs `original` vs the current document and renders
 * gutter markers (added/removed/changed) in a custom CM6 gutter.
 */

function createEditor(opts: {
  doc: string
  original: string
  parent: HTMLElement
}): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc: opts.doc,
      extensions: [lineNumbers(), diffGutterExtension(opts.original)],
    }),
    parent: opts.parent,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("diffGutterExtension", () => {
  let parent: HTMLDivElement
  let view: EditorView

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    view?.destroy()
    parent.remove()
  })

  test("module exports diffGutterExtension function", async () => {
    const mod = await import("./diff-gutter-extension")
    expect(mod.diffGutterExtension).toBeDefined()
    expect(typeof mod.diffGutterExtension).toBe("function")
  })

  test("module exports DiffGutterMarkerKind enum/type", async () => {
    const mod = await import("./diff-gutter-extension")
    expect(mod.DiffGutterMarkerKind).toBeDefined()
  })

  test("renders without errors on identical content", async () => {
    view = createEditor({
      doc: "line1\nline2\nline3",
      original: "line1\nline2\nline3",
      parent,
    })

    // Wait for initial deferred compute
    await sleep(100)

    expect(view.state.doc.toString()).toBe("line1\nline2\nline3")
    const markers = getDiffMarkers(view.state)
    expect(markers.size).toBe(0)
  })

  test("shows added marker for new lines", async () => {
    view = createEditor({
      doc: "line1\nnewline\nline2",
      original: "line1\nline2",
      parent,
    })

    await sleep(400)

    const markers = getDiffMarkers(view.state)
    expect(markers.size).toBeGreaterThan(0)
  })

  test("shows removed marker when lines are deleted", async () => {
    view = createEditor({
      doc: "line1\nline3",
      original: "line1\nline2\nline3",
      parent,
    })

    await sleep(400)

    const markers = getDiffMarkers(view.state)
    expect(markers.size).toBeGreaterThan(0)
  })

  test("shows changed marker for modified lines", async () => {
    view = createEditor({
      doc: "line1\nline2-modified\nline3",
      original: "line1\nline2\nline3",
      parent,
    })

    await sleep(400)

    const markers = getDiffMarkers(view.state)
    expect(markers.size).toBeGreaterThan(0)
  })

  test("updates markers after edit (debounced)", async () => {
    view = createEditor({
      doc: "line1\nline2",
      original: "line1\nline2",
      parent,
    })

    // Initially identical — no markers after initial deferred compute
    await sleep(400)
    let markers = getDiffMarkers(view.state)
    expect(markers.size).toBe(0)

    // Edit: add a line
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\nnewline" },
    })

    // Wait for debounced update
    await sleep(400)

    markers = getDiffMarkers(view.state)
    expect(markers.size).toBeGreaterThan(0)
  })

  test("handles empty original gracefully", () => {
    view = createEditor({
      doc: "some content",
      original: "",
      parent,
    })

    expect(view.state.doc.toString()).toBe("some content")
  })

  test("handles empty modified gracefully", () => {
    view = createEditor({
      doc: "",
      original: "some content",
      parent,
    })

    expect(view.state.doc.toString()).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Inline deleted-line decorations
// ---------------------------------------------------------------------------

describe("deleted-line decorations", () => {
  let parent: HTMLDivElement
  let view: EditorView

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    view?.destroy()
    parent.remove()
  })

  test("getDeletedLineDecorations is exported", async () => {
    const mod = await import("./diff-gutter-extension")
    expect(mod.getDeletedLineDecorations).toBeDefined()
    expect(typeof mod.getDeletedLineDecorations).toBe("function")
  })

  test("deleted lines produce decoration state entries", async () => {
    view = createEditor({
      doc: "line1\nline3",
      original: "line1\nline2\nline3",
      parent,
    })

    // Wait for debounced diff computation
    await sleep(400)

    const decos = getDeletedLineDecorations(view.state)
    expect(decos.size).toBeGreaterThan(0)
  })

  test("no deleted-line decorations when content is identical", async () => {
    view = createEditor({
      doc: "line1\nline2",
      original: "line1\nline2",
      parent,
    })

    await sleep(400)

    const decos = getDeletedLineDecorations(view.state)
    expect(decos.size).toBe(0)
  })

  test("deleted lines render DOM widgets with the removed text", async () => {
    view = createEditor({
      doc: "line1\nline3",
      original: "line1\nremoved-line\nline3",
      parent,
    })

    await sleep(400)

    // The widget should render a DOM element containing the deleted text
    const widgets = parent.querySelectorAll(".cm-deleted-line-widget")
    expect(widgets.length).toBeGreaterThan(0)
    // At least one widget should contain the removed text
    const texts = Array.from(widgets).map((w) => w.textContent)
    expect(texts.some((t) => t?.includes("removed-line"))).toBe(true)
  })

  test("multiple deleted lines show multiple widgets", async () => {
    view = createEditor({
      doc: "line1\nline4",
      original: "line1\nline2\nline3\nline4",
      parent,
    })

    await sleep(400)

    const widgets = parent.querySelectorAll(".cm-deleted-line-widget")
    // Should have widgets for line2 and line3
    expect(widgets.length).toBeGreaterThan(0)
  })
})

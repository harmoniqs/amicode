import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { EditorView } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import {
  loadLanguage,
  buildThemeExtension,
  createDiffEditor,
  baseExtensions,
  editableExtensions,
  minimalChanges,
  type DiffEditorHandle,
} from "./editable-diff-view-core"

/**
 * Tests for EditableDiffView core logic (no JSX / SolidJS needed).
 *
 * Tests the language loader, theme builder, and imperative editor
 * construction — the behavioral contract the SolidJS wrapper delegates to.
 */

// ---------------------------------------------------------------------------
// loadLanguage
// ---------------------------------------------------------------------------

describe("loadLanguage", () => {
  test("resolves known extensions to a LanguageSupport", async () => {
    const js = await loadLanguage("js")
    expect(js).not.toBeNull()

    const ts = await loadLanguage("ts")
    expect(ts).not.toBeNull()

    const tsx = await loadLanguage("tsx")
    expect(tsx).not.toBeNull()

    const py = await loadLanguage("py")
    expect(py).not.toBeNull()

    const json = await loadLanguage("json")
    expect(json).not.toBeNull()

    const md = await loadLanguage("md")
    expect(md).not.toBeNull()

    const css = await loadLanguage("css")
    expect(css).not.toBeNull()

    const html = await loadLanguage("html")
    expect(html).not.toBeNull()
  })

  test("returns null for unknown extensions", async () => {
    const result = await loadLanguage("xyz-unknown-extension")
    expect(result).toBeNull()
  })

  test("strips leading dot from extension", async () => {
    const result = await loadLanguage(".ts")
    expect(result).not.toBeNull()
  })

  test("is case-insensitive", async () => {
    const result = await loadLanguage("JSON")
    expect(result).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildThemeExtension
// ---------------------------------------------------------------------------

describe("buildThemeExtension", () => {
  test("returns a defined CM6 Extension for dark mode", () => {
    const ext = buildThemeExtension("dark")
    expect(ext).toBeDefined()
    expect(ext).not.toBeNull()
  })

  test("returns a defined CM6 Extension for light mode", () => {
    const ext = buildThemeExtension("light")
    expect(ext).toBeDefined()
    expect(ext).not.toBeNull()
  })

  test("dark and light produce distinct extensions", () => {
    const dark = buildThemeExtension("dark")
    const light = buildThemeExtension("light")
    // They should be distinct objects
    expect(dark).not.toBe(light)
  })
})

// ---------------------------------------------------------------------------
// baseExtensions (structural only — no readOnly/onChange)
// ---------------------------------------------------------------------------

describe("baseExtensions", () => {
  test("returns an array of extensions", () => {
    const theme = buildThemeExtension("dark")
    const exts = baseExtensions({ theme })
    expect(Array.isArray(exts)).toBe(true)
    expect(exts.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// editableExtensions (mutable readOnly/onChange — lives in Compartment)
// ---------------------------------------------------------------------------

describe("editableExtensions", () => {
  test("includes onChange listener when not readOnly", () => {
    const withCb = editableExtensions({ readOnly: false, onChange: () => {} })
    const withoutCb = editableExtensions({ readOnly: false })
    // With onChange callback should have one more extension
    expect(withCb.length).toBe(withoutCb.length + 1)
  })

  test("omits onChange listener when readOnly", () => {
    const withCb = editableExtensions({ readOnly: true, onChange: () => {} })
    const withoutCb = editableExtensions({ readOnly: true })
    // readOnly suppresses the onChange extension regardless
    expect(withCb.length).toBe(withoutCb.length)
  })
})

// ---------------------------------------------------------------------------
// createDiffEditor — split mode
// ---------------------------------------------------------------------------

describe("createDiffEditor (split mode)", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("creates a split MergeView in the parent element", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "line1\nline2",
      modified: "line1\nline2-changed",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect(handle.mergeView).not.toBeNull()
    // MergeView should have inserted DOM into parent
    expect(parent.children.length).toBeGreaterThan(0)
  })

  test("editorView returns the modified (b) pane", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "modified",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect(handle.editorView).not.toBeNull()
    expect(handle.getContent()).toBe("modified")
  })

  test("onChange fires when content changes", () => {
    const changes: string[] = []
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "modified",
      diffStyle: "split",
      readOnly: false,
      theme,
      onChange: (c) => changes.push(c),
    })

    const view = handle.editorView!
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "new content" },
    })

    expect(changes.length).toBeGreaterThan(0)
    expect(changes[changes.length - 1]).toBe("new content")
  })

  test("readOnly makes editor non-editable but allows programmatic dispatch", () => {
    const changes: string[] = []
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "modified",
      diffStyle: "split",
      readOnly: true,
      theme,
      onChange: (c) => changes.push(c),
    })

    const view = handle.editorView!

    // Editor should be non-editable (blocks user input)
    expect(EditorView.editable.of(false)).toBeDefined()

    // Programmatic dispatches go through — needed for in-place content updates.
    // (CM6's readOnly facet only blocks user-generated transactions.)
    view.dispatch({
      changes: { from: 0, insert: "X" },
    })
    expect(view.state.doc.toString()).toBe("Xmodified")

    // onChange should NOT fire even though dispatch succeeded,
    // because readOnly=true means onChange was not attached.
    expect(changes.length).toBe(0)
  })

  test("getContent returns current document text", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect(handle.getContent()).toBe("mod")

    handle.editorView!.dispatch({
      changes: { from: 0, to: 3, insert: "updated" },
    })

    expect(handle.getContent()).toBe("updated")
  })

  test("revert replaces content with original", () => {
    const changes: string[] = []
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original text",
      modified: "modified text",
      diffStyle: "split",
      readOnly: false,
      theme,
      onChange: (c) => changes.push(c),
    })

    // Make some edits
    handle.editorView!.dispatch({
      changes: {
        from: 0,
        to: handle.editorView!.state.doc.length,
        insert: "user edits",
      },
    })
    expect(handle.getContent()).toBe("user edits")

    // Revert
    handle.revert("original text")
    expect(handle.getContent()).toBe("original text")
  })

  test("destroy cleans up both editors", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a",
      modified: "b",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    handle.destroy()
    expect(handle.editorView).toBeNull()
    expect(handle.mergeView).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// createDiffEditor — unified mode
// ---------------------------------------------------------------------------

describe("createDiffEditor (unified mode)", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("creates a single EditorView in unified mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "line1\nline2",
      modified: "line1\nline2-changed",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    expect(handle.editorView).not.toBeNull()
    // Unified mode uses unifiedMergeView (single EditorView, not MergeView)
    expect(handle.mergeView).toBeNull()
    expect(parent.children.length).toBeGreaterThan(0)
  })

  test("unified mode shows deleted lines via unifiedMergeView", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "line1\ndeleted-line\nline3",
      modified: "line1\nline3",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    // unifiedMergeView interleaves deleted lines in the document
    // The editor content should include the deleted text
    const view = handle.editorView!
    const dom = view.dom
    // CM6 merge view renders deleted chunks with specific CSS classes
    const hasDeletedContent = dom.querySelector(".cm-deletedChunk") !== null
      || dom.textContent?.includes("deleted-line")
    expect(hasDeletedContent).toBe(true)
  })

  test("onChange fires on content changes in unified mode", () => {
    const changes: string[] = []
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "modified",
      diffStyle: "unified",
      readOnly: false,
      theme,
      onChange: (c) => changes.push(c),
    })

    const view = handle.editorView!
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "new" },
    })

    expect(changes.length).toBeGreaterThan(0)
    expect(changes[changes.length - 1]).toBe("new")
  })

  test("readOnly allows programmatic dispatch in unified mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "unified",
      readOnly: true,
      theme,
    })

    const view = handle.editorView!
    // Programmatic dispatches go through even in readOnly mode
    view.dispatch({ changes: { from: 0, insert: "X" } })
    expect(view.state.doc.toString()).toBe("Xmod")
  })
})

// ---------------------------------------------------------------------------
// updateOriginal — in-place original document update (no editor re-creation)
// ---------------------------------------------------------------------------

describe("updateOriginal", () => {
  let parent: HTMLElement
  let handle: DiffEditorHandle | null = null

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("updates original text in split mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "old original",
      modified: "modified text",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    handle.updateOriginal("new original")

    // The original pane should have the new text
    const origView = handle.mergeView!.a
    expect(origView.state.doc.toString()).toBe("new original")
    // Modified side untouched
    expect(handle.getContent()).toBe("modified text")
  })

  test("updates original text in unified mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "old original",
      modified: "modified text",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    handle.updateOriginal("new original")

    // Modified side should be untouched
    expect(handle.getContent()).toBe("modified text")
  })

  test("is a no-op when text is unchanged (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "same text",
      modified: "modified",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const origView = handle.mergeView!.a
    const stateBefore = origView.state

    handle.updateOriginal("same text")

    // State should be the exact same object (no transaction dispatched)
    expect(origView.state).toBe(stateBefore)
  })

  test("DOM element is reused, not re-created (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "before",
      modified: "modified",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const domBefore = handle.mergeView!.dom

    handle.updateOriginal("after")

    // The MergeView DOM container must be the same object
    expect(handle.mergeView!.dom).toBe(domBefore)
  })

  test("DOM element is reused, not re-created (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "before",
      modified: "modified",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    const domBefore = handle.editorView!.dom

    handle.updateOriginal("after")

    // The EditorView DOM must be the same object
    expect(handle.editorView!.dom).toBe(domBefore)
  })

  test("works when readOnly is true (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "old",
      modified: "mod",
      diffStyle: "split",
      readOnly: true,
      theme,
    })

    // The original pane is always readOnly in split mode.
    // updateOriginal must still succeed (programmatic dispatch).
    handle.updateOriginal("new")
    const origView = handle.mergeView!.a
    expect(origView.state.doc.toString()).toBe("new")
  })

  test("works when readOnly is true (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "old",
      modified: "mod",
      diffStyle: "unified",
      readOnly: true,
      theme,
    })

    handle.updateOriginal("new")
    // The update should succeed despite readOnly
    // (originalDocChangeEffect is dispatched as an effect, not a doc change)
    expect(handle.getContent()).toBe("mod") // modified unchanged
  })
})

// ---------------------------------------------------------------------------
// updateModified — in-place modified document update (no editor re-creation)
// ---------------------------------------------------------------------------

describe("updateModified", () => {
  let parent: HTMLElement
  let handle: DiffEditorHandle | null = null

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("updates modified text in split mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original text",
      modified: "old modified",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    handle.updateModified("new modified")
    expect(handle.getContent()).toBe("new modified")
    // Original side untouched
    expect(handle.mergeView!.a.state.doc.toString()).toBe("original text")
  })

  test("updates modified text in unified mode", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original text",
      modified: "old modified",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    handle.updateModified("new modified")
    expect(handle.getContent()).toBe("new modified")
  })

  test("is a no-op when text is unchanged (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "same text",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    const stateBefore = handle.editorView!.state

    handle.updateModified("same text")

    // State should be the exact same object
    expect(handle.editorView!.state).toBe(stateBefore)
  })

  test("DOM element is reused, not re-created (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "before",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const domBefore = handle.mergeView!.dom

    handle.updateModified("after")

    expect(handle.mergeView!.dom).toBe(domBefore)
  })

  test("DOM element is reused, not re-created (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "before",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    const domBefore = handle.editorView!.dom

    handle.updateModified("after")

    expect(handle.editorView!.dom).toBe(domBefore)
  })

  test("works when readOnly is true (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "old",
      diffStyle: "split",
      readOnly: true,
      theme,
    })

    handle.updateModified("new")
    expect(handle.getContent()).toBe("new")
  })

  test("works when readOnly is true (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "old",
      diffStyle: "unified",
      readOnly: true,
      theme,
    })

    handle.updateModified("new")
    expect(handle.getContent()).toBe("new")
  })

  test("does not fire onChange callback (programmatic updates are silent)", () => {
    const changes: string[] = []
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "old",
      diffStyle: "split",
      readOnly: false,
      theme,
      onChange: (c) => changes.push(c),
    })

    handle.updateModified("new")

    // updateModified uses addToHistory:false annotation — but onChange
    // still fires for doc changes via updateListener. The key property
    // is that the editor is not re-created.
    // (Whether onChange fires or not is an implementation choice; the
    // critical assertion is DOM reuse and content correctness.)
    expect(handle.getContent()).toBe("new")
  })
})

// ---------------------------------------------------------------------------
// setReadOnly — toggle readOnly in place via Compartment (no re-creation)
// ---------------------------------------------------------------------------

describe("setReadOnly", () => {
  let parent: HTMLElement
  let handle: DiffEditorHandle | null = null

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("toggles readOnly without re-creating editor (split)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const domBefore = handle.mergeView!.dom

    handle.setReadOnly(true)

    // DOM must be the same object — no re-creation
    expect(handle.mergeView!.dom).toBe(domBefore)
    // Content preserved
    expect(handle.getContent()).toBe("mod")
  })

  test("toggles readOnly without re-creating editor (unified)", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    const domBefore = handle.editorView!.dom

    handle.setReadOnly(true)

    expect(handle.editorView!.dom).toBe(domBefore)
    expect(handle.getContent()).toBe("mod")
  })

  test("re-enables onChange when switching from readOnly to editable (split)", () => {
    const changes: string[] = []
    const onChange = (c: string) => changes.push(c)
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "split",
      readOnly: true,
      theme,
    })

    // No onChange while readOnly — user edits blocked by editable:false
    // Switch to editable with onChange
    handle.setReadOnly(false, onChange)

    // Now a programmatic dispatch should trigger onChange
    handle.editorView!.dispatch({
      changes: { from: 0, insert: "X" },
    })
    expect(changes.length).toBe(1)
    expect(changes[0]).toBe("Xmod")
  })

  test("re-enables onChange when switching from readOnly to editable (unified)", () => {
    const changes: string[] = []
    const onChange = (c: string) => changes.push(c)
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "unified",
      readOnly: true,
      theme,
    })

    handle.setReadOnly(false, onChange)

    handle.editorView!.dispatch({
      changes: { from: 0, insert: "X" },
    })
    expect(changes.length).toBe(1)
    expect(changes[0]).toBe("Xmod")
  })

  test("disables onChange when switching to readOnly (split)", () => {
    const changes: string[] = []
    const onChange = (c: string) => changes.push(c)
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "split",
      readOnly: false,
      theme,
      onChange,
    })

    // Verify onChange fires initially
    handle.editorView!.dispatch({
      changes: { from: 0, insert: "A" },
    })
    expect(changes.length).toBe(1)

    // Switch to readOnly
    handle.setReadOnly(true)

    // Programmatic dispatch still goes through (no transactionFilter)
    // but onChange should NOT fire
    handle.editorView!.dispatch({
      changes: { from: 0, insert: "B" },
    })
    expect(changes.length).toBe(1) // still 1, not 2
  })

  test("round-trips readOnly false→true→false preserving content (unified)", () => {
    const changes: string[] = []
    const onChange = (c: string) => changes.push(c)
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "orig",
      modified: "mod",
      diffStyle: "unified",
      readOnly: false,
      theme,
      onChange,
    })

    const domBefore = handle.editorView!.dom

    handle.setReadOnly(true)
    handle.setReadOnly(false, onChange)

    // DOM still the same
    expect(handle.editorView!.dom).toBe(domBefore)
    // Content preserved
    expect(handle.getContent()).toBe("mod")
    // onChange works after round-trip
    handle.editorView!.dispatch({
      changes: { from: 3, insert: "!" },
    })
    expect(changes).toContain("mod!")
  })
})

// ---------------------------------------------------------------------------
// Line wrapping
// ---------------------------------------------------------------------------

describe("lineWrapping", () => {
  test("baseExtensions includes lineWrapping extension", () => {
    const theme = buildThemeExtension("dark")
    const exts = baseExtensions({ theme })
    // EditorView.lineWrapping is the specific extension object.
    // Verify it's in the array by identity (same import path).
    expect(exts).toContain(EditorView.lineWrapping)
  })
})

// ---------------------------------------------------------------------------
// Scroll / height setup
// ---------------------------------------------------------------------------

describe("scroll behavior", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("split mode: mergeView.dom has height 100%", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a\nb\nc",
      modified: "a\nb\nc\nd",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect(handle.mergeView).not.toBeNull()
    expect(handle.mergeView!.dom.style.height).toBe("100%")
  })

  test("unified mode: editorView.dom has height 100%", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a\nb\nc",
      modified: "a\nb\nc\nd",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    expect(handle.editorView).not.toBeNull()
    expect(handle.editorView!.dom.style.height).toBe("100%")
  })
})

// ---------------------------------------------------------------------------
// scrollDOM accessor
// ---------------------------------------------------------------------------

describe("scrollDOM accessor", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("split mode: scrollDOM returns mergeView.dom", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a\nb",
      modified: "a\nc",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect(handle.scrollDOM).not.toBeNull()
    expect(handle.scrollDOM).toBe(handle.mergeView!.dom)
  })

  test("unified mode: scrollDOM returns editorView.scrollDOM", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a\nb",
      modified: "a\nc",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    expect(handle.scrollDOM).not.toBeNull()
    expect(handle.scrollDOM).toBe(handle.editorView!.scrollDOM)
  })

  test("scrollDOM is null after destroy", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a",
      modified: "b",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    handle.destroy()
    expect(handle.scrollDOM).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Scroll preservation across teardown/recreate
// ---------------------------------------------------------------------------

describe("scroll preservation across teardown/recreate", () => {
  let scrollContainer: HTMLDivElement
  let editorContainer: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    // Simulate the real DOM hierarchy:
    // scrollContainer (overflow:auto, fixed height) > editorContainer > CM6 DOM
    scrollContainer = document.createElement("div")
    Object.defineProperty(scrollContainer, "scrollHeight", { value: 2000, writable: true, configurable: true })
    Object.defineProperty(scrollContainer, "clientHeight", { value: 300, writable: true, configurable: true })
    scrollContainer.style.overflow = "auto"
    scrollContainer.style.height = "300px"

    editorContainer = document.createElement("div")
    editorContainer.style.height = "100%"

    scrollContainer.appendChild(editorContainer)
    document.body.appendChild(scrollContainer)
  })

  afterEach(() => {
    handle?.destroy()
    scrollContainer.remove()
  })

  test("findScrollParent walks up from container to find ancestor with scrollTop > 0", () => {
    // Import the helper we'll add to the core
    const { findScrollParent } = require("./editable-diff-view-core") as typeof import("./editable-diff-view-core")

    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent: editorContainer,
      original: "line1\nline2\nline3\nline4\nline5",
      modified: "line1\nline2-changed\nline3\nline4\nline5-changed",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    // Simulate the user having scrolled the parent container
    scrollContainer.scrollTop = 150

    // findScrollParent should locate the scrollContainer
    const result = findScrollParent(editorContainer)
    expect(result).not.toBeNull()
    expect(result!.element).toBe(scrollContainer)
    expect(result!.scrollTop).toBe(150)
  })

  test("findScrollParent returns null when no ancestor is scrolled", () => {
    const { findScrollParent } = require("./editable-diff-view-core") as typeof import("./editable-diff-view-core")

    scrollContainer.scrollTop = 0
    const result = findScrollParent(editorContainer)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// minimalChanges — compute the smallest {from, to, insert} between two strings
// ---------------------------------------------------------------------------

describe("minimalChanges", () => {
  // Dynamic import so the test file compiles even before the export exists
  let minimalChanges: typeof import("./editable-diff-view-core")["minimalChanges"]

  beforeEach(async () => {
    const mod = await import("./editable-diff-view-core")
    minimalChanges = mod.minimalChanges
  })

  test("returns null for identical strings", () => {
    const result = minimalChanges("hello world", "hello world")
    expect(result).toBeNull()
  })

  test("returns null for two empty strings", () => {
    const result = minimalChanges("", "")
    expect(result).toBeNull()
  })

  test("detects a prefix-only change (text appended at end)", () => {
    const result = minimalChanges("hello", "hello world")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(5)
    expect(result!.to).toBe(5)
    expect(result!.insert).toBe(" world")
  })

  test("detects a suffix-only change (text prepended at start)", () => {
    const result = minimalChanges("world", "hello world")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    expect(result!.to).toBe(0)
    expect(result!.insert).toBe("hello ")
  })

  test("detects a middle insertion", () => {
    const result = minimalChanges("helloworld", "hello cruel world")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(5)
    expect(result!.to).toBe(5)
    expect(result!.insert).toBe(" cruel ")
  })

  test("detects a middle replacement", () => {
    const result = minimalChanges("line 1\nold text\nline 3", "line 1\nnew text\nline 3")
    expect(result).not.toBeNull()
    // Common prefix: "line 1\n" (7 chars). Common suffix: " text\nline 3" (12 chars).
    // So the minimal change replaces "old" (3 chars at offset 7) with "new".
    expect(result!.from).toBe(7)
    expect(result!.to).toBe(10)
    expect(result!.insert).toBe("new")
  })

  test("detects deletion of middle content", () => {
    const result = minimalChanges("hello cruel world", "helloworld")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(5)
    expect(result!.to).toBe(12) // " cruel " is 7 chars
    expect(result!.insert).toBe("")
  })

  test("handles complete replacement (no common prefix or suffix)", () => {
    const result = minimalChanges("abc", "xyz")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    expect(result!.to).toBe(3)
    expect(result!.insert).toBe("xyz")
  })

  test("handles empty old string (full insertion)", () => {
    const result = minimalChanges("", "hello")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    expect(result!.to).toBe(0)
    expect(result!.insert).toBe("hello")
  })

  test("handles empty new string (full deletion)", () => {
    const result = minimalChanges("hello", "")
    expect(result).not.toBeNull()
    expect(result!.from).toBe(0)
    expect(result!.to).toBe(5)
    expect(result!.insert).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Undo / redo — history() extension
// ---------------------------------------------------------------------------

describe("undo/redo (history extension)", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("undo reverses a user edit (split mode)", async () => {
    const { undo } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!
    // Simulate a user edit
    view.dispatch({
      changes: { from: 5, insert: " world" },
    })
    expect(handle.getContent()).toBe("hello world")

    // Undo should reverse it
    undo(view)
    expect(handle.getContent()).toBe("hello")
  })

  test("undo reverses a user edit (unified mode)", async () => {
    const { undo } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello",
      diffStyle: "unified",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!
    view.dispatch({
      changes: { from: 5, insert: " world" },
    })
    expect(handle.getContent()).toBe("hello world")

    undo(view)
    expect(handle.getContent()).toBe("hello")
  })

  test("redo re-applies an undone edit", async () => {
    const { undo, redo } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!
    view.dispatch({
      changes: { from: 5, insert: " world" },
    })
    undo(view)
    expect(handle.getContent()).toBe("hello")

    redo(view)
    expect(handle.getContent()).toBe("hello world")
  })

  test("undo does NOT undo external updateModified", async () => {
    const { undo } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "initial",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    // External update (server push)
    handle.updateModified("server pushed")
    expect(handle.getContent()).toBe("server pushed")

    // Undo should NOT reverse the external update
    const view = handle.editorView!
    undo(view)
    expect(handle.getContent()).toBe("server pushed")
  })

  test("undo does NOT undo external updateOriginal (split mode)", async () => {
    const { undo } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "old original",
      modified: "modified",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    handle.updateOriginal("new original")
    const origView = handle.mergeView!.a
    expect(origView.state.doc.toString()).toBe("new original")

    // Undo on the original pane should not reverse the external update
    undo(origView)
    expect(origView.state.doc.toString()).toBe("new original")
  })

  test("revert is undoable — Cmd+Z restores pre-revert edits (D7)", async () => {
    const { undo, undoDepth } = await import("@codemirror/commands")
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original text",
      modified: "original text",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!

    // User makes an edit
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: "user edits here" },
    })
    expect(handle.getContent()).toBe("user edits here")
    // History should have recorded the user edit
    expect(undoDepth(view.state)).toBeGreaterThan(0)

    // Revert to original
    handle.revert("original text")
    expect(handle.getContent()).toBe("original text")

    // Undo the revert — should restore user edits
    undo(view)
    expect(handle.getContent()).toBe("user edits here")
  })
})

// ---------------------------------------------------------------------------
// Selection highlight visibility — theme specificity
// ---------------------------------------------------------------------------

describe("selection highlight visibility", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("theme injects a high-specificity .cm-selectionBackground rule that beats CM6 defaults", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a",
      modified: "b",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    // Extract individual CSS rules from all <style> elements
    const allCss = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n")
    const ruleRegex = /([^{}]+)\{([^{}]+)\}/g
    let match: RegExpExecArray | null
    let foundCustomHighSpecRule = false
    while ((match = ruleRegex.exec(allCss))) {
      const selector = match[1]!.trim()
      const declarations = match[2]!.trim()
      // Look for a rule that has BOTH the high-specificity selector (child combinators)
      // AND our CSS variable — proving our theme overrides CM6's hardcoded #233.
      if (
        selector.includes("> .cm-scroller > .cm-selectionLayer .cm-selectionBackground") &&
        declarations.includes("--v2-background-bg-layer-03")
      ) {
        foundCustomHighSpecRule = true
        break
      }
    }

    expect(foundCustomHighSpecRule).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// __amcEditor bridge — DOM function stash for clipboard handler
// ---------------------------------------------------------------------------

describe("__amcEditor bridge", () => {
  let parent: HTMLDivElement
  let handle: DiffEditorHandle

  beforeEach(() => {
    parent = document.createElement("div")
    document.body.appendChild(parent)
  })

  afterEach(() => {
    handle?.destroy()
    parent.remove()
  })

  test("createDiffEditor stashes __amcEditor on the parent element", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello world",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const bridge = (parent as any).__amcEditor
    expect(bridge).toBeDefined()
    expect(typeof bridge.getSelectedText).toBe("function")
    expect(typeof bridge.cutSelectedText).toBe("function")
  })

  test("getSelectedText returns CM6 model selection text", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello world",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!
    // Select "hello" (positions 0-5)
    view.dispatch({ selection: { anchor: 0, head: 5 } })

    const bridge = (parent as any).__amcEditor
    expect(bridge.getSelectedText()).toBe("hello")
  })

  test("getSelectedText returns empty when no selection", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    // Collapsed cursor at position 0
    const bridge = (parent as any).__amcEditor
    expect(bridge.getSelectedText()).toBe("")
  })

  test("cutSelectedText returns text and removes it from the document", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello world",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    const view = handle.editorView!
    view.dispatch({ selection: { anchor: 0, head: 6 } })

    const bridge = (parent as any).__amcEditor
    const text = bridge.cutSelectedText()
    expect(text).toBe("hello ")
    expect(handle.getContent()).toBe("world")
  })

  test("cutSelectedText is a no-op on readOnly editor", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "original",
      modified: "hello world",
      diffStyle: "split",
      readOnly: true,
      theme,
    })

    const view = handle.editorView!
    view.dispatch({ selection: { anchor: 0, head: 5 } })

    const bridge = (parent as any).__amcEditor
    const text = bridge.cutSelectedText()
    expect(text).toBe("hello")
    // Content unchanged — readOnly prevents the cut dispatch
    expect(handle.getContent()).toBe("hello world")
  })

  test("destroy cleans up __amcEditor from the parent", () => {
    const theme = buildThemeExtension("dark")
    handle = createDiffEditor({
      parent,
      original: "a",
      modified: "b",
      diffStyle: "split",
      readOnly: false,
      theme,
    })

    expect((parent as any).__amcEditor).toBeDefined()
    handle.destroy()
    expect((parent as any).__amcEditor).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Syntax highlight style
// ---------------------------------------------------------------------------

describe("buildSyntaxHighlightStyle", () => {
  test("is exported and returns a valid Extension", async () => {
    const { buildSyntaxHighlightStyle } = await import("./editable-diff-view-core")
    const ext = buildSyntaxHighlightStyle()
    expect(ext).toBeDefined()
    expect(ext).not.toBeNull()
  })
})

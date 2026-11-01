import { describe, expect, test } from "bun:test"
import {
  loadLanguage,
  buildThemeExtension,
  buildSyntaxHighlightStyle,
  baseExtensions,
  editableExtensions,
  externalUpdate,
  detectMode,
  keymapBindings,
} from "./editor-core"
import { EditorView, runScopeHandlers } from "@codemirror/view"
import { EditorSelection, EditorState } from "@codemirror/state"
import { foldable, foldedRanges, syntaxTree } from "@codemirror/language"
import { gotoLine } from "@codemirror/search"
import { addCursorAbove, addCursorBelow, cursorCharRight, deleteCharBackward } from "@codemirror/commands"

/**
 * Tests for editor-core — the extracted general-purpose CM6 setup functions
 * (Slice 1 of #912). These verify that the extraction preserved all exports
 * and their behavioral contracts.
 */

// ---------------------------------------------------------------------------
// Verify all expected exports exist and have correct types
// ---------------------------------------------------------------------------

describe("editor-core exports", () => {
  test("exports loadLanguage as an async function", () => {
    expect(typeof loadLanguage).toBe("function")
  })

  test("exports buildThemeExtension as a function", () => {
    expect(typeof buildThemeExtension).toBe("function")
  })

  test("exports buildSyntaxHighlightStyle as a function", () => {
    expect(typeof buildSyntaxHighlightStyle).toBe("function")
  })

  test("exports baseExtensions as a function", () => {
    expect(typeof baseExtensions).toBe("function")
  })

  test("exports editableExtensions as a function", () => {
    expect(typeof editableExtensions).toBe("function")
  })

  test("exports externalUpdate annotation", () => {
    expect(externalUpdate).toBeDefined()
  })

  test("exports detectMode as a function", () => {
    expect(typeof detectMode).toBe("function")
  })
})

// ---------------------------------------------------------------------------
// loadLanguage — same behavioral contract as before extraction
// ---------------------------------------------------------------------------

describe("loadLanguage (via editor-core)", () => {
  test("resolves known extensions", async () => {
    expect(await loadLanguage("ts")).not.toBeNull()
    expect(await loadLanguage("md")).not.toBeNull()
    expect(await loadLanguage("json")).not.toBeNull()
  })

  test("resolves extensions via @codemirror/language-data fallback", async () => {
    // These are not in the manual EXTENSION_MAP but should be found
    // by @codemirror/language-data's auto-detection
    expect(await loadLanguage("rs")).not.toBeNull()    // Rust
    expect(await loadLanguage("go")).not.toBeNull()    // Go
    expect(await loadLanguage("yaml")).not.toBeNull()  // YAML
    expect(await loadLanguage("sql")).not.toBeNull()   // SQL
    expect(await loadLanguage("sh")).not.toBeNull()    // Shell
    expect(await loadLanguage("toml")).not.toBeNull()  // TOML
  })

  test("returns null for unknown extensions", async () => {
    expect(await loadLanguage("xyz-unknown")).toBeNull()
  })

  test("strips leading dot", async () => {
    expect(await loadLanguage(".ts")).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildThemeExtension — returns valid CM6 extensions
// ---------------------------------------------------------------------------

describe("buildThemeExtension (via editor-core)", () => {
  test("returns defined extensions for both modes", () => {
    expect(buildThemeExtension("dark")).toBeDefined()
    expect(buildThemeExtension("light")).toBeDefined()
  })

  test("dark and light produce distinct extensions", () => {
    expect(buildThemeExtension("dark")).not.toBe(buildThemeExtension("light"))
  })
})

// ---------------------------------------------------------------------------
// baseExtensions — structural extensions including lineWrapping
// ---------------------------------------------------------------------------

describe("baseExtensions (via editor-core)", () => {
  test("returns an array of extensions", () => {
    const theme = buildThemeExtension("dark")
    const exts = baseExtensions({ theme })
    expect(Array.isArray(exts)).toBe(true)
    expect(exts.length).toBeGreaterThan(0)
  })

  test("includes lineWrapping", () => {
    const theme = buildThemeExtension("dark")
    const exts = baseExtensions({ theme })
    expect(exts).toContain(EditorView.lineWrapping)
  })
})

// ---------------------------------------------------------------------------
// Code folding (#1517) — fold gutter, Mod-Shift-[ / Mod-Shift-] shortcuts
// ---------------------------------------------------------------------------

describe("baseExtensions code folding (#1517)", () => {
  const SRC = "function f() {\n  const a = 1\n  return a\n}\n"

  async function makeView(): Promise<EditorView> {
    const language = await loadLanguage("ts")
    expect(language).not.toBeNull()
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: SRC,
        selection: { anchor: 0 },
        extensions: baseExtensions({ theme: buildThemeExtension("dark"), language }),
      }),
    })
    // Make sure the lezer tree is fully parsed so fold ranges are available.
    syntaxTree(view.state)
    return view
  }

  function keyEvent(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  }

  test("renders a fold gutter next to the line numbers", async () => {
    const view = await makeView()
    expect(view.dom.querySelector(".cm-foldGutter")).not.toBeNull()
    expect(view.dom.querySelector(".cm-lineNumbers")).not.toBeNull()
    view.destroy()
  })

  test("the lezer grammar reports a foldable region on the function line", async () => {
    const view = await makeView()
    const line = view.state.doc.line(1)
    expect(foldable(view.state, line.from, line.to)).not.toBeNull()
    view.destroy()
  })

  test("Mod-Shift-[ folds the region at the cursor and Mod-Shift-] unfolds it", async () => {
    const view = await makeView()
    const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    const mod = isMac ? { metaKey: true } : { ctrlKey: true }
    const count = () => {
      let n = 0
      foldedRanges(view.state).between(0, view.state.doc.length, () => { n++ })
      return n
    }
    expect(count()).toBe(0)

    const fold = keyEvent({ key: "{", code: "BracketLeft", keyCode: 219, shiftKey: true, ...mod })
    expect(runScopeHandlers(view, fold, "editor")).toBe(true)
    expect(count()).toBe(1)

    const unfold = keyEvent({ key: "}", code: "BracketRight", keyCode: 221, shiftKey: true, ...mod })
    expect(runScopeHandlers(view, unfold, "editor")).toBe(true)
    expect(count()).toBe(0)
    view.destroy()
  })
})

// ---------------------------------------------------------------------------
// Cmd+L (Mod-l) → gotoLine keybinding (#1515)
// ---------------------------------------------------------------------------

describe("keymapBindings — Mod-l gotoLine (#1515)", () => {
  test("keymapBindings binds Mod-l to gotoLine", () => {
    const modLEntry = keymapBindings().find((b) => b.key === "Mod-l")
    expect(modLEntry?.run).toBe(gotoLine)
  })

  test("Mod-l is not bound by any other binding in the editor keymap", () => {
    const keys = keymapBindings().flatMap((b) => [b.key, b.mac, b.win, b.linux]).filter(Boolean)
    expect(keys.filter((k) => k === "Mod-l")).toHaveLength(1)
  })
})

describe("baseExtensions go-to-line shortcuts (#1515)", () => {
  const SRC = "line one\nline two\nline three\nline four\n"

  function makeView(): EditorView {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: SRC,
        selection: { anchor: 0 },
        extensions: baseExtensions({ theme: buildThemeExtension("dark") }),
      }),
    })
  }

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const mod = isMac ? { metaKey: true } : { ctrlKey: true }

  function keyEvent(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  }

  test("Mod-L opens the go-to-line panel", () => {
    const view = makeView()
    expect(view.dom.querySelector(".cm-goto-line")).toBeNull()
    const ev = keyEvent({ key: "l", code: "KeyL", keyCode: 76, ...mod })
    expect(runScopeHandlers(view, ev, "editor")).toBe(true)
    expect(view.dom.querySelector(".cm-goto-line")).not.toBeNull()
    view.destroy()
  })

  test("Mod-Alt-G still opens the go-to-line panel", () => {
    const view = makeView()
    expect(view.dom.querySelector(".cm-goto-line")).toBeNull()
    const ev = keyEvent({ key: "g", code: "KeyG", keyCode: 71, altKey: true, ...mod })
    expect(runScopeHandlers(view, ev, "editor")).toBe(true)
    expect(view.dom.querySelector(".cm-goto-line")).not.toBeNull()
    view.destroy()
  })
})

// ---------------------------------------------------------------------------
// Multiple cursors (#1516) — Mod-Alt-Up/Down, Mod-d, Escape, in-sync edits.
// CM6's defaultKeymap already binds Mod-Alt-ArrowUp/Down (addCursorAbove /
// addCursorBelow) and searchKeymap binds Mod-d (selectNextOccurrence). The
// facet below is what actually lets those commands keep extra ranges.
//
// Vertical cursor placement (Mod-Alt-Up/Down) reads real layout geometry, which
// happy-dom does not provide, so those cases assert the binding wiring here and
// are verified by hand in a live webview. Editing and movement across several
// cursors are exercised on explicitly built multi-range selections.
// ---------------------------------------------------------------------------

describe("multiple-cursor keybindings (#1516)", () => {
  const SRC = "alpha foo\nbeta foo\ngamma foo\n"

  function makeView(anchor: number, head?: number): EditorView {
    const parent = document.createElement("div")
    document.body.appendChild(parent)
    return new EditorView({
      parent,
      state: EditorState.create({
        doc: SRC,
        selection: { anchor, head },
        extensions: baseExtensions({ theme: buildThemeExtension("dark") }),
      }),
    })
  }

  function withCursors(view: EditorView, positions: number[]): void {
    view.dispatch({
      selection: EditorSelection.create(positions.map((p) => EditorSelection.cursor(p))),
    })
  }

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
  const mod = isMac ? { metaKey: true } : { ctrlKey: true }

  function keyEvent(init: KeyboardEventInit): KeyboardEvent {
    return new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init })
  }

  test("baseExtensions enables multiple selections (CM6 default is off)", () => {
    const view = makeView(0)
    expect(view.state.facet(EditorState.allowMultipleSelections)).toBe(true)
    view.destroy()
  })

  test("Mod-Alt-ArrowDown is wired to addCursorBelow and handled by the editor", () => {
    expect(keymapBindings().find((b) => b.key === "Mod-Alt-ArrowDown")?.run).toBe(addCursorBelow)
    const view = makeView(0)
    const ev = keyEvent({ key: "ArrowDown", code: "ArrowDown", keyCode: 40, altKey: true, ...mod })
    expect(runScopeHandlers(view, ev, "editor")).toBe(true)
    view.destroy()
  })

  test("Mod-Alt-ArrowUp is wired to addCursorAbove and handled by the editor", () => {
    expect(keymapBindings().find((b) => b.key === "Mod-Alt-ArrowUp")?.run).toBe(addCursorAbove)
    const view = makeView(SRC.indexOf("gamma"))
    const ev = keyEvent({ key: "ArrowUp", code: "ArrowUp", keyCode: 38, altKey: true, ...mod })
    expect(runScopeHandlers(view, ev, "editor")).toBe(true)
    view.destroy()
  })

  test("Mod-d selects the next occurrence and adds a cursor", () => {
    const view = makeView(6, 9) // "foo" on line 1
    const ev = keyEvent({ key: "d", code: "KeyD", keyCode: 68, ...mod })
    expect(runScopeHandlers(view, ev, "editor")).toBe(true)
    const texts = view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to))
    expect(texts).toEqual(["foo", "foo"])
    view.destroy()
  })

  test("Escape collapses multiple cursors to the primary cursor", () => {
    const view = makeView(0)
    withCursors(view, [0, SRC.indexOf("beta")])
    expect(view.state.selection.ranges).toHaveLength(2)
    const primaryHead = view.state.selection.main.head
    const esc = keyEvent({ key: "Escape", code: "Escape", keyCode: 27 })
    expect(runScopeHandlers(view, esc, "editor")).toBe(true)
    expect(view.state.selection.ranges).toHaveLength(1)
    expect(view.state.selection.main.head).toBe(primaryHead)
    view.destroy()
  })

  test("cursor movement applies to every cursor", () => {
    const view = makeView(0)
    withCursors(view, [0, SRC.indexOf("beta")])
    expect(cursorCharRight(view)).toBe(true)
    const columns = view.state.selection.ranges.map((r) => r.head - view.state.doc.lineAt(r.head).from)
    expect(columns).toEqual([1, 1])
    view.destroy()
  })

  test("deletion applies to every cursor", () => {
    // Cursors after "alpha" and after "beta " (column 5 on lines 1 and 2).
    const view = makeView(5)
    withCursors(view, [5, SRC.indexOf("beta") + 5])
    expect(deleteCharBackward(view)).toBe(true)
    expect(view.state.doc.toString()).toBe("alph foo\nbetafoo\ngamma foo\n")
    view.destroy()
  })

  test("typing inserts text at every cursor", () => {
    const view = makeView(0)
    withCursors(view, [0, SRC.indexOf("beta")])
    view.dispatch(view.state.replaceSelection("X"))
    expect(view.state.doc.toString()).toBe("Xalpha foo\nXbeta foo\ngamma foo\n")
    view.destroy()
  })
})

// ---------------------------------------------------------------------------
// editableExtensions — readOnly/onChange contract preserved
// ---------------------------------------------------------------------------

describe("editableExtensions (via editor-core)", () => {
  test("includes onChange listener when not readOnly and onChange provided", () => {
    const withCb = editableExtensions({ readOnly: false, onChange: () => {} })
    const withoutCb = editableExtensions({ readOnly: false })
    expect(withCb.length).toBe(withoutCb.length + 1)
  })

  test("omits onChange listener when readOnly", () => {
    const withCb = editableExtensions({ readOnly: true, onChange: () => {} })
    const withoutCb = editableExtensions({ readOnly: true })
    expect(withCb.length).toBe(withoutCb.length)
  })
})

// ---------------------------------------------------------------------------
// detectMode — returns light or dark
// ---------------------------------------------------------------------------

describe("detectMode (via editor-core)", () => {
  test("returns a valid mode string", () => {
    const mode = detectMode()
    expect(mode === "light" || mode === "dark").toBe(true)
  })
})

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
import { EditorState } from "@codemirror/state"
import { foldable, foldedRanges, syntaxTree } from "@codemirror/language"
import { gotoLine } from "@codemirror/search"

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
  test("exports keymapBindings as a function", () => {
    expect(typeof keymapBindings).toBe("function")
  })

  test("keymapBindings includes an entry with key 'Mod-l'", () => {
    const theme = buildThemeExtension("dark")
    const bindings = keymapBindings({ theme })
    const modLEntry = bindings.find((b) => b.key === "Mod-l")
    expect(modLEntry).toBeDefined()
  })

  test("Mod-l binding runs gotoLine", () => {
    const theme = buildThemeExtension("dark")
    const bindings = keymapBindings({ theme })
    const modLEntry = bindings.find((b) => b.key === "Mod-l")
    expect(modLEntry?.run).toBe(gotoLine)
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

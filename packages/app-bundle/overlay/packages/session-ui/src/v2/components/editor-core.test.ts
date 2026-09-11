import { describe, expect, test } from "bun:test"
import {
  loadLanguage,
  buildThemeExtension,
  buildSyntaxHighlightStyle,
  baseExtensions,
  editableExtensions,
  externalUpdate,
  detectMode,
} from "./editor-core"
import { EditorView } from "@codemirror/view"

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

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  COMPILE_DONE_FADE_MS,
  canStartCompile,
  compileRequestMessage,
  compileStatusFromMessage,
  isLatexFile,
} from "./preview-latex-compile"

// #1403: a visible Compile button for .tex/.ltx in the Preview's floating
// controls. It posts the SAME `run-latex` message Cmd+S uses and reflects the
// `run-latex-status` lifecycle: idle → compiling → done (fades) | error.

const self = "/w/proj/paper.tex"
const status = (extra: Record<string, unknown>) => ({ source: "amicode", kind: "run-latex-status", file: self, ...extra })

describe("isLatexFile", () => {
  test("only .tex / .ltx, case-insensitive", () => {
    for (const p of ["a.tex", "/w/x/B.TEX", "c.ltx", "d.Ltx"]) expect(isLatexFile(p)).toBe(true)
    for (const p of ["a.md", "a.pdf", "a.png", "a.txt", "a.tex.bak", "tex", "", "a.latex"]) expect(isLatexFile(p)).toBe(false)
  })
})

describe("compileRequestMessage", () => {
  test("is the existing run-latex message with the absolute path (even for an unmodified file)", () => {
    expect(compileRequestMessage(self)).toEqual({ source: "amicode", kind: "run-latex", file: self })
  })
})

describe("compileStatusFromMessage", () => {
  test("maps the host lifecycle to the button's states", () => {
    expect(compileStatusFromMessage(status({ state: "compiling" }), self)).toEqual({ state: "compiling" })
    expect(compileStatusFromMessage(status({ state: "done" }), self)).toEqual({ state: "done" })
    expect(compileStatusFromMessage(status({ state: "error", error: "! Undefined control sequence" }), self)).toEqual({
      state: "error",
      detail: "! Undefined control sequence",
    })
  })

  test("latexmk missing is an error indicator with a plain explanation", () => {
    const result = compileStatusFromMessage(status({ state: "unavailable" }), self)
    expect(result?.state).toBe("error")
    expect(result?.detail).toMatch(/latexmk/i)
  })

  test("matches by the file as REQUESTED too (the host resolves symlinks in `file`)", () => {
    const resolved = { ...status({ state: "done" }), file: "/private/w/proj/paper.tex", requested: self }
    expect(compileStatusFromMessage(resolved, self)).toEqual({ state: "done" })
  })

  test("ignores other files, other kinds, and malformed input", () => {
    expect(compileStatusFromMessage({ ...status({ state: "done" }), file: "/w/other.tex" }, self)).toBeUndefined()
    expect(compileStatusFromMessage({ source: "amicode", kind: "theme" }, self)).toBeUndefined()
    expect(compileStatusFromMessage({ ...status({ state: "done" }), source: "x" }, self)).toBeUndefined()
    expect(compileStatusFromMessage(status({ state: "bogus" }), self)).toBeUndefined()
    expect(compileStatusFromMessage(null, self)).toBeUndefined()
  })
})

describe("click idempotence", () => {
  test("a click while a compile is in flight does not start a second one", () => {
    expect(canStartCompile("idle")).toBe(true)
    expect(canStartCompile("done")).toBe(true)
    expect(canStartCompile("error")).toBe(true)
    expect(canStartCompile("compiling")).toBe(false)
  })

  test("the success check fades after 2.5 seconds", () => {
    expect(COMPILE_DONE_FADE_MS).toBe(2500)
  })
})

describe("Preview floating controls wiring", () => {
  const view = readFileSync(join(import.meta.dir, "preview-file-view.tsx"), "utf8")

  test("the compile button lives in the floating controls bar, gated on LaTeX files only", () => {
    const controls = view.slice(view.indexOf("data-preview-controls"), view.indexOf("{/* Zoom controls"))
    expect(controls).toContain("data-preview-compile")
    expect(controls).toMatch(/<Show when=\{isLatexFile\(props\.filePath\)\}>/)
    // …and is NOT hidden by edit mode (a .tex opens in the editor, where zoom is hidden)
    const compileAt = controls.indexOf("data-preview-compile")
    const editingGate = controls.indexOf("<Show when={!isEditing()}>")
    expect(editingGate === -1 || compileAt < editingGate).toBe(true)
  })

  test("it reuses the control-surface style and posts through the shared run-latex path", () => {
    expect(view).toContain("compileRequestMessage(")
    expect(view).toContain("canStartCompile(")
    expect(view).toContain("compileStatusFromMessage(")
    // the Cmd+S compile after save stays on the run-latex message
    expect(view).toMatch(/kind: "run-latex", file: toAbsolute\(filePath\)/)
  })

  test("the companion PDF still refreshes on compile success", () => {
    expect(view).toContain("d.state === \"done\"")
    expect(view).toContain("reloadBinary()")
  })
})

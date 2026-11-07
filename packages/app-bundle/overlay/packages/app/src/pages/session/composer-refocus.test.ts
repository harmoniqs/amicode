import { afterEach, describe, expect, test } from "bun:test"
import { composerCaretOffset, composerRefocusOffset, isTextEntry, type ComposerRefocusInput } from "./composer-refocus"

function composerEl() {
  const el = document.createElement("div")
  el.contentEditable = "true"
  document.body.appendChild(el)
  return el
}

function base(overrides: Partial<ComposerRefocusInput> = {}): ComposerRefocusInput {
  const composer = composerEl()
  const tab = document.createElement("button")
  document.body.appendChild(tab)
  return {
    key: "dir/ses_b",
    prevKey: "dir/ses_a",
    childSession: false,
    composerBlocked: false,
    dialogActive: false,
    active: tab,
    composer,
    saved: 3,
    length: 10,
    ...overrides,
  }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("composerCaretOffset (#1248)", () => {
  test("restores the saved per-session offset", () => {
    expect(composerCaretOffset(4, 10)).toBe(4)
    expect(composerCaretOffset(0, 10)).toBe(0)
  })

  test("falls back to the end of the prompt when nothing was saved", () => {
    expect(composerCaretOffset(undefined, 10)).toBe(10)
    expect(composerCaretOffset(Number.NaN, 7)).toBe(7)
  })

  test("clamps a stale saved offset into the prompt", () => {
    expect(composerCaretOffset(42, 10)).toBe(10)
    expect(composerCaretOffset(-1, 10)).toBe(0)
  })
})

describe("composerRefocusOffset (#1248)", () => {
  test("refocuses on a tab switch with the saved offset when focus sits on the tab button", () => {
    expect(composerRefocusOffset(base())).toBe(3)
  })

  test("refocuses at the end when the session has no saved offset", () => {
    expect(composerRefocusOffset(base({ saved: undefined }))).toBe(10)
  })

  test("refocuses when nothing is focused", () => {
    expect(composerRefocusOffset(base({ active: document.body }))).toBe(3)
    expect(composerRefocusOffset(base({ active: null }))).toBe(3)
  })

  test("skips when the key did not change, or on the first key", () => {
    expect(composerRefocusOffset(base({ prevKey: "dir/ses_b" }))).toBeUndefined()
    expect(composerRefocusOffset(base({ prevKey: undefined }))).toBeUndefined()
    expect(composerRefocusOffset(base({ key: undefined }))).toBeUndefined()
  })

  test("skips without a composer element", () => {
    expect(composerRefocusOffset(base({ composer: undefined }))).toBeUndefined()
  })

  test("skips child sessions", () => {
    expect(composerRefocusOffset(base({ childSession: true }))).toBeUndefined()
  })

  test("skips a blocked composer", () => {
    expect(composerRefocusOffset(base({ composerBlocked: true }))).toBeUndefined()
  })

  test("skips while a dialog is open", () => {
    expect(composerRefocusOffset(base({ dialogActive: true }))).toBeUndefined()
  })

  test("skips while focus is inside [data-prevent-autofocus]", () => {
    const wrap = document.createElement("div")
    wrap.setAttribute("data-prevent-autofocus", "")
    const btn = document.createElement("button")
    wrap.appendChild(btn)
    document.body.appendChild(wrap)
    expect(composerRefocusOffset(base({ active: btn }))).toBeUndefined()
  })

  test("does not steal focus from the terminal (xterm textarea)", () => {
    const textarea = document.createElement("textarea")
    textarea.className = "xterm-helper-textarea"
    document.body.appendChild(textarea)
    expect(composerRefocusOffset(base({ active: textarea }))).toBeUndefined()
  })

  test("does not steal focus from a code editor (contenteditable)", () => {
    const editor = document.createElement("div")
    editor.className = "cm-content"
    editor.contentEditable = "true"
    document.body.appendChild(editor)
    expect(composerRefocusOffset(base({ active: editor }))).toBeUndefined()
  })

  test("does not steal focus from an input", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    expect(composerRefocusOffset(base({ active: input }))).toBeUndefined()
  })

  test("refocusing is allowed when the composer itself already has focus", () => {
    const input = base()
    expect(composerRefocusOffset({ ...input, active: input.composer })).toBe(3)
  })
})

describe("isTextEntry", () => {
  test("buttons are not text entry; inputs, textareas and contenteditable are", () => {
    expect(isTextEntry(document.createElement("button"))).toBe(false)
    expect(isTextEntry(document.createElement("input"))).toBe(true)
    expect(isTextEntry(document.createElement("textarea"))).toBe(true)
    const ce = document.createElement("div")
    ce.contentEditable = "true"
    document.body.appendChild(ce)
    expect(isTextEntry(ce)).toBe(true)
  })
})

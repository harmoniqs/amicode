import { afterEach, describe, expect, test } from "bun:test"
import {
  extractSelection,
  insertTextAtSelection,
  installGlobalClipboardFallback,
  isEditableTarget,
  setSessionCopyProvider,
} from "./global-clipboard"

// Every install/listener attaches to the real happy-dom window or document, so
// each test registers its teardown here to keep the suite order-independent.
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  document.body.innerHTML = ""
  window.getSelection()?.removeAllRanges()
})

// A framed window: the real happy-dom window's event plumbing (so DOM events
// dispatched on elements reach capture-phase listeners) with a foreign parent
// that records what the app posts — mirroring clipboard-bridge.test.ts.
function framedWindow() {
  const posted: Array<Record<string, unknown>> = []
  const parent = { postMessage: (message: Record<string, unknown>) => posted.push(message) }
  const win = new Proxy(window, {
    get(target, prop) {
      if (prop === "parent") return parent
      const value = Reflect.get(target, prop)
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  }) as unknown as Window
  return {
    win,
    posted,
    reply: (message: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { data: message })),
  }
}

function install(win: Window) {
  const uninstall = installGlobalClipboardFallback(win)
  cleanups.push(uninstall)
  return uninstall
}

function field(type: string, value = "", start?: number, end?: number) {
  const el = document.createElement("input")
  el.type = type
  el.value = value
  document.body.appendChild(el)
  if (start !== undefined) el.setSelectionRange(start, end ?? start)
  return el
}

function editableDiv(text: string) {
  const el = document.createElement("div")
  el.setAttribute("contenteditable", "true")
  el.textContent = text
  document.body.appendChild(el)
  return el
}

function selectWithin(el: HTMLElement, start: number, end: number) {
  const range = document.createRange()
  range.setStart(el.firstChild!, start)
  range.setEnd(el.firstChild!, end)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

// A stand-in for a framework-controlled input: records what a bubbling
// document-level "input" listener observes — the element's value must already
// hold the new text by the time the listener runs (how Solid syncs state).
function observeInput() {
  const events: Array<{ value: string; inputType: string }> = []
  const onInput = (event: Event) => {
    const target = event.target as HTMLElement
    events.push({
      value: "value" in target ? (target as HTMLInputElement).value : (target.textContent ?? ""),
      inputType: (event as InputEvent).inputType,
    })
  }
  document.addEventListener("input", onInput)
  cleanups.push(() => document.removeEventListener("input", onInput))
  return events
}

function keydown(el: Element, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("isEditableTarget", () => {
  test("accepts text-like inputs (incl. password), textareas, and contenteditables", () => {
    expect(isEditableTarget(field("text"))).toBe(true)
    expect(isEditableTarget(field("password"))).toBe(true)
    expect(isEditableTarget(field("search"))).toBe(true)
    expect(isEditableTarget(field("email"))).toBe(true)
    const textarea = document.createElement("textarea")
    document.body.appendChild(textarea)
    expect(isEditableTarget(textarea)).toBe(true)
    expect(isEditableTarget(editableDiv("x"))).toBe(true)
  })

  test("rejects non-text controls, non-editables, and locked fields", () => {
    expect(isEditableTarget(field("checkbox"))).toBe(false)
    expect(isEditableTarget(field("file"))).toBe(false)
    expect(isEditableTarget(document.createElement("button"))).toBe(false)
    expect(isEditableTarget(document.createElement("div"))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
    const disabled = field("text")
    disabled.disabled = true
    expect(isEditableTarget(disabled)).toBe(false)
    const readonly = field("password")
    readonly.readOnly = true
    expect(isEditableTarget(readonly)).toBe(false)
  })
})

describe("insertTextAtSelection", () => {
  test("replaces a form field's selection and lands the caret after the insertion", () => {
    const el = field("text", "abcdef", 2, 4)
    const seen = observeInput()

    insertTextAtSelection(el, "XY")

    expect(el.value).toBe("abXYef")
    expect(el.selectionStart).toBe(4)
    expect(el.selectionEnd).toBe(4)
    // The controlled-input contract: by the time the bubbling event arrives,
    // reading target.value yields the new text.
    expect(seen).toEqual([{ value: "abXYef", inputType: "insertFromPaste" }])
  })

  test("inserts at a collapsed caret in a textarea", () => {
    const el = document.createElement("textarea")
    el.value = "solve a  gate"
    document.body.appendChild(el)
    el.setSelectionRange(8, 8)
    const seen = observeInput()

    insertTextAtSelection(el, "CZ")

    expect(el.value).toBe("solve a CZ gate")
    expect(el.selectionStart).toBe(10)
    expect(seen).toEqual([{ value: "solve a CZ gate", inputType: "insertFromPaste" }])
  })

  test("contenteditable: replaces the DOM selection and dispatches insertFromPaste", () => {
    const el = editableDiv("hello world")
    selectWithin(el, 0, 5)
    const seen = observeInput()

    insertTextAtSelection(el, "goodbye")

    expect(el.textContent).toBe("goodbye world")
    expect(window.getSelection()?.toString()).toBe("") // collapsed after insert
    expect(seen).toEqual([{ value: "goodbye world", inputType: "insertFromPaste" }])
  })

  test("contenteditable: appends at the end when the selection lives elsewhere", () => {
    const el = editableDiv("hqs-")
    window.getSelection()?.removeAllRanges()
    const seen = observeInput()

    insertTextAtSelection(el, "token")

    expect(el.textContent).toBe("hqs-token")
    expect(seen).toEqual([{ value: "hqs-token", inputType: "insertFromPaste" }])
  })
})

describe("extractSelection", () => {
  test("returns a form field's selected slice without mutating it", () => {
    const el = field("text", "solve a CZ gate", 0, 5)
    const seen = observeInput()

    expect(extractSelection(el)).toBe("solve")
    expect(el.value).toBe("solve a CZ gate")
    expect(seen).toEqual([]) // copy is read-only: no input event
  })

  test("returns empty for a collapsed selection", () => {
    expect(extractSelection(field("text", "abc", 1, 1))).toBe("")
  })

  test("cut removes the selection, collapses the caret, and dispatches deleteByCut", () => {
    const el = field("password", "abcdef", 2, 4)
    const seen = observeInput()

    expect(extractSelection(el, { cut: true })).toBe("cd")
    expect(el.value).toBe("abef")
    expect(el.selectionStart).toBe(2)
    expect(el.selectionEnd).toBe(2)
    expect(seen).toEqual([{ value: "abef", inputType: "deleteByCut" }])
  })

  test("contenteditable: returns the selected text; cut removes it", () => {
    const el = editableDiv("hello world")
    selectWithin(el, 0, 6)
    expect(extractSelection(el)).toBe("hello ")
    expect(el.textContent).toBe("hello world")

    selectWithin(el, 0, 6)
    const seen = observeInput()
    expect(extractSelection(el, { cut: true })).toBe("hello ")
    expect(el.textContent).toBe("world")
    expect(seen).toEqual([{ value: "world", inputType: "deleteByCut" }])
  })
})

describe("installGlobalClipboardFallback", () => {
  test("mod+V in a framed credential field requests the OS clipboard and inserts the reply", async () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("password", "hqs-", 4, 4)
    const seen = observeInput()

    const event = keydown(el, "v")

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toHaveLength(1)
    expect(bridge.posted[0]!.kind).toBe("clipboard-request")

    bridge.reply({ source: "amicode", kind: "clipboard", nonce: bridge.posted[0]!.nonce, text: "api-key-123" })
    await tick()

    expect(el.value).toBe("hqs-api-key-123")
    expect(seen).toEqual([{ value: "hqs-api-key-123", inputType: "insertFromPaste" }])
  })

  test("mod+V replaces the field's selection with the pasted text", async () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "wrong-token", 0, 11)

    keydown(el, "v")
    bridge.reply({ source: "amicode", kind: "clipboard", nonce: bridge.posted[0]!.nonce, text: "right-token" })
    await tick()

    expect(el.value).toBe("right-token")
  })

  test("an empty bridge reply degrades to a no-op", async () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "untouched", 0, 0)
    const seen = observeInput()

    keydown(el, "v")
    bridge.reply({ source: "amicode", kind: "clipboard", nonce: bridge.posted[0]!.nonce, text: "" })
    await tick()

    expect(el.value).toBe("untouched")
    expect(seen).toEqual([])
  })

  test('targets inside [data-amc-clipboard="self"] keep their own paste handling', () => {
    const bridge = framedWindow()
    install(bridge.win)
    const owner = document.createElement("div")
    owner.setAttribute("data-amc-clipboard", "self")
    document.body.appendChild(owner)
    const el = document.createElement("input")
    el.type = "text"
    owner.appendChild(el)

    const event = keydown(el, "v")

    // The prompt input's own ⌘V handler runs instead — no double insertion.
    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("mod+C pushes the field's selection to the OS clipboard via the bridge", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "solve a CZ gate", 0, 5)

    const event = keydown(el, "c")

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toEqual([{ source: "amicode", kind: "clipboard-write", text: "solve" }])
    expect(el.value).toBe("solve a CZ gate") // copy never mutates
  })

  test("copy still mirrors inside self-marked subtrees — the marker only owns paste", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "draft prompt", 0, 5)
    el.setAttribute("data-amc-clipboard", "self")

    keydown(el, "c")

    expect(bridge.posted).toEqual([{ source: "amicode", kind: "clipboard-write", text: "draft" }])
  })

  test("mod+X (ctrl too) pushes the selection and removes it", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "abcdef", 2, 4)
    const seen = observeInput()

    const event = keydown(el, "x", { metaKey: false, ctrlKey: true })

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toEqual([{ source: "amicode", kind: "clipboard-write", text: "cd" }])
    expect(el.value).toBe("abef")
    expect(seen).toEqual([{ value: "abef", inputType: "deleteByCut" }])
  })

  test("mod+C with nothing selected posts nothing and leaves the event alone", () => {
    const bridge = framedWindow()
    install(bridge.win)
    // Clear any lingering document selection from prior tests
    window.getSelection()?.removeAllRanges()
    const el = field("text", "abc", 1, 1)

    const event = keydown(el, "c")

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("non-editable targets: mod+C/X with a selection bridges the text to clipboard", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const div = document.createElement("div")
    div.textContent = "chat message"
    document.body.appendChild(div)
    // Place a document selection on the div's text
    const range = document.createRange()
    range.selectNodeContents(div)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    const event = keydown(div, "c")

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toEqual([{ source: "amicode", kind: "clipboard-write", text: "chat message" }])
  })

  test("non-editable targets: mod+C with no selection is a no-op", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const button = document.createElement("button")
    document.body.appendChild(button)
    // Explicitly clear any lingering selection
    window.getSelection()?.removeAllRanges()

    const event = keydown(button, "c")

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("non-editable targets: mod+V is a no-op (nothing to paste into)", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const button = document.createElement("button")
    document.body.appendChild(button)

    const event = keydown(button, "v")

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("unframed windows are left entirely to native clipboard handling", async () => {
    install(window) // happy-dom's top-level window: parent === self
    const el = field("text", "native", 0, 6)
    const seen = observeInput()

    const event = keydown(el, "v")
    await tick()

    expect(event.defaultPrevented).toBe(false)
    expect(el.value).toBe("native")
    expect(seen).toEqual([])
  })

  test("shift/alt chords and unmodified keys are ignored", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "abcdef", 0, 3)

    expect(keydown(el, "v", { shiftKey: true }).defaultPrevented).toBe(false)
    expect(keydown(el, "c", { altKey: true }).defaultPrevented).toBe(false)
    expect(keydown(el, "v", { metaKey: false }).defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("the returned uninstall detaches the handler", () => {
    const bridge = framedWindow()
    const uninstall = install(bridge.win)
    uninstall()
    const el = field("text", "abc", 0, 3)

    const event = keydown(el, "c")

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  // --- Select-all (Cmd+A) ---

  test("mod+A selects all text in a form field", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "hello world", 3, 3)

    const event = keydown(el, "a")

    expect(event.defaultPrevented).toBe(true)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(11)
  })

  test("mod+A selects all content in a contenteditable", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = editableDiv("hello world")

    const event = keydown(el, "a")

    expect(event.defaultPrevented).toBe(true)
    const selection = window.getSelection()!
    expect(selection.toString()).toBe("hello world")
  })

  test("mod+A in a textarea selects all its text", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = document.createElement("textarea")
    el.value = "line1\nline2"
    document.body.appendChild(el)
    el.setSelectionRange(2, 2)

    const event = keydown(el, "a")

    expect(event.defaultPrevented).toBe(true)
    expect(el.selectionStart).toBe(0)
    expect(el.selectionEnd).toBe(11)
  })

  test("mod+A on an EMPTY prompt-input selects the timeline (full session intent)", () => {
    const bridge = framedWindow()
    install(bridge.win)
    // Simulate the DOM structure: a timeline container + a prompt input
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "Assistant: Here is the answer."
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    const event = keydown(prompt, "a")

    expect(event.defaultPrevented).toBe(true)
    const selection = window.getSelection()!
    expect(selection.toString()).toBe("Assistant: Here is the answer.")
  })

  test("mod+A on a NON-EMPTY prompt-input selects the prompt text (standard behavior)", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "chat messages"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = "my draft message"
    document.body.appendChild(prompt)

    const event = keydown(prompt, "a")

    expect(event.defaultPrevented).toBe(true)
    const selection = window.getSelection()!
    // Selects the prompt text, not the timeline
    expect(selection.toString()).toBe("my draft message")
  })

  test("mod+A then mod+C on an EMPTY prompt-input bridges the timeline content to clipboard", () => {
    const bridge = framedWindow()
    install(bridge.win)
    // Simulate the DOM structure: a timeline container + a prompt input
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "User: hello\nAssistant: world"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    // Cmd+A selects the timeline (prompt is empty)
    keydown(prompt, "a")
    // Cmd+C copies it via bridge
    const event = keydown(prompt, "c")

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toEqual([
      { source: "amicode", kind: "clipboard-write", text: "User: hello\nAssistant: world" },
    ])
  })

  // --- Session copy provider (data-model full copy) ---

  test("mod+A then mod+C with a session copy provider uses the provider text", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "visible portion only"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    // Register a provider that returns the FULL session (as if from the store)
    setSessionCopyProvider(() => "User:\nWhat is 2+2?\n\nAssistant:\n4")
    cleanups.push(() => setSessionCopyProvider(undefined))

    // Cmd+A arms the flag, Cmd+C reads from the provider
    keydown(prompt, "a")
    const event = keydown(prompt, "c")

    expect(event.defaultPrevented).toBe(true)
    expect(bridge.posted).toEqual([
      { source: "amicode", kind: "clipboard-write", text: "User:\nWhat is 2+2?\n\nAssistant:\n4" },
    ])
  })

  test("provider text is preferred over DOM selection (virtualised content)", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "only visible rows"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    setSessionCopyProvider(() => "FULL SESSION with 100 messages")
    cleanups.push(() => setSessionCopyProvider(undefined))

    keydown(prompt, "a")
    const event = keydown(prompt, "c")

    expect(event.defaultPrevented).toBe(true)
    // Provider text wins over the DOM "only visible rows"
    expect(bridge.posted[0]!.text).toBe("FULL SESSION with 100 messages")
  })

  test("fullSessionCopyPending flag is cleared by intervening keystrokes", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "chat"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    setSessionCopyProvider(() => "full session")
    cleanups.push(() => setSessionCopyProvider(undefined))

    // Cmd+A arms the flag
    keydown(prompt, "a")
    // An intervening Cmd+Z clears the flag (it's not C/X)
    keydown(prompt, "z")
    // Now Cmd+C should NOT use the provider (flag was cleared)
    window.getSelection()?.removeAllRanges()
    const event = keydown(prompt, "c")

    expect(event.defaultPrevented).toBe(false)
    expect(bridge.posted).toHaveLength(0)
  })

  test("without a provider, mod+A then mod+C falls back to DOM selection", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const timeline = document.createElement("div")
    timeline.setAttribute("data-timeline-virtual-content", "")
    timeline.textContent = "DOM fallback text"
    document.body.appendChild(timeline)
    const prompt = document.createElement("div")
    prompt.setAttribute("data-component", "prompt-input")
    prompt.setAttribute("contenteditable", "true")
    prompt.textContent = ""
    document.body.appendChild(prompt)

    // No provider registered
    setSessionCopyProvider(undefined)

    keydown(prompt, "a")
    const event = keydown(prompt, "c")

    expect(event.defaultPrevented).toBe(true)
    // Falls back to DOM selection text
    expect(bridge.posted).toEqual([
      { source: "amicode", kind: "clipboard-write", text: "DOM fallback text" },
    ])
  })

  // --- Undo (Cmd+Z) ---

  test("mod+Z calls execCommand undo on a contenteditable", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = editableDiv("hello")

    const event = keydown(el, "z")

    expect(event.defaultPrevented).toBe(true)
  })

  test("mod+Z calls execCommand undo on a form field", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "hello world", 5, 5)

    const event = keydown(el, "z")

    expect(event.defaultPrevented).toBe(true)
  })

  // --- Redo (Cmd+Shift+Z / Cmd+Y) ---

  test("mod+Shift+Z calls execCommand redo", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = editableDiv("hello")

    const event = keydown(el, "z", { shiftKey: true })

    expect(event.defaultPrevented).toBe(true)
  })

  test("mod+Y calls execCommand redo", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = editableDiv("hello")

    const event = keydown(el, "y")

    expect(event.defaultPrevented).toBe(true)
  })

  // --- Guard preservation ---

  test("mod+A in an unframed window is not intercepted", () => {
    install(window) // unframed: parent === self
    const el = field("text", "hello", 2, 2)

    const event = keydown(el, "a")

    expect(event.defaultPrevented).toBe(false)
  })

  test("mod+Z on a non-editable target is not intercepted", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const button = document.createElement("button")
    document.body.appendChild(button)

    const event = keydown(button, "z")

    expect(event.defaultPrevented).toBe(false)
  })

  test("shift+alt chords with editing keys are still ignored", () => {
    const bridge = framedWindow()
    install(bridge.win)
    const el = field("text", "abc", 0, 3)

    expect(keydown(el, "a", { altKey: true }).defaultPrevented).toBe(false)
  })
})

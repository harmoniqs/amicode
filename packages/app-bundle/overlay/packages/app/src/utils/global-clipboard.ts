// Framed-app clipboard fallback, generalized from the prompt input's bridge.
// Inside the VS Code webview iframe, native paste never fires and native
// copy never reaches the OS clipboard (see prompt-input/clipboard-bridge.ts
// for the full why) — so every editable silently ignores ⌘V and poisons the
// next paste on ⌘C. This module intercepts mod+V/C/X at the window's capture
// phase and routes them over the existing extension-host bridge. It is the
// SOLE ⌘V path in the webview: the prompt composers (v1 and v2) no longer
// intercept the keystroke themselves, so the text lands exactly once.
// Unframed (plain web/desktop), it does nothing — native clipboard behavior
// stands.

import {
  readClipboardImageViaBridge,
  readClipboardViaBridge,
  writeClipboardViaBridge,
} from "@/components/prompt-input/clipboard-bridge"

// Single-slot media hook: a paste that carries no text is offered to the
// registered consumer (the v2 composer's attachment pipeline) as an image.
// Deliberately one slot — a list would invite two owners of one gesture.
let clipboardImageHandler: ((file: File) => void) | undefined

export function setClipboardImageHandler(handler?: (file: File) => void): void {
  clipboardImageHandler = handler
}

/** Clear the handler only if it's still the given reference — prevents a
 *  disposing component from wiping a newer component's handler. */
export function clearClipboardImageHandler(handler: (file: File) => void): void {
  if (clipboardImageHandler === handler) clipboardImageHandler = undefined
}

// Session copy provider: registered by the session page to serialize the full
// session from the data model (messages + parts → text). The clipboard handler
// calls this on Cmd+C after a "select all" instead of reading from the DOM
// (which is incomplete due to virtualization).
let sessionCopyProvider: (() => string) | undefined

export function setSessionCopyProvider(provider?: () => string): void {
  sessionCopyProvider = provider
}

// Flag: set by Cmd+A when targeting the prompt (signals "user wants the full
// session"), consumed by the next Cmd+C, cleared on any other keystroke.
let fullSessionCopyPending = false

// Elements that carry their own bridged paste (the profile fields'
// pasteFallback) mark themselves so the fallback doesn't double-insert. The
// marker owns PASTE only: nothing element-local handles copy/cut, so ⌘C/⌘X
// still mirror to the OS clipboard even inside marked subtrees — otherwise
// copying from the prompt would paste stale content.
export const CLIPBOARD_SELF_SELECTOR = '[data-amc-clipboard="self"]'

// When a file is copied in Finder, the clipboard carries both the image data
// AND the filename as plain text. Detect this so we prefer the image.
const IMAGE_FILENAME_RE = /^[^\n]{1,255}\.(png|jpe?g|gif|webp|avif|tiff?|bmp|svg|ico|heic)$/i
function looksLikeImageFilename(text: string): boolean {
  return IMAGE_FILENAME_RE.test(text.trim())
}

type FormField = HTMLInputElement | HTMLTextAreaElement

// Input types that hold free text and support the selection API. Everything
// else (checkbox, file, range, date, …) has no text caret to paste at.
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "password", "email"])

const isFormField = (el: unknown): el is FormField =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement

export function isEditableTarget(el: EventTarget | null): el is HTMLElement {
  if (el instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(el.type) && !el.disabled && !el.readOnly
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  return el instanceof HTMLElement && el.isContentEditable
}

// email (and, in some browsers, other text-like types) throws on selection
// access — degrade to append-at-end rather than losing the paste entirely.
function fieldSelection(el: FormField): { start: number; end: number } {
  try {
    const start = el.selectionStart
    const end = el.selectionEnd
    if (start !== null && end !== null) return { start, end }
  } catch {
    // no selection API for this input type
  }
  return { start: el.value.length, end: el.value.length }
}

function setCaret(el: FormField, at: number) {
  try {
    el.setSelectionRange(at, at)
  } catch {
    // no selection API — the value update above still landed
  }
}

// Manual dispatch discipline: setRangeText and Range edits fire no events, but
// Solid-controlled inputs only sync state from a bubbling "input" event.
function dispatchInput(el: HTMLElement, inputType: string, data?: string) {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }))
}

export function insertTextAtSelection(el: HTMLElement, text: string): void {
  if (isFormField(el)) {
    const { start, end } = fieldSelection(el)
    if (typeof el.setRangeText === "function") {
      el.setRangeText(text, start, end)
    } else {
      el.value = el.value.slice(0, start) + text + el.value.slice(end)
    }
    // Place the caret ourselves: setRangeText's "end" selection mode is not
    // reliable across DOM implementations (happy-dom lands it off-spec).
    setCaret(el, start + text.length)
    dispatchInput(el, "insertFromPaste", text)
    return
  }

  // contenteditable: prefer execCommand — the browser splices the text at the
  // caret and fires the input event itself, exactly like a native paste.
  const doc = el.ownerDocument
  if (typeof doc.execCommand === "function") {
    el.focus()
    try {
      if (doc.execCommand("insertText", false, text)) return
    } catch {
      // fall through to the manual range splice
    }
  }
  const selection = doc.defaultView?.getSelection()
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const node = doc.createTextNode(text)
  if (selection && range && el.contains(range.commonAncestorContainer)) {
    range.deleteContents()
    range.insertNode(node)
    range.setStartAfter(node)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  } else {
    // No usable selection inside the element — append rather than drop the paste.
    el.appendChild(node)
  }
  dispatchInput(el, "insertFromPaste", text)
}

export function extractSelection(el: HTMLElement, opts: { cut?: boolean } = {}): string {
  if (isFormField(el)) {
    const { start, end } = fieldSelection(el)
    const text = el.value.slice(start, end)
    if (!text) return ""
    if (opts.cut) {
      if (typeof el.setRangeText === "function") {
        el.setRangeText("", start, end)
      } else {
        el.value = el.value.slice(0, start) + el.value.slice(end)
      }
      setCaret(el, start)
      dispatchInput(el, "deleteByCut")
    }
    return text
  }

  const selection = el.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.rangeCount === 0) return ""
  const range = selection.getRangeAt(0)
  // Only speak for selections that actually live inside this editable —
  // cutting must never delete content the keystroke's target doesn't own.
  if (!el.contains(range.commonAncestorContainer)) return ""
  const text = selection.toString()
  if (!text) return ""
  if (opts.cut) {
    range.deleteContents() // leaves the selection collapsed at the cut point
    dispatchInput(el, "deleteByCut")
  }
  return text
}

// Select all content in an editable element — the JS equivalent of the native
// Cmd+A that the VS Code/Electron platform layer suppresses inside the iframe.
function selectAll(target: HTMLElement): void {
  if (isFormField(target)) {
    target.select()
    return
  }
  // contenteditable: select all children of the editable root
  const selection = target.ownerDocument.defaultView?.getSelection()
  if (selection) {
    selection.removeAllRanges()
    const range = target.ownerDocument.createRange()
    range.selectNodeContents(target)
    selection.addRange(range)
  }
}

// Capture-phase so it sees the keystroke before any component handler, and
// window-level so portaled UI (popovers, dialogs) is covered too. Returns an
// uninstall function; the handler re-checks framing per event, so installing
// unconditionally at startup is safe everywhere.
export function installGlobalClipboardFallback(win: Window = window): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (win.parent === win) return // unframed: native clipboard works — stay out
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return
    if (event.isComposing) return
    const key = event.key.toLowerCase()

    // Redo: Cmd+Shift+Z (shift allowed only for this chord)
    const isRedo = key === "z" && event.shiftKey
    // All other editing shortcuts require NO shift
    if (event.shiftKey && !isRedo) return

    if (key !== "v" && key !== "c" && key !== "x" && key !== "a" && key !== "z" && key !== "y") return
    const target = event.target

    // Clear the full-session flag on any keystroke that isn't the copy that
    // consumes it. Cmd+A sets it; only the immediately following Cmd+C uses it.
    if (!(key === "c" || key === "x")) {
      fullSessionCopyPending = false
    }

    // --- Non-editable targets (rendered messages, code blocks) ---
    // Inside the VS Code webview iframe, Electron intercepts Cmd+C at the host
    // level before a `copy` event fires in the iframe DOM. Route C/X/A through
    // the same bridge the context menu uses successfully.
    if (!isEditableTarget(target)) {
      if (key === "c" || key === "x") {
        // Cmd+X on non-editable = copy-only (cannot delete from rendered DOM)
        // If fullSessionCopyPending, prefer the provider (full data-model copy)
        if (fullSessionCopyPending && sessionCopyProvider) {
          const fullText = sessionCopyProvider()
          if (fullText) {
            event.preventDefault()
            writeClipboardViaBridge(fullText, win)
            fullSessionCopyPending = false
            return
          }
        }
        fullSessionCopyPending = false
        const selection = win.getSelection()
        const text = selection?.toString() ?? ""
        if (!text) return // no selection: no-op (clipboard unchanged)
        event.preventDefault()
        writeClipboardViaBridge(text, win)
        return
      }
      if (key === "a") {
        event.preventDefault()
        // Scope select-all to the preview panel if the target is inside one
        const panel = target instanceof Element && target.closest('#review-panel:not([aria-hidden="true"])')
        if (panel) {
          const content = panel.querySelector('[data-slot="session-review-v2-preview"]') ?? panel
          const selection = win.getSelection()
          if (selection) {
            selection.removeAllRanges()
            const range = win.document.createRange()
            range.selectNodeContents(content)
            selection.addRange(range)
          }
          return
        }
        // Otherwise select the full chat area + arm the session copy flag
        fullSessionCopyPending = !!sessionCopyProvider
        const selection = win.getSelection()
        if (selection) {
          selection.removeAllRanges()
          const range = win.document.createRange()
          const timeline = win.document.querySelector("[data-timeline-virtual-content]")
          range.selectNodeContents(timeline ?? win.document.body)
          selection.addRange(range)
        }
        return
      }
      // V/Z/Y on non-editables: paste still works for images (screenshots
      // pasted while reading chat), undo/redo are no-ops.
      if (key === "v") {
        event.preventDefault()
        void readClipboardViaBridge(win).then(async (text) => {
          if (text && !looksLikeImageFilename(text)) {
            // Text paste on non-editable: no-op (nowhere to insert)
            return
          }
          if (!clipboardImageHandler) return
          const file = await readClipboardImageViaBridge(win)
          if (file) clipboardImageHandler(file)
        })
      }
      return
    }

    // --- Select all ---
    if (key === "a") {
      event.preventDefault()
      // If the target is inside the review/file panel, select that panel's content
      const panel = target.closest('#review-panel:not([aria-hidden="true"])')
      if (panel) {
        const content = panel.querySelector('[data-slot="session-review-v2-preview"]') ?? panel
        const selection = win.getSelection()
        if (selection) {
          selection.removeAllRanges()
          const range = win.document.createRange()
          range.selectNodeContents(content)
          selection.addRange(range)
        }
        return
      }
      // If the prompt composer is EMPTY, "select all" means the full chat session.
      // If the prompt has content, standard select-all (select the draft text).
      const promptEl = target.closest('[data-component="prompt-input"]')
      if (promptEl) {
        const hasContent = (promptEl.textContent ?? "").trim().length > 0
        if (!hasContent) {
          fullSessionCopyPending = !!sessionCopyProvider
          // Visual feedback: select the timeline DOM (best-effort, may be partial
          // due to virtualization — the actual copy comes from the provider)
          const timeline = win.document.querySelector("[data-timeline-virtual-content]")
          const selection = win.getSelection()
          if (selection && timeline) {
            selection.removeAllRanges()
            const range = win.document.createRange()
            range.selectNodeContents(timeline)
            selection.addRange(range)
          }
          return
        }
      }
      selectAll(target)
      return
    }

    // --- Undo / Redo ---
    if (key === "z" || key === "y") {
      event.preventDefault()
      const doc = target.ownerDocument
      if (typeof doc.execCommand === "function") {
        doc.execCommand(isRedo || key === "y" ? "redo" : "undo")
      }
      return
    }

    // --- Clipboard: paste, copy, cut ---
    if (key === "v") {
      if (target.closest(CLIPBOARD_SELF_SELECTOR)) return // element owns its own paste
      // Native paste never fires in-frame, so preventDefault loses nothing;
      // an empty or dead bridge reply degrades to a no-op (see clipboard-bridge).
      event.preventDefault()
      void readClipboardViaBridge(win).then(async (text) => {
        if (text && !looksLikeImageFilename(text)) {
          insertTextAtSelection(target, text)
          return
        }
        // No text on the clipboard, OR the text is just an image filename
        // (Finder file copy puts the filename as text alongside the image data).
        // Try the image bridge — if it has an image, prefer that.
        if (!clipboardImageHandler) {
          // No image handler registered; insert text if we have any
          if (text) insertTextAtSelection(target, text)
          return
        }
        const file = await readClipboardImageViaBridge(win)
        if (file) {
          clipboardImageHandler(file)
        } else if (text) {
          // Image bridge returned nothing — fall back to the text
          insertTextAtSelection(target, text)
        }
      })
      return
    }

    const text = extractSelection(target, { cut: key === "x" })
    if (!text) {
      // Full-session copy: if Cmd+A armed the flag and a provider exists, use
      // the data model (complete, not limited by DOM virtualization).
      if (fullSessionCopyPending && sessionCopyProvider) {
        const fullText = sessionCopyProvider()
        if (fullText) {
          event.preventDefault()
          writeClipboardViaBridge(fullText, win)
        }
        fullSessionCopyPending = false
        return
      }
      fullSessionCopyPending = false
      // Fallback: a prior Cmd+A may have placed the selection on the chat session
      // content (outside this editable). Copy whatever is selected in the DOM.
      const selection = win.getSelection()
      if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
        const range = selection.getRangeAt(0)
        // Only bridge-copy when the selection lives OUTSIDE this editable — if it
        // were inside, extractSelection above would have found it already.
        if (!target.contains(range.commonAncestorContainer)) {
          const docText = selection.toString()
          if (docText) {
            event.preventDefault()
            writeClipboardViaBridge(docText, win)
          }
        }
      }
      return
    }
    fullSessionCopyPending = false
    event.preventDefault()
    writeClipboardViaBridge(text, win)
  }

  win.addEventListener("keydown", onKeyDown, true)
  return () => win.removeEventListener("keydown", onKeyDown, true)
}

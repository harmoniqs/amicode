// Amicode webview: the sandboxed chat iframe gets no native context menu —
// Electron webview guests render none, and the app only mounts ContextMenu on
// a few chrome surfaces — so right-click on message text, links, and inputs
// is dead. Install a document-level menu for framed contexts that mirrors the
// browser basics over the extension-host bridges: open/copy an external link,
// copy a selection, cut/copy/paste inside editables. Component-owned menus
// (Kobalte ContextMenu triggers preventDefault their contextmenu) are left
// alone via the defaultPrevented check. Unframed, the native menu stands.

import { readClipboardViaBridge, writeClipboardViaBridge } from "@/components/prompt-input/clipboard-bridge"
import { extractSelection, insertTextAtSelection, isEditableTarget } from "@/utils/global-clipboard"

type Item = { label: string; run: () => void }

const EXTERNAL_LINK = /^https?:\/\//i

// Read-only mirror of global-clipboard's fieldSelection, for menu-state
// probing — extractSelection would mutate on cut and can't speak for inputs
// whose types reject selection access.
function editableSelectionText(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      const start = el.selectionStart ?? el.value.length
      const end = el.selectionEnd ?? el.value.length
      return el.value.slice(start, end)
    } catch {
      return ""
    }
  }
  const selection = el.ownerDocument.defaultView?.getSelection()
  if (!selection || selection.rangeCount === 0) return ""
  const range = selection.getRangeAt(0)
  return el.contains(range.commonAncestorContainer) ? selection.toString() : ""
}

export function installWebviewContextMenu(win: Window = window): () => void {
  if (win.parent === win) return () => {}
  const doc = win.document
  let menu: HTMLElement | null = null

  const close = () => {
    menu?.remove()
    menu = null
  }

  const open = (x: number, y: number, items: Item[]) => {
    close()
    menu = doc.createElement("div")
    menu.setAttribute("data-component", "webview-context-menu")
    Object.assign(menu.style, {
      position: "fixed",
      zIndex: "9999",
      minWidth: "140px",
      padding: "4px",
      display: "flex",
      flexDirection: "column",
      gap: "1px",
      background: "var(--v2-background-bg-layer-01, var(--vscode-editor-background, #1e1e1e))",
      border: "1px solid var(--v2-border-border-base, #3c3c3c)",
      borderRadius: "8px",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
      color: "var(--v2-text-text-base, inherit)",
      font: "inherit",
    })
    for (const item of items) {
      const button = doc.createElement("button")
      button.type = "button"
      button.textContent = item.label
      Object.assign(button.style, {
        all: "unset",
        display: "block",
        padding: "5px 10px",
        borderRadius: "5px",
        fontSize: "12px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      })
      button.addEventListener(
        "mouseenter",
        () => (button.style.background = "var(--v2-background-bg-layer-02, rgba(127, 127, 127, 0.18))"),
      )
      button.addEventListener("mouseleave", () => (button.style.background = "transparent"))
      button.addEventListener("click", () => {
        close()
        item.run()
      })
      menu.appendChild(button)
    }
    doc.body.appendChild(menu)
    // Clamp into the viewport — fixed coordinates, so no scroll offset needed.
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(x, win.innerWidth - rect.width - 4))}px`
    menu.style.top = `${Math.max(4, Math.min(y, win.innerHeight - rect.height - 4))}px`
  }

  const onContextMenu = (event: MouseEvent) => {
    if (event.defaultPrevented) return // a component-owned menu speaks for this spot
    const target = event.target
    if (!(target instanceof Element)) return

    const items: Item[] = []

    const href = target.closest("a[href]")?.getAttribute("href")
    if (href && EXTERNAL_LINK.test(href)) {
      items.push(
        {
          label: "Open Link",
          run: () => win.parent.postMessage({ source: "amicode", kind: "open-external", url: href }, "*"),
        },
        { label: "Copy Link", run: () => void writeClipboardViaBridge(href, win) },
      )
    }

    if (isEditableTarget(target)) {
      if (editableSelectionText(target) !== "") {
        items.push(
          {
            label: "Cut",
            run: () => {
              const text = extractSelection(target, { cut: true })
              if (text) writeClipboardViaBridge(text, win)
            },
          },
          {
            label: "Copy",
            run: () => {
              const text = extractSelection(target)
              if (text) writeClipboardViaBridge(text, win)
            },
          },
        )
      }
      items.push({
        label: "Paste",
        run: () => void readClipboardViaBridge(win).then((text) => text && insertTextAtSelection(target, text)),
      })
    } else {
      const selection = doc.getSelection()?.toString() ?? ""
      if (selection) items.push({ label: "Copy", run: () => void writeClipboardViaBridge(selection, win) })
    }

    if (items.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    open(event.clientX, event.clientY, items)
  }

  const onDismiss = (event: Event) => {
    if (menu && !menu.contains(event.target as Node)) close()
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") close()
  }

  doc.addEventListener("contextmenu", onContextMenu)
  doc.addEventListener("mousedown", onDismiss, true)
  doc.addEventListener("keydown", onKey, true)
  doc.addEventListener("scroll", close, true)
  win.addEventListener("blur", close)
  win.addEventListener("resize", close)
  return () => {
    close()
    doc.removeEventListener("contextmenu", onContextMenu)
    doc.removeEventListener("mousedown", onDismiss, true)
    doc.removeEventListener("keydown", onKey, true)
    doc.removeEventListener("scroll", close, true)
    win.removeEventListener("blur", close)
    win.removeEventListener("resize", close)
  }
}

// amicode: in-app zoom for the WEB host (the plain browser at :3002 and the
// amicode VS Code webview). The desktop build zooms through Electron (menu
// roles); the web build had NO zoom at all — Cmd+=/-/0 fell through to the
// host, which zooms the whole editor window (or the browser tab), never the
// app. This module owns a CSS zoom on the document root, persisted
// per-window, and feeds the same platform.webviewZoom signal the titlebar
// and terminal already watch.
//
// One zoom owner (harmoniqs/amicode#266): the app document itself. The
// workbench can never see keydowns from inside the webview documents
// (cross-origin iframe; the host page's forwarding covers only the host
// page), so the extension cannot translate them into workbench zoom actions.
// Instead every app document — the main frame and each split pane — captures
// the zoom chords itself and applies its own CSS zoom: with the webview
// panel focused, the zoomed content is the webview; with an editor tab
// focused, the workbench's own native window zoom applies, unchanged.
import { createSignal } from "solid-js"
import { inAmicode, postAmicode } from "@/utils/amicode-bridge"

const KEY = "amicode-zoom"
const MIN = 0.5
const MAX = 3
const STEP = 0.1

const clamp = (value: number) => Math.min(Math.max(value, MIN), MAX)

function readSaved(): number {
  if (typeof localStorage === "undefined") return 1
  const parsed = Number.parseFloat(localStorage.getItem(KEY) ?? "1")
  return Number.isFinite(parsed) ? clamp(parsed) : 1
}

const [webZoom, setSignal] = createSignal(readSaved())

function apply(zoom: number) {
  if (typeof document === "undefined") return
  const html = document.documentElement
  if (zoom === 1) {
    html.style.removeProperty("zoom")
    html.style.removeProperty("transform")
    html.style.removeProperty("transform-origin")
  } else {
    // Try CSS zoom first (better text rendering), fallback to transform
    html.style.setProperty("zoom", String(zoom))
    // Also set transform as backup for browsers that don't support zoom
    html.style.setProperty("transform", `scale(${zoom})`)
    html.style.setProperty("transform-origin", "top left")
  }
}

// Apply zoom immediately and also after a small delay to ensure DOM is ready.
// In amicode context, the workbench owns zoom — never apply CSS zoom.
if (!inAmicode()) {
  apply(webZoom())
  if (typeof document !== "undefined") {
    document.addEventListener("DOMContentLoaded", () => apply(webZoom()), { once: true })
    // Fallback: also try after a short timeout in case DOMContentLoaded already fired
    setTimeout(() => apply(webZoom()), 0)
  }
}

export function setWebZoom(next: number) {
  const zoom = Math.round(clamp(next) * 100) / 100
  apply(zoom)
  setSignal(zoom)
  try {
    localStorage.setItem(KEY, String(zoom))
  } catch {
    // storage may be unavailable in a sandboxed webview — zoom still applies
  }
}

export const webZoomIn = () => setWebZoom(webZoom() + STEP)
export const webZoomOut = () => setWebZoom(webZoom() - STEP)
export const webZoomReset = () => setWebZoom(1)
export { webZoom }

// Raw chord capture (harmoniqs/amicode#266). The command registry's exact
// (normalized-key, modifier-mask) lookup cannot express "the key that means
// +" across layouts: Ctrl+Plus on US IS Ctrl+Shift+"=", arriving as key "+"
// with the shift bit — wrong key AND wrong mask — while the numpad "+"
// arrives unshifted and on DE/FR/Nordic layouts even the canonical "="
// carries shift. Rather than widen the registry's chords (and its tooltips,
// palette, and collision surface), the zoom chords are captured directly by
// each app document, matching the key the layout PRODUCES — the same
// physical key yields one of "="/"+"/"-"/"_" on every layout, with the shift
// bit deliberately ignored. "0" is unshifted on every layout we ship to and
// stays unambiguous.
const ZOOM_IN_KEYS = new Set(["=", "+"])
const ZOOM_OUT_KEYS = new Set(["-", "_"])
const ZOOM_RESET_KEYS = new Set(["0"])

if (typeof document !== "undefined") {
  document.addEventListener(
    "keydown",
    (event) => {
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key
      let action: string | undefined
      if (ZOOM_IN_KEYS.has(key)) action = "workbench.action.zoomIn"
      else if (ZOOM_OUT_KEYS.has(key)) action = "workbench.action.zoomOut"
      else if (ZOOM_RESET_KEYS.has(key)) action = "workbench.action.zoomReset"
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      if (inAmicode()) {
        postAmicode(action)
      } else {
        if (action === "workbench.action.zoomIn") setWebZoom(webZoom() + STEP)
        else if (action === "workbench.action.zoomOut") setWebZoom(webZoom() - STEP)
        else setWebZoom(1)
      }
    },
    { capture: true },
  )
}

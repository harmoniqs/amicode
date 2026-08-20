// AMICODE (widget kernel): the widget frame as a SERVER-SERVED document —
// GET /amicode/widget-frame?id=. Why not srcdoc: srcdoc/blob documents
// INHERIT the embedding page's CSP, and the served app's CSP (shared/ui.ts)
// has no 'unsafe-inline' for scripts, so an inline runtime in srcdoc never
// executes ("widget did not boot"). A network-served document carries its
// OWN Content-Security-Policy response header — this one. The host iframe
// stays sandbox="allow-scripts" (opaque origin), so this frame gets no
// same-origin power from being server-served.
import { RUNTIME_JS } from "./widget_runtime"
import { loadRegistry } from "./widgets"

export const WIDGET_CSP =
  "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src https: data:"

/** Pre-paint token defaults (dark), mirroring widget-tokens.ts fallbacks —
 *  the host's real theme arrives with amc:init before first meaningful render. */
const BAKED_TOKENS: Record<string, string> = {
  "--amc-bg": "#0B0E15",
  "--amc-layer": "#111624",
  "--amc-layer2": "#1A2133",
  "--amc-border": "#2A3245",
  "--amc-text": "#E9ECF4",
  "--amc-text-muted": "#8B94A9",
  "--amc-text-faint": "#6A7286",
  "--amc-accent": "#FFF676",
  "--amc-accent-fill": "#FFF676",
  "--amc-accent-ink": "#111214",
  "--amc-success": "#5BC873",
  "--amc-warning": "#E5B454",
  "--amc-danger": "#E56A6A",
  "--amc-font-sans": "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  "--amc-font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
  "--amc-pad": "14px 16px",
  "--amc-pad-tile": "10px 12px",
}

/** JSON-encode the widget source for inline embedding; \\u003c-escape keeps
 *  "</script>" and "<!--" inert inside the script element. */
export function embedCode(code: string): string {
  return JSON.stringify(code).replace(/</g, "\\u003c")
}

export function buildFrameHtml(code: string): string {
  const rootVars = Object.entries(BAKED_TOKENS)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ")
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${WIDGET_CSP}">
<style>
:root { ${rootVars} }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--amc-font-sans); color: var(--amc-text); font-size: 13px; }
button, input { font-family: inherit; }
</style>
</head>
<body>
<div id="amc-root"></div>
<script>window.__amcWidgetCode = ${embedCode(code)};</script>
<script>${RUNTIME_JS}</script>
</body>
</html>`
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Route body: the frame document, or a minimal error document (still our
 *  CSP; the host's boot timeout turns it into the error card). */
export function widgetFrameHtml(id: string | undefined): { ok: boolean; html: string } {
  if (typeof id !== "string" || !KEBAB.test(id))
    return { ok: false, html: "<!doctype html><body>bad widget id</body>" }
  const { widgets } = loadRegistry()
  const w = widgets.find((x) => x.manifest.id === id)
  if (!w) return { ok: false, html: `<!doctype html><body>unknown widget: ${id}</body>` }
  return { ok: true, html: buildFrameHtml(w.code) }
}

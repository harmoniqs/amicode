// AMICODE: shareable run card — a fixed 1200×630 (og-image aspect) SVG poster
// for one completed solve: headline fidelity with the nines in brand gold, the
// convergence curve, the final pulse (one path per drive), platform/gate, and
// the Harmoniqs sign-off. Deliberately theme-INDEPENDENT (always the premium
// dark look) so an exported card renders identically everywhere — think
// trading card, not UI panel. Pure string-SVG so the same markup drives both
// the in-app gallery (innerHTML) and the PNG export (SVG → Image → canvas).

// The mark geometry lives in ONE place — logo.tsx's MARK_PATH (a plain string
// const). Importing it here keeps this card from drifting into a private copy
// of the glyph, which is what this consolidation fixes. The mark is square
// (viewBox 0 0 3600 3600).
import { MARK_PATH } from "../components/logo"

export type RunCardData = {
  slug: string
  problem: string
  platform: string | null
  gate: string | null
  runId: string
  lab: string
  fidelity: number
  iterations: number | null
  elapsedMs: number | null
  finishedAt: number | null
  series: { iter: number; f: number }[]
  pulse: { dt: number; values: number[] } | null
  pulseMeta: { drives: number; knots: number } | null
}

export function parseRunCardsResponse(raw: unknown): RunCardData[] {
  if (typeof raw !== "object" || raw === null) return []
  const data = raw as { ok?: unknown; cards?: unknown }
  if (data.ok !== true || !Array.isArray(data.cards)) return []
  return data.cards
    .filter((c): c is Record<string, any> => typeof c === "object" && c !== null)
    .filter((c) => typeof c.run_id === "string" && typeof c.fidelity === "number")
    .map((c) => ({
      slug: typeof c.slug === "string" ? c.slug : "",
      problem: typeof c.problem === "string" ? c.problem : "",
      platform: typeof c.platform === "string" ? c.platform : null,
      gate: typeof c.gate === "string" ? c.gate : null,
      runId: c.run_id as string,
      lab: typeof c.lab === "string" ? c.lab : "default",
      fidelity: c.fidelity as number,
      iterations: typeof c.iterations === "number" ? c.iterations : null,
      elapsedMs: typeof c.elapsed_ms === "number" ? c.elapsed_ms : null,
      finishedAt: typeof c.finished_at === "number" ? c.finished_at : null,
      series: Array.isArray(c.series)
        ? c.series.filter((p: any) => p && Number.isFinite(p.iter) && Number.isFinite(p.f))
        : [],
      pulse:
        c.pulse && Array.isArray(c.pulse.values)
          ? { dt: Number(c.pulse.dt) || 0, values: c.pulse.values.filter((v: any) => Number.isFinite(v)) }
          : null,
      pulseMeta:
        c.pulse_meta && Number.isFinite(c.pulse_meta.drives)
          ? { drives: c.pulse_meta.drives as number, knots: Number(c.pulse_meta.knots) || 0 }
          : null,
    }))
}

// --- palette (fixed; NOT theme tokens — see header) --------------------------
const BG = "#0B0E15"
const PANEL = "#111624"
const LINE = "#2A3245"
const TEXT = "#E9ECF4"
const MUTED = "#8B94A9"
const GOLD = "#F2C94C"
const CURVE = "#7FD1FF"

const W = 1200
const H = 630

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** "0.99994" split so the run of leading nines after the point glows gold. */
export function fidelityParts(f: number): { pre: string; nines: string; rest: string } {
  const s = f >= 1 ? "1.00000" : f.toFixed(5)
  const [whole, frac = ""] = s.split(".")
  let i = 0
  while (i < frac.length && frac[i] === "9") i++
  return { pre: `${whole}.`, nines: frac.slice(0, i), rest: frac.slice(i) }
}

function pathFor(ys: number[], x: number, y: number, w: number, h: number, min: number, max: number): string {
  if (ys.length < 2) return ""
  const span = max - min || 1
  const step = w / (ys.length - 1)
  return ys
    .map((v, i) => `${i === 0 ? "M" : "L"}${(x + i * step).toFixed(1)},${(y + h - ((v - min) / span) * h).toFixed(1)}`)
    .join(" ")
}

function elapsedText(ms: number | null): string | null {
  if (ms === null || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

/** The full card as an SVG string (1200×630). */
export function renderRunCardSvg(d: RunCardData): string {
  const title = [d.gate, d.platform].filter(Boolean).join(" · ") || d.problem || "quantum pulse"
  const fp = fidelityParts(d.fidelity)
  const date = d.finishedAt ? new Date(d.finishedAt).toISOString().slice(0, 10) : null
  const meta = [
    d.iterations !== null ? `${d.iterations} iterations` : null,
    elapsedText(d.elapsedMs),
    date,
    d.runId.slice(0, 18),
  ]
    .filter(Boolean)
    .join("   ·   ")

  // convergence panel (log10 f) — right column; pulse reads first
  const logs = d.series.map((p) => Math.log10(Math.max(p.f, 1e-12)))
  const curvePath = logs.length >= 2 ? pathFor(logs, 640, 388, 480, 150, Math.min(...logs), Math.max(...logs)) : ""

  // pulse panel — one path per drive, shared scale — left column (the artifact leads)
  const drives = Math.max(1, d.pulseMeta?.drives ?? 1)
  const values = d.pulse?.values ?? []
  const knots = Math.floor(values.length / drives)
  let pulsePaths = ""
  if (knots >= 2) {
    const min = Math.min(...values)
    const max = Math.max(...values)
    for (let k = 0; k < drives; k++) {
      const seg = values.slice(k * knots, (k + 1) * knots)
      pulsePaths += `<path d="${pathFor(seg, 80, 388, 480, 150, min, max)}" fill="none" stroke="${GOLD}" stroke-width="2.5" stroke-linejoin="round" opacity="${k === 0 ? 1 : 0.55}"/>`
    }
  }

  const mono = "ui-monospace, SFMono-Regular, Menlo, monospace"
  const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif"

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  <rect x="0" y="0" width="${W}" height="6" fill="${GOLD}"/>
  <g transform="translate(80,64) scale(0.011)" fill="${GOLD}"><path fill-rule="evenodd" d="${MARK_PATH}"/></g>
  <text x="130" y="88" font-family="${sans}" font-size="22" font-weight="700" letter-spacing="4" fill="${TEXT}">AMICODE</text>
  <text x="262" y="88" font-family="${sans}" font-size="15" letter-spacing="3" fill="${MUTED}">SOLVED PULSE</text>

  <text x="80" y="175" font-family="${sans}" font-size="46" font-weight="700" fill="${TEXT}">${esc(title)}</text>
  <text x="80" y="210" font-family="${sans}" font-size="20" fill="${MUTED}">${esc(d.problem)}</text>

  <text x="80" y="308" font-family="${mono}" font-size="30" fill="${MUTED}">F =</text>
  <text x="150" y="308" font-family="${mono}" font-size="72" font-weight="700" fill="${TEXT}">${esc(fp.pre)}<tspan fill="${GOLD}">${esc(fp.nines)}</tspan><tspan fill="${MUTED}">${esc(fp.rest)}</tspan></text>
  <text x="80" y="345" font-family="${sans}" font-size="16" fill="${MUTED}">${esc(meta)}</text>

  <rect x="64" y="372" width="512" height="182" rx="10" fill="${PANEL}" stroke="${LINE}"/>
  <text x="80" y="558" font-family="${sans}" font-size="13" letter-spacing="2" fill="${MUTED}">FINAL PULSE${drives > 1 ? `  (${drives} drives)` : ""}</text>
  ${pulsePaths || `<text x="270" y="470" font-family="${sans}" font-size="14" fill="${MUTED}">no pulse data</text>`}

  <rect x="624" y="372" width="512" height="182" rx="10" fill="${PANEL}" stroke="${LINE}"/>
  <text x="640" y="558" font-family="${sans}" font-size="13" letter-spacing="2" fill="${MUTED}">CONVERGENCE  (log f)</text>
  ${curvePath ? `<path d="${curvePath}" fill="none" stroke="${CURVE}" stroke-width="2.5" stroke-linejoin="round"/>` : `<text x="830" y="470" font-family="${sans}" font-size="14" fill="${MUTED}">no iteration data</text>`}

  <text x="80" y="602" font-family="${sans}" font-size="15" fill="${MUTED}">Solved with <tspan fill="${TEXT}" font-weight="650">Amico</tspan> — your friendly Quantum Computing Agent</text>
  <text x="${W - 80}" y="602" text-anchor="end" font-family="${sans}" font-size="15" fill="${GOLD}">harmoniqs.ai</text>
</svg>`
}

/** Rasterize the card. Pure shapes/text → no canvas taint; 2x for retina. */
export async function runCardPngDataUrl(d: RunCardData, scale = 2): Promise<string> {
  const svg = renderRunCardSvg(d)
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error("card rasterize failed"))
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg)
  })
  const canvas = document.createElement("canvas")
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("no 2d context")
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL("image/png")
}

export function runCardFilename(d: RunCardData): string {
  const bits = [d.gate, d.platform, `F${d.fidelity.toFixed(4).replace(".", "")}`].filter(Boolean)
  return `amico-${bits
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "")}.png`
}

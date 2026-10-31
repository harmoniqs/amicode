/* Side panel v2 — view library prototype.
 *
 * The first-party views a declarative widget spec binds data to. Plain DOM +
 * inline SVG, no dependencies, tokens only (see mock.css). In the product these
 * become the widget-frame runtime's view registry; the signatures here are the
 * proposed `view` + `bind` contract (spec §B).
 */
;(function () {
  const SVGNS = "http://www.w3.org/2000/svg"

  function h(tag, attrs, ...kids) {
    const svg = /^(svg|g|path|line|rect|circle|text|polyline|polygon|defs|pattern|clipPath|tspan|title)$/.test(tag)
    const el = svg ? document.createElementNS(SVGNS, tag) : document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === "class") el.setAttribute("class", v)
      else if (k === "style" && typeof v === "object") for (const [sk, sv] of Object.entries(v)) sv != null && el.style.setProperty(sk.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), sv)
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v)
      else if (k === "html") el.innerHTML = v
      else el.setAttribute(k, v === true ? "" : v)
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
    }
    return el
  }

  /* ── formatting: researcher notation, honest units ─────────────────── */
  const SUP = { "-": "−" }
  function e(x, sig = 2) {
    if (x == null || !isFinite(x)) return "—"
    if (x === 0) return "0"
    const a = Math.abs(x)
    if (a >= 1e-2 && a < 1e4) return (x < 0 ? "−" : "") + trim(a.toPrecision(sig + 1))
    const [m, ex] = a.toExponential(sig - 1).split("e")
    return (x < 0 ? "−" : "") + m + "e" + ex.replace("+", "").replace(/^-/, "−")
  }
  function trim(s) {
    return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s
  }
  function F(x, digits = 4) {
    return x == null ? "—" : x.toFixed(digits)
  }
  function usd(x, digits) {
    if (x == null) return "—"
    const d = digits ?? (x >= 100 ? 0 : x >= 10 ? 1 : 2)
    return "$" + x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
  }
  function dur(s) {
    if (s == null) return "—"
    if (s < 90) return Math.round(s) + " s"
    const m = Math.round(s / 60)
    if (m < 90) return m + " min"
    const hh = Math.floor(m / 60)
    if (hh < 48) return hh + " h " + String(m % 60).padStart(2, "0") + " m"
    return (s / 86400).toFixed(1) + " d"
  }
  function ago(ts, now) {
    if (!ts) return "—"
    return dur(Math.max(0, now - ts)) + " ago"
  }
  function clock(ts) {
    const d = new Date(ts * 1000)
    return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })
  }
  const minus = (s) => String(s).replace(/-/g, "−")

  /* ── structural views ───────────────────────────────────────────────── */
  function Panel(o) {
    return h(
      "section",
      { class: "panel " + (o.cls || ""), style: o.style },
      (o.eyebrow || o.src || o.actions) &&
        h("header", null, h("span", { class: "eyebrow" }, o.eyebrow), o.chips, o.src && h("span", { class: "src" }, o.src), o.actions),
      h("div", { class: "body " + (o.flush ? "flush" : "") }, o.body),
      o.footer && h("footer", null, o.footer),
    )
  }
  // labels are written sentence-case; v0's eyebrow style uppercases them in CSS, the
  // alternatives don't. Element labels (notation in .nocase) are left untouched.
  const cap = (k) => (typeof k === "string" && /^[a-z]/.test(k) ? k[0].toUpperCase() + k.slice(1) : k)
  function Rows(pairs) {
    return h("dl", { class: "rows" }, pairs.filter(Boolean).map(([k, v]) => [h("dt", null, cap(k)), h("dd", { title: typeof v === "string" ? v : null }, v)]))
  }
  function Stats(items, cols) {
    return h(
      "div",
      { class: "stats", style: { "--cols": cols || items.length } },
      items.map((s) =>
        h("div", { class: "stat" }, h("div", { class: "v" }, s.v, s.u && h("small", null, s.u)), h("div", { class: "k eyebrow" }, cap(s.k)), s.note && h("div", { class: "note" }, s.note)),
      ),
    )
  }
  function Chip(text, kind, title) {
    return h("span", { class: "chip " + (kind || ""), title }, (kind === "live" || kind === "ok" || kind === "bad" || kind === "warn") && h("span", { class: "dot" }), text)
  }
  const VERDICT = { confirmed: ["ok", "confirmed"], refuted: ["bad", "refuted"], partial: ["warn", "partial"], open: ["open", "open"], stopped: ["stop", "stopped"] }
  function VerdictChip(cls, label) {
    const [kind, word] = VERDICT[cls] || VERDICT.open
    return Chip(word, kind, label)
  }
  function Rail(items) {
    return h(
      "ol",
      { class: "rail" },
      items.map((it) =>
        h("li", { class: it.state || "" }, h("span", { class: "node" }), h("div", { class: "t" }, h("span", null, it.title), it.chip, it.when && h("span", { class: "when" }, it.when)), it.detail && h("div", { class: "d" }, it.detail)),
      ),
    )
  }
  function Meter(frac, opts = {}) {
    return h("div", { class: "meter", title: opts.title }, h("span", { style: { width: Math.max(0, Math.min(1, frac)) * 100 + "%", background: opts.color } }))
  }
  function StackMeter(parts, total) {
    const sum = total ?? parts.reduce((a, p) => a + p.v, 0)
    return h("div", { class: "meter stack" }, parts.map((p) => h("span", { title: p.title, style: { width: (p.v / sum) * 100 + "%", background: p.color } })))
  }
  // shades for categorical stacks: neutral ink ramp, accent reserved for "this one"
  const RAMP = ["var(--amc-text)", "var(--amc-text-muted)", "color-mix(in srgb, var(--amc-text) 45%, transparent)", "color-mix(in srgb, var(--amc-text) 28%, transparent)", "color-mix(in srgb, var(--amc-text) 16%, transparent)", "var(--amc-ink-08)"]

  /* ── plots ──────────────────────────────────────────────────────────── */
  function scale(d0, d1, r0, r1) {
    const k = (r1 - r0) / (d1 - d0 || 1)
    return (x) => r0 + (x - d0) * k
  }
  /** Log-axis ticks: decades when the range is wide, 1-2-5 steps when it is narrow. */
  function logTicks(lo, hi) {
    if (hi - lo < 0.35) {
      // under ~half a decade, decade/1-2-5 ticks leave the axis bare: use linear steps in value space
      const vlo = 10 ** lo, vhi = 10 ** hi
      const raw = (vhi - vlo) / 4, mag = 10 ** Math.floor(Math.log10(raw))
      const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw)
      const ticks = []
      for (let v = Math.ceil(vlo / step) * step; v <= vhi; v += step) ticks.push({ y: Math.log10(v), label: e(v, 2) })
      return ticks
    }
    const out = []
    const mult = hi - lo < 1.6 ? [1, 2, 5] : [1]
    for (let p = Math.floor(lo); p <= Math.ceil(hi); p++)
      for (const m of mult) {
        const y = p + Math.log10(m)
        if (y >= lo && y <= hi) out.push({ y, label: m + "e" + minus(p) })
      }
    return out.length > 6 ? out.filter((_, i) => i % Math.ceil(out.length / 5) === 0) : out
  }
  function dotPattern(id) {
    return h("defs", null, h("pattern", { id, width: 16, height: 16, patternUnits: "userSpaceOnUse" }, h("circle", { cx: 8, cy: 8, r: 0.6, fill: "var(--amc-ink-13)" })))
  }
  let uid = 0

  /** Convergence curve: log10 objective vs iteration, dot-grid ground.
   *  series: [{pts:[[x,y]], cls, label}] — y is the objective (lower is better);
   *  non-positive y (unphysical F>1) are drawn as hollow marks on the floor. */
  function Convergence(o) {
    const W = o.w || 400, H = o.h || 150, L = 34, R = 8, T = 8, B = 18
    const all = o.series.flatMap((s) => s.pts)
    const pos = all.filter((p) => p[1] > 0).map((p) => Math.log10(p[1]))
    const fl = o.floor != null ? [Math.log10(o.floor)] : []
    const span = Math.max(...pos, ...fl) - Math.min(...pos, ...fl)
    const padY = Math.max(0.08, span * 0.08)
    const ylo = Math.min(...pos, ...fl) - padY
    const yhi = Math.max(...pos, ...fl) + padY
    const xs = all.map((p) => p[0])
    const sx = scale(Math.min(...xs), Math.max(...xs), L, W - R)
    const sy = scale(ylo, yhi, H - B, T)
    const id = "dg" + uid++
    const svg = h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.label || "convergence" }, dotPattern(id), h("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: `url(#${id})` }))
    if (o.watermark) svg.append(h("text", { class: "watermark", x: (L + W - R) / 2, y: (T + H - B) / 2 + 8, "text-anchor": "middle" }, o.watermark))
    for (const t of logTicks(ylo, yhi)) {
      svg.append(h("line", { class: "grid", x1: L, x2: W - R, y1: sy(t.y), y2: sy(t.y) }), h("text", { x: L - 5, y: sy(t.y) + 3, "text-anchor": "end" }, t.label))
    }
    if (o.floor != null) {
      const y = sy(Math.log10(o.floor))
      svg.append(h("line", { class: "zero", x1: L, x2: W - R, y1: y, y2: y }), h("text", { x: W - R, y: y - 3, "text-anchor": "end" }, o.floorLabel || "target"))
    }
    svg.append(h("line", { class: "axis", x1: L, x2: W - R, y1: H - B, y2: H - B }), h("line", { class: "axis", x1: L, x2: L, y1: T, y2: H - B }))
    const x0 = Math.min(...xs), x1 = Math.max(...xs)
    svg.append(h("text", { x: L, y: H - 5 }, String(x0)), h("text", { x: W - R, y: H - 5, "text-anchor": "end" }, String(x1) + (o.xunit ? " " + o.xunit : "")))
    for (const s of o.series) {
      const good = s.pts.filter((p) => p[1] > 0)
      if (good.length > 1) svg.append(h("polyline", { class: "trace " + (s.cls || ""), points: good.map((p) => `${sx(p[0]).toFixed(1)},${sy(Math.log10(p[1])).toFixed(1)}`).join(" ") }))
      for (const p of s.pts.filter((p) => p[1] <= 0)) svg.append(h("circle", { class: "mark hollow", cx: sx(p[0]), cy: H - B - 3, r: 2.2 }, h("title", null, `iter ${p[0]}: objective ${e(p[1])} ≤ 0 (unphysical)`)))
      const last = good[good.length - 1]
      if (last && s.endMark !== false) svg.append(h("circle", { class: "mark", cx: sx(last[0]), cy: sy(Math.log10(last[1])), r: 2.4 }))
    }
    return svg
  }

  function Sparkline(vals, o = {}) {
    const W = o.w || 120, H = o.h || 24
    const v = vals.filter((x) => x != null && isFinite(x))
    if (v.length < 2) return h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}`, width: W, height: H })
    const f = o.log ? (x) => Math.log10(Math.max(x, 1e-16)) : (x) => x
    const ys = v.map(f)
    const sx = scale(0, v.length - 1, 1, W - 3), sy = scale(Math.min(...ys), Math.max(...ys), H - 3, 3)
    return h(
      "svg",
      { class: "plot", viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: { width: W + "px" } },
      h("polyline", { class: "trace thin", points: ys.map((y, i) => `${sx(i).toFixed(1)},${sy(y).toFixed(1)}`).join(" ") }),
      h("circle", { class: "mark", cx: sx(v.length - 1), cy: sy(ys[ys.length - 1]), r: 2 }),
    )
  }

  /** Horizontal stacked bars, one row per item: rows [{label, parts:[{k,v}], note}] */
  function StackBars(rows, o = {}) {
    const keys = o.keys || [...new Set(rows.flatMap((r) => r.parts.map((p) => p.k)))]
    const max = o.max || Math.max(...rows.map((r) => r.parts.reduce((a, p) => a + p.v, 0)))
    const W = o.w || 400, rowH = 22, L = o.labelW || 110, R = 56
    const H = rows.length * rowH + 4
    const sx = scale(0, max, 0, W - L - R)
    const svg = h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}` })
    rows.forEach((r, i) => {
      const y = i * rowH + 4
      svg.append(h("text", { x: 0, y: y + 11, style: { fill: "var(--amc-text-muted)", "font-size": "10px" } }, r.label))
      let x = L
      for (const p of r.parts) {
        const w = sx(p.v)
        const ki = keys.indexOf(p.k)
        const fill = (o.colors && o.colors[p.k]) || RAMP[ki % RAMP.length]
        // a yellow fill always takes the ink edge by day (transparent by night)
        const edge = fill === "var(--amc-accent)" ? { stroke: "var(--amc-accent-edge)", "stroke-width": 1 } : {}
        svg.append(h("rect", { x: x + 0.5, y: y + 2.5, width: Math.max(0, w - 1.5), height: 11, rx: 1, fill, ...edge }, h("title", null, `${p.k}: ${o.fmt ? o.fmt(p.v) : p.v}`)))
        x += w
      }
      svg.append(h("text", { x: x + 6, y: y + 11, style: { fill: "var(--amc-text)", "font-size": "10px" } }, o.fmt ? o.fmt(r.parts.reduce((a, p) => a + p.v, 0)) : ""))
    })
    const legend = h("div", { class: "legend" }, keys.map((k, i) => { const c = (o.colors && o.colors[k]) || RAMP[i % RAMP.length]; return h("span", null, h("i", { class: "sq", style: { background: c, "box-shadow": c === "var(--amc-accent)" ? "inset 0 0 0 1px var(--amc-accent-edge)" : null } }), k) }))
    return h("div", null, svg, o.legend === false ? null : legend)
  }

  /** Forest plot of paired deltas with CIs. rows [{label, mean, lo, hi, reading}] */
  function Forest(rows, o = {}) {
    const W = o.w || 400, rowH = 24, L = o.labelW || 150, R = 70, T = 6
    const H = rows.length * rowH + T + 16
    const lo = Math.min(0, ...rows.map((r) => r.lo)), hi = Math.max(0, ...rows.map((r) => r.hi))
    const pad = (hi - lo) * 0.08
    const sx = scale(lo - pad, hi + pad, L, W - R)
    const svg = h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}` })
    svg.append(h("line", { class: "zero", x1: sx(0), x2: sx(0), y1: T - 2, y2: H - 14 }), h("text", { x: sx(0), y: H - 3, "text-anchor": "middle" }, "0"))
    svg.append(h("text", { x: sx(lo - pad), y: H - 3 }, e(lo - pad, 1)), h("text", { x: sx(hi + pad), y: H - 3, "text-anchor": "end" }, e(hi + pad, 1)))
    rows.forEach((r, i) => {
      const y = T + i * rowH + 10
      svg.append(h("text", { x: 0, y: y + 3, style: { fill: "var(--amc-text-muted)", "font-size": "10px" } }, r.label))
      const strong = r.lo > 0 || r.hi < 0
      svg.append(h("line", { class: "ci", x1: sx(r.lo), x2: sx(r.hi), y1: y, y2: y, style: { opacity: strong ? 1 : 0.45 } }))
      svg.append(h("line", { class: "ci", x1: sx(r.lo), x2: sx(r.lo), y1: y - 3, y2: y + 3, style: { opacity: strong ? 1 : 0.45 } }), h("line", { class: "ci", x1: sx(r.hi), x2: sx(r.hi), y1: y - 3, y2: y + 3, style: { opacity: strong ? 1 : 0.45 } }))
      svg.append(h("rect", { x: sx(r.mean) - 3, y: y - 3, width: 6, height: 6, class: strong ? "mark" : "mark hollow", style: strong ? null : { fill: "var(--amc-bg)", stroke: "var(--amc-trace)" } }))
      svg.append(h("text", { x: W - R + 8, y: y + 3, style: { fill: "var(--amc-text)", "font-size": "10px" } }, (r.mean > 0 ? "+" : "") + e(r.mean)))
    })
    return svg
  }

  /** Dot strip on a log axis: groups [{label, pts:[{x, label, hi}]}]; lower is better. */
  function LogStrip(groups, o = {}) {
    const W = o.w || 400, rowH = 26, L = o.labelW || 56, R = 10, T = 4
    const H = groups.length * rowH + T + 16
    const xs = groups.flatMap((g) => g.pts.map((p) => Math.log10(p.x)))
    const lo = Math.floor(Math.min(...xs) * 2) / 2, hi = Math.ceil(Math.max(...xs) * 2) / 2
    const sx = scale(lo, hi, L, W - R)
    const svg = h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}` })
    for (let t = Math.ceil(lo); t <= hi; t++) svg.append(h("line", { class: "grid", x1: sx(t), x2: sx(t), y1: T, y2: H - 14 }), h("text", { x: sx(t), y: H - 3, "text-anchor": "middle" }, "1e" + minus(t)))
    if (o.ref != null) svg.append(h("line", { class: "zero", x1: sx(Math.log10(o.ref)), x2: sx(Math.log10(o.ref)), y1: T, y2: H - 14 }))
    groups.forEach((g, i) => {
      const y = T + i * rowH + 11
      svg.append(h("line", { class: "grid", x1: L, x2: W - R, y1: y, y2: y }))
      svg.append(h("text", { x: 0, y: y + 3, style: { fill: "var(--amc-text-muted)", "font-size": "10px" } }, g.label))
      for (const p of g.pts) {
        svg.append(h("circle", { cx: sx(Math.log10(p.x)), cy: y, r: p.hi ? 4 : 2.6, class: p.hi ? "mark" : "mark hollow", style: p.hi ? { stroke: "var(--amc-accent-edge)", fill: "var(--amc-trace)" } : null }, h("title", null, `${g.label} · ${p.label}: R_L = ${e(p.x, 3)}`)))
        if (p.hi) svg.append(h("text", { x: sx(Math.log10(p.x)) + 7, y: y - 5, style: { fill: "var(--amc-text)", "font-size": "9px" } }, p.label))
      }
    })
    return svg
  }

  /* ── app shell ──────────────────────────────────────────────────────── */
  const ICON = {
    home: '<path d="M3 8.5 9 3.5l6 5V15H11v-4H7v4H3z"/>',
    fleet: '<rect x="2.5" y="4" width="13" height="8" rx="1"/><path d="M6 15h6M9 12v3"/>',
    more: '<circle cx="4" cy="9" r=".6"/><circle cx="9" cy="9" r=".6"/><circle cx="14" cy="9" r=".6"/>',
    max: '<path d="M10.5 3.5h4v4M7.5 14.5h-4v-4M14.5 3.5l-5 5M3.5 14.5l5-5"/>',
    close: '<path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/>',
  }
  function icon(name, label) {
    return h("button", { class: "icon-btn", "aria-label": label, title: label, html: `<svg viewBox="0 0 18 18" aria-hidden="true">${ICON[name]}</svg>` })
  }
  /** The Work Column with v2 IA: session tabs Now · Files · Context, global Home · Fleet. */
  function WorkColumn(o) {
    const tabs = [
      ["now", "Now", o.nowBadge],
      ["files", "Files", o.filesBadge],
      ["context", "Context"],
    ]
    const head = h(
      "div",
      { class: "wc-head" },
      h("div", { class: "seg", role: "tablist", "aria-label": "Session" }, tabs.map(([id, label, badge]) => h("button", { role: "tab", "aria-selected": String(o.tab === id) }, label, badge ? h("span", { class: "badge" }, badge) : null))),
      h("span", { class: "spacer" }),
      h("div", { class: "seg", role: "tablist", "aria-label": "Global" }, h("button", { role: "tab", "aria-selected": String(o.tab === "home"), title: "Home — every session" }, "Home"), h("button", { role: "tab", "aria-selected": String(o.tab === "fleet") }, "Fleet")),
      icon("max", "Maximize work column"),
    )
    const body = h("div", { class: "wc-body" })
    const wc = h("aside", { class: "wc", "aria-label": "Work column" }, head, o.session && h("div", { class: "wc-session" }, h("span", { class: "title" }, o.session), o.sessionChip), body)
    return { el: wc, body }
  }
  function ChatGhost(lines) {
    return h(
      "div",
      { class: "chat-ghost", "aria-hidden": "true" },
      (lines || []).map((l) => h("div", { class: "bubble " + (l.me ? "me" : "") }, l.text ? h("div", { style: { color: "var(--amc-text-muted)", "font-size": "13px" } }, l.text) : null, Array.from({ length: l.n || 2 }, (_, i) => h("div", { class: "line", style: { width: 60 + ((i * 37) % 40) + "%" } })))),
    )
  }
  function mountFrame(o) {
    const wc = WorkColumn(o)
    // inside compare.html's iframes there is no room for the chat column: render the panel alone
    const solo = o.solo || window.top !== window
    const frame = h("div", { class: "frame" + (solo ? " solo" : ""), style: solo ? { "--panel-w": "100%" } : o.panelW ? { "--panel-w": o.panelW + "px" } : null }, solo ? null : ChatGhost(o.chat), wc.el)
    document.body.append(frame)
    return wc.body
  }
  /** Maximized Work Column / Home: the same tab strip, a full-width board below. */
  function mountWide(o) {
    const wc = WorkColumn(o)
    const head = wc.el.querySelector(".wc-head")
    const wrap = h("div", { class: "board-wrap" })
    document.body.append(h("div", { class: "wide-frame" }, head, wrap))
    return wrap
  }
  /** Gantt of intervals: rows [{label, bars:[{t0,t1,k,title}]}] on a shared time axis. */
  function Gantt(rows, o = {}) {
    const W = o.w || 800, rowH = 18, L = o.labelW || 120, R = 8, T = 4
    const H = rows.length * rowH + T + 18
    const t0 = o.t0 ?? Math.min(...rows.flatMap((r) => r.bars.map((b) => b.t0))), t1 = o.t1 ?? Math.max(...rows.flatMap((r) => r.bars.map((b) => b.t1)))
    const sx = scale(t0, t1, L, W - R)
    const id = "dg" + uid++
    const svg = h("svg", { class: "plot", viewBox: `0 0 ${W} ${H}` }, dotPattern(id), h("rect", { x: L, y: T, width: W - L - R, height: H - T - 18, fill: `url(#${id})` }))
    const day = 86400
    for (let t = Math.ceil(t0 / day) * day; t <= t1; t += day) {
      svg.append(h("line", { class: "grid", x1: sx(t), x2: sx(t), y1: T, y2: H - 16 }), h("text", { x: sx(t) + 3, y: H - 4 }, new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })))
    }
    rows.forEach((r, i) => {
      const y = T + i * rowH
      svg.append(h("text", { x: 0, y: y + 12, style: { fill: "var(--amc-text-muted)", "font-size": "10px" } }, r.label))
      for (const b of r.bars) svg.append(h("rect", { x: sx(b.t0), y: y + 4, width: Math.max(1.5, sx(b.t1) - sx(b.t0)), height: rowH - 8, rx: 1, fill: (o.colors && o.colors[b.k]) || "var(--amc-text)" }, h("title", null, b.title || "")))
    })
    return svg
  }

  function themeToggle() {
    const q = new URLSearchParams(location.search).get("theme")
    const pref = q || localStorage.getItem("sp2-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    document.documentElement.dataset.theme = pref
    const b = h("button", { class: "btn theme-toggle", onclick: () => {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"
      document.documentElement.dataset.theme = t
      localStorage.setItem("sp2-theme", t)
    } }, "Light / Dark")
    // design directions (styles.css): v0 = the first pass; a/b/c = the alternatives
    const sq = new URLSearchParams(location.search).get("style")
    const style = sq || localStorage.getItem("sp2-style") || "v0"
    document.documentElement.dataset.style = style
    if (!document.querySelector('link[href="styles.css"]')) document.head.append(h("link", { rel: "stylesheet", href: "styles.css" }))
    const names = { v0: "First pass", a: "A · Swiss", b: "B · Paper", c: "C · Instrument" }
    const seg = h("div", { class: "seg style-switch", role: "tablist", "aria-label": "Design direction" },
      Object.entries(names).map(([k, label]) => h("button", { role: "tab", "aria-selected": String(k === style), onclick: () => {
        localStorage.setItem("sp2-style", k)
        const u = new URL(location.href)
        u.searchParams.set("style", k)
        location.href = u.toString()
      } }, label)))
    if (window.top === window) document.body.append(h("div", { class: "theme-toggle", style: { display: "flex", gap: "8px", "align-items": "center" } }, seg, b))
    b.classList.remove("theme-toggle")
  }

  window.V = { h, e, F, usd, dur, ago, clock, minus, Panel, Rows, Stats, Chip, VerdictChip, Rail, Meter, StackMeter, RAMP, Convergence, Sparkline, StackBars, Forest, LogStrip, Gantt, mountFrame, mountWide, themeToggle, icon }
})()

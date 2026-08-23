/* ================================================================
   amico is thinking — the shape of a thought (native engine)

   A charted fugue over the real vault graph, rendered on a canvas that
   lives IN the host document. This is the live-embed half of the retired
   /brain.html iframe prototype, ported to a framework-free module so the
   session brain-strip can drive it with direct calls instead of a
   postMessage bridge.

   Why native (2026-07-20): the iframe boundary broke this animation three
   independent ways — document requests can't carry server auth (armed
   password ⇒ 401 ⇒ blank strip), a parent/child color-scheme mismatch
   makes the browser composite the transparent frame OPAQUE WHITE (async
   webview theming ⇒ white box, and theme flips forced a full reload), and
   the page painted its own stylesheet ground + prototype chrome for the
   first frames before script could hide them. In-document there is no
   fetch, no second color-scheme, no boot chrome: the canvas ground is
   transparent from frame zero and setTheme() repaints without losing the
   atlas.

   Timing law:   every event snaps to a musical grid (allegro, q=126).
   Mechanics:    integrate-and-fire — arrival is not firing; scouts charge
                 nodes that may leak back to dark; refractory periods gate
                 re-firing; warm-start edges conduct saltatory.
   Brand law:    circles only; #FFE614 belongs to live thought alone; the
                 embed is monochrome + brand yellow; glow budget: pulse +
                 active node only.
   ================================================================ */

import { BRAIN_DATA } from "./brain-data"

export type BrainScheme = "dark" | "light"

export type BrainTouchEvent = {
  label: string
  type?: string
  /** scout flash (search/glob) — may leak back to dark, never claims */
  consider?: boolean
  /** a prior turn's step: restore instantly and quietly, no pulses */
  replay?: boolean
}

export interface BrainEngineOptions {
  scheme?: BrainScheme
  /** override prefers-reduced-motion (tests) */
  reduceMotion?: boolean
  /** drive the render loop via requestAnimationFrame (default true; tests call tick()) */
  animate?: boolean
  /** layout fallback when the canvas has no measured size yet */
  size?: { width: number; height: number }
}

export interface BrainEngineStats {
  scheme: BrainScheme
  nodes: number
  edges: number
  claimed: number
  atlas: number
  queued: number
  cur: string
}

export interface BrainEngine {
  touch(ev: BrainTouchEvent): void
  /** chart the commits since the last plate as a named constellation */
  chart(title: string, replay?: boolean): void
  /** a glance from the log: ring the node and turn the camera to it */
  highlight(label: string): void
  /** lossless: swaps the palette and repaints — the atlas persists */
  setTheme(scheme: BrainScheme): void
  /** omit both to re-measure from the canvas box (e.g. after mount/layout) */
  resize(width?: number, height?: number): void
  /** advance one frame; the rAF loop calls this when animate is on */
  tick(nowMs: number): void
  /** folded away — stop burning frames */
  pause(): void
  resume(): void
  destroy(): void
  stats(): BrainEngineStats
}

/* ---------- category mapping (fixed, never cycled) ---------- */
const CAT_OF_TYPE: Record<string, string> = {
  note: "knowledge",
  insight: "knowledge",
  charter: "knowledge",
  experiment: "results",
  catalog: "results",
  skill: "skills",
  package: "code",
  resource: "code",
  agent: "agents",
  core: "core",
}

/* ---------- tokens ----------
   The iframe read these from its own stylesheet with getComputedStyle; the
   native engine carries both palettes (ported verbatim from brain.html's
   :root blocks) so a theme flip is a repaint, never a reload. */
type Palette = {
  fg: string
  edgeRest: string
  nodeFill: string
  nodeBorder: string
  thought: string
  ember: string
  labelHalo: string
  accent: string
  cat: Record<string, string>
}
const PALETTES: Record<BrainScheme, Palette> = {
  dark: {
    fg: "#d6d6d2",
    edgeRest: "rgba(255, 255, 255, 0.13)",
    nodeFill: "#242423",
    nodeBorder: "rgba(255, 255, 255, 0.24)",
    thought: "#FFE614",
    ember: "rgba(232, 230, 218, 1)",
    labelHalo: "rgba(19, 19, 18, 0.72)",
    accent: "#FFE614",
    cat: {
      knowledge: "#3794ff",
      results: "#c17800",
      skills: "#9b6bc4",
      code: "#4d9e51",
      agents: "#c9c9c4",
    },
  },
  light: {
    fg: "#22221f",
    edgeRest: "rgba(0, 0, 0, 0.15)",
    nodeFill: "#eae7dd",
    nodeBorder: "rgba(0, 0, 0, 0.26)",
    thought: "#8f8000",
    ember: "rgba(64, 62, 50, 1)",
    labelHalo: "rgba(250, 249, 246, 0.78)",
    accent: "#FFE614",
    cat: {
      knowledge: "#1866c9",
      results: "#8f5800",
      skills: "#7b4fa8",
      code: "#33753a",
      agents: "#4a4a44",
    },
  },
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  const n = parseInt(
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h,
    16,
  )
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgba(color: string, a: number): string {
  if (color.startsWith("rgba") || color.startsWith("rgb")) return color
  const [r, g, b] = hexToRgb(color)
  return `rgba(${r},${g},${b},${a})`
}

/* ---------- graph shapes ---------- */
interface BNode {
  id: string
  label: string
  type: string
  cat: string
  x: number
  y: number
  fx: number
  fy: number
  deg: number
  half: number
  claimed: boolean
  flash: number
  consider: number
  labelA: number
  refractUntil: number
  ringT: number
  touchedAt: number
  uses: number
  breathe: number
  atlasKeep: boolean
}
interface BEdge {
  s: BNode
  t: BNode
  kind: string
  passes: number
  ember: number
  myelin: boolean
  liveT: number
  ghost: boolean
  atlasKeep: boolean
}
interface Pulse {
  e: BEdge
  rev: boolean
  kind: string
  t0: number
  dur: number
  onArrive: (() => void) | null
  trail: { x: number; y: number }[]
  lastSample: number
}
interface Constellation {
  pts: BNode[]
  title: string
  plate: string
  progress: number
  alpha: number
  born: number
}

const ROMAN = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
]

const TEMPI = [
  { bpm: 42, name: "largo" },
  { bpm: 84, name: "andante" },
  { bpm: 126, name: "allegro" },
  { bpm: 168, name: "presto" },
]

export function createBrainEngine(canvas: HTMLCanvasElement, opts: BrainEngineOptions = {}): BrainEngine {
  let scheme: BrainScheme = opts.scheme === "light" ? "light" : "dark"
  let css: Palette = PALETTES[scheme]
  // live: honors mid-session OS toggles (the iframe only re-read it on reload)
  let reduceMotion =
    opts.reduceMotion ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  let motionQuery: MediaQueryList | null = null
  const onMotionChange = (e: MediaQueryListEvent) => {
    reduceMotion = e.matches
  }
  if (opts.reduceMotion === undefined && typeof matchMedia !== "undefined") {
    motionQuery = matchMedia("(prefers-reduced-motion: reduce)")
    motionQuery.addEventListener("change", onMotionChange)
  }
  const animate = opts.animate ?? true
  const ctx = canvas.getContext("2d")

  /* ---------- square-bloom sprites (glow budget: live things only) ---------- */
  let bloom: HTMLCanvasElement | null = null
  function buildSprites() {
    if (typeof document === "undefined") return // test env: draw guards on null
    const S = 64
    const c = document.createElement("canvas")
    c.width = c.height = S
    const x = c.getContext("2d")
    if (!x) return
    // stacked circles, not a radial gradient: the bloom keeps the round motif
    const steps: [number, number][] = [
      [30, 0.28],
      [22, 0.35],
      [14, 0.5],
    ]
    for (const [half, a] of steps) {
      x.fillStyle = rgba(css.thought, a * 0.35)
      x.beginPath()
      x.arc(S / 2, S / 2, half, 0, Math.PI * 2)
      x.fill()
    }
    bloom = c
  }
  buildSprites()

  /* ---------- graph construction ---------- */
  const nodes: BNode[] = []
  const byId = new Map<string, BNode>()
  const edges: BEdge[] = []
  const adj = new Map<string, { to: string; e: BEdge }[]>()
  const edgeSeen = new Map<string, BEdge>()
  function addNode(n: { id: string; label: string; type: string }): BNode {
    const prior = byId.get(n.id)
    if (prior) return prior
    const node: BNode = {
      id: n.id,
      label: n.label,
      type: n.type,
      cat: CAT_OF_TYPE[n.type] || "knowledge",
      x: 0,
      y: 0,
      fx: 0,
      fy: 0,
      deg: 0,
      half: 3,
      claimed: false,
      flash: 0,
      consider: 0,
      labelA: 0,
      refractUntil: -1,
      ringT: -1,
      touchedAt: -1,
      uses: 0,
      breathe: Math.random() * 6.28,
      atlasKeep: false,
    }
    nodes.push(node)
    byId.set(n.id, node)
    return node
  }
  function addEdge(s: string, t: string, kind: string): BEdge | null {
    if (s === t || !byId.has(s) || !byId.has(t)) return null
    const key = s < t ? s + "|" + t : t + "|" + s
    const prior = edgeSeen.get(key)
    if (prior) return prior
    const e: BEdge = {
      s: byId.get(s)!,
      t: byId.get(t)!,
      kind: kind || "wikilink",
      passes: 0,
      ember: 0,
      myelin: false,
      liveT: -1,
      ghost: kind === "thought",
      atlasKeep: false,
    }
    edgeSeen.set(key, e)
    edges.push(e)
    byId.get(s)!.deg++
    byId.get(t)!.deg++
    if (!adj.has(s)) adj.set(s, [])
    if (!adj.has(t)) adj.set(t, [])
    adj.get(s)!.push({ to: t, e })
    adj.get(t)!.push({ to: s, e })
    return e
  }
  function bfs(a: string, b: string, maxHops?: number): string[] | null {
    if (a === b) return [a]
    const q: string[][] = [[a]]
    const seen = new Set([a])
    while (q.length) {
      const path = q.shift()!
      if (path.length > (maxHops || 6)) continue
      for (const { to } of adj.get(path[path.length - 1]) || []) {
        if (seen.has(to)) continue
        const np = path.concat(to)
        if (to === b) return np
        seen.add(to)
        q.push(np)
      }
    }
    return null
  }

  for (const n of BRAIN_DATA.nodes) addNode(n)
  addNode({ id: "amico", label: "amico", type: "core" })
  for (const n of BRAIN_DATA.nodes) if (n.type === "agent") addEdge("amico", n.id, "dispatch")
  if (byId.has("using-amico")) addEdge("amico", "using-amico", "dispatch")
  for (const e of BRAIN_DATA.edges) addEdge(e.s, e.t, e.kind)
  // a thought may connect notes the vault has not linked yet: consecutive trace
  // steps without a vault edge get a dashed "thought edge", invisible until used
  for (const tr of BRAIN_DATA.traces) {
    let prev = "amico"
    for (const st of tr.steps) {
      if (!byId.has(st.node)) continue
      const hasPath = bfs(prev, st.node, 4)
      if (!hasPath) addEdge(prev, st.node, "thought")
      prev = st.node
    }
  }

  /* size classes — atlas magnitudes, quantized, never continuous */
  for (const n of nodes) {
    n.half = n.type === "core" ? 8 : n.cat === "agents" ? 6.5 : n.deg > 9 ? 6 : n.deg > 5 ? 5 : n.deg > 2 ? 4 : 3
  }

  /* ---------- layout: cluster-anchored force settle, then frozen ----------
     The strip is a wide frame: lay the graph out natively wide (wide anchor
     ellipse + anisotropic gravity) so distances stay isotropic — a warped
     projection reads as squashed, a wide LAYOUT reads as a landscape. */
  const CLUSTER_ANGLE: Record<string, number> = {
    knowledge: -Math.PI / 2,
    skills: Math.PI * 0.05,
    results: Math.PI / 2,
    code: Math.PI * 0.95,
    agents: 0,
    core: 0,
  }
  function repel() {
    for (let a = 0; a < nodes.length; a++) {
      for (let b = a + 1; b < nodes.length; b++) {
        const A = nodes[a],
          B = nodes[b]
        let dx = A.x - B.x,
          dy = A.y - B.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          d2 = 1
          dx = Math.sin(a * 7 + b)
          dy = Math.cos(a - b * 3)
        }
        const f = 1900 / d2
        const d = Math.sqrt(d2)
        A.fx += (dx / d) * f
        A.fy += (dy / d) * f
        B.fx -= (dx / d) * f
        B.fy -= (dy / d) * f
      }
    }
    for (const e of edges) {
      const dx = e.t.x - e.s.x,
        dy = e.t.y - e.s.y
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
      const rest = e.kind === "dispatch" ? 95 : 70
      const f = (d - rest) * 0.015 * (e.ghost ? 0.25 : 1)
      e.s.fx += (dx / d) * f * d * 0.02
      e.s.fy += (dy / d) * f * d * 0.02
      e.t.fx -= (dx / d) * f * d * 0.02
      e.t.fy -= (dy / d) * f * d * 0.02
    }
  }
  function settle() {
    const AX = 2.3
    const AY = 0.75
    const R = 340
    let i = 0
    for (const n of nodes) {
      const ang = CLUSTER_ANGLE[n.cat] + Math.sin(i * 12.9898) * 0.55
      const rad = n.cat === "agents" ? 90 + (i % 5) * 18 : n.type === "core" ? 0 : R * (0.55 + ((i * 0.618) % 0.45))
      n.x = Math.cos(ang) * rad * AX + Math.sin(i * 78.233) * 40
      n.y = Math.sin(ang) * rad * AY + Math.cos(i * 37.719) * 40
      i++
    }
    const core = byId.get("amico")!
    core.x = 0
    core.y = 0
    for (let it = 0; it < 380; it++) {
      for (const n of nodes) {
        n.fx = 0
        n.fy = 0
      }
      repel()
      for (const n of nodes) {
        const ang = CLUSTER_ANGLE[n.cat]
        const ax = n.type === "core" ? 0 : Math.cos(ang) * (n.cat === "agents" ? 100 : 300) * AX
        const ay = n.type === "core" ? 0 : Math.sin(ang) * (n.cat === "agents" ? 100 : 300) * AY
        n.fx += (ax - n.x) * 0.004
        n.fy += (ay - n.y) * 0.004
        n.fx += -n.x * 0.0008
        n.fy += -n.y * 0.0034
        if (n.type !== "core") {
          n.x += Math.max(-6, Math.min(6, n.fx))
          n.y += Math.max(-6, Math.min(6, n.fy))
        }
      }
    }
    // stretch-then-relax: pull the settled layout wide, then let springs
    // restore natural local distances inside a vertically-contained envelope
    // — locally isotropic structure, globally wide silhouette
    for (const n of nodes) if (n.type !== "core") n.x *= 3.1
    for (let it = 0; it < 150; it++) {
      for (const n of nodes) {
        n.fx = 0
        n.fy = 0
      }
      repel()
      for (const n of nodes) {
        n.fx += -n.x * 0.0004 // gentle horizontal containment
        n.fy += -n.y * 0.009 // firm vertical envelope
        if (n.type !== "core") {
          n.x += Math.max(-6, Math.min(6, n.fx))
          n.y += Math.max(-6, Math.min(6, n.fy))
        }
      }
    }
    // normalize into a unit box we can fit to any viewport; the amico core IS
    // the center of the world — everything references it
    let minX = 1e9,
      maxX = -1e9,
      minY = 1e9,
      maxY = -1e9
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x)
      minY = Math.min(minY, n.y)
      maxY = Math.max(maxY, n.y)
    }
    const span = Math.max(maxX - minX, maxY - minY)
    const cx = core.x,
      cy = core.y
    for (const n of nodes) {
      n.x = (n.x - cx) / span
      n.y = (n.y - cy) / span
    }
  }
  settle()

  /* ---------- canvas & camera ---------- */
  let W = 0,
    H = 0,
    DPR = 1,
    worldScale = 1
  function resize(width?: number, height?: number) {
    DPR = Math.min((typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1) || 1, 2)
    W = width ?? canvas.clientWidth ?? 0
    H = height ?? canvas.clientHeight ?? 0
    // junk-proof: a NaN/negative box would poison every projection this frame
    // and a zero worldScale divides the camera fit by 0 — fall back instead
    if (!Number.isFinite(W) || !Number.isFinite(H) || W < 1 || H < 1) {
      W = opts.size?.width ?? 800
      H = opts.size?.height ?? 224
    }
    canvas.width = W * DPR
    canvas.height = H * DPR
    worldScale = Math.min(W, H) * 0.86
  }
  resize()
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    // the strip breathes 72px ↔ 224px; track the real box, not a boot snapshot
    ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
  }
  // webview/app zoom changes devicePixelRatio WITHOUT changing the CSS box —
  // ResizeObserver stays silent and the backing store goes stale (blurry
  // graph until an unrelated layout resize). Watch the dppx itself and re-arm
  // after every change, since the query is pinned to one exact ratio.
  let dprQuery: MediaQueryList | null = null
  const onDprChange = () => {
    resize()
    armDprWatch()
  }
  function armDprWatch() {
    if (typeof matchMedia === "undefined" || typeof devicePixelRatio === "undefined") return
    dprQuery?.removeEventListener("change", onDprChange)
    dprQuery = matchMedia(`(resolution: ${devicePixelRatio}dppx)`)
    dprQuery.addEventListener("change", onDprChange)
  }
  armDprWatch()

  const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 }
  function nx(n: BNode) {
    return (n.x * worldScale - cam.x) * cam.k + W / 2
  }
  function ny(n: BNode) {
    return (n.y * worldScale - cam.y) * cam.k + H / 2
  }

  /* ---------- musical clock ---------- */
  const clock = { beat: 0, tempoIx: 2, lastMs: 0 } // allegro — an embedded moment earns a brisker thought
  function bpmNow() {
    return TEMPI[clock.tempoIx].bpm
  }
  const dueQueue: { t: number; fn: () => void }[] = []
  function at(beatsFromNow: number, fn: () => void) {
    dueQueue.push({ t: clock.beat + beatsFromNow, fn })
  }
  function runDue() {
    for (let i = dueQueue.length - 1; i >= 0; i--) {
      if (dueQueue[i].t <= clock.beat) {
        const q = dueQueue.splice(i, 1)[0]
        q.fn()
      }
    }
  }

  /* ---------- pulses ---------- */
  const pulses: Pulse[] = []
  function firePulse(e: BEdge, from: BNode, kind: string, durBeats: number, onArrive: (() => void) | null) {
    pulses.push({ e, rev: e.s !== from, kind, t0: clock.beat, dur: durBeats, onArrive, trail: [], lastSample: -1 })
    e.liveT = clock.beat
  }
  function pulsePos(p: Pulse, tNorm: number) {
    let q = tNorm
    if (p.e.myelin) {
      // saltatory: three staccato leaps, dwell between
      const seg = Math.min(2, Math.floor(q * 3))
      const local = q * 3 - seg
      const eased = local < 0.55 ? local / 0.55 : 1 // fast leap, brief dwell
      q = (seg + eased) / 3
    } else if (p.kind === "commit") {
      q = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2 // on-beat depart/arrive
    } // scouts stay linear: constant conduction velocity, feel the geometry
    const a = p.rev ? p.e.t : p.e.s,
      b = p.rev ? p.e.s : p.e.t
    return { x: nx(a) + (nx(b) - nx(a)) * q, y: ny(a) + (ny(b) - ny(a)) * q }
  }

  /* ---------- atlas ---------- */
  const atlas: Constellation[] = [] // charted constellations, permanent for the session
  let plate = 0

  function claim(node: BNode) {
    node.claimed = true
    node.flash = 1
    node.ringT = clock.beat
    node.labelA = 1
    node.touchedAt = clock.beat
    node.uses++
    node.refractUntil = clock.beat + 2
  }
  function conduct(node: BNode) {
    // pass-through: signal conducts, node does not claim
    node.consider = Math.max(node.consider, 0.55)
  }
  function potentiate(e: BEdge) {
    e.passes++
    e.ember = Math.min(0.15 + 0.175 * e.passes, 0.5)
  }

  /* ---------- live thought: the host streams the REAL session ----------
     Reads and skill invocations COMMIT — a pulse travels the skeleton and the
     node claims its color. Searches/globs CONSIDER — a scout flash that may
     leak back to dark. Labels matching skeleton nodes light the real graph;
     unknown files graft new nodes beside the current position over dashed
     thought-edges. */
  const live = {
    cur: "amico",
    queue: [] as BNode[],
    pumping: false,
    recent: new Map<string, number>(),
    sinceChart: [] as BNode[],
    pendingChart: null as { title: string; replay: boolean } | null,
    glance: null as { id: string; until: number } | null,
  }
  function maybeChart() {
    // charts wait for the queue to drain so a plate never misses its own
    // in-flight commits
    if (!live.pendingChart || live.pumping || live.queue.length) return
    const { title, replay } = live.pendingChart
    live.pendingChart = null
    const pts = live.sinceChart.slice()
    live.sinceChart = []
    if (pts.length >= 2) liveChart(pts, title, replay)
  }
  function liveChart(pts: BNode[], title: string, instant: boolean) {
    // the quiet ceremony: survey lines draw at rest tone, the cartouche names
    // the thought "plate N · <prompt excerpt>" — no camera theatrics
    plate++
    const con: Constellation = {
      pts,
      title: title || "thought",
      plate: ROMAN[(plate - 1) % ROMAN.length],
      progress: instant || reduceMotion ? 1 : 0,
      alpha: 1,
      born: clock.beat,
    }
    atlas.push(con)
    for (const n of pts) {
      n.atlasKeep = true
      n.labelA = Math.max(n.labelA, 0.7)
    }
    if (con.progress >= 1) return
    for (const n of pts) n.consider = Math.max(n.consider, 0.4) // collective acknowledgment
    const t0 = clock.beat
    const dur = Math.min(pts.length * 0.3, 3)
    const tickChart = () => {
      con.progress = Math.min((clock.beat - t0) / dur, 1)
      if (con.progress < 1) at(0.06, tickChart)
    }
    tickChart()
  }
  function spreadActivation(n: BNode) {
    // activation ripples: a real touch charges its skeleton neighbors — most
    // leak back to dark, some flash a sub-threshold scout. One event reads as
    // tissue responding, not a lone blip.
    if (reduceMotion) return
    let fired = 0
    for (const rec of adj.get(n.id) || []) {
      if (fired >= 4) break
      if (Math.random() < 0.45) continue
      const nb = byId.get(rec.to)
      if (!nb || nb.id === live.cur) continue
      nb.consider = Math.max(nb.consider, 0.45 + Math.random() * 0.35)
      if (Math.random() < 0.7) firePulse(rec.e, n, "scout", 0.4 + Math.random() * 0.4, null)
      fired++
    }
  }
  function findLiveNode(label: string): BNode | undefined {
    const norm = label.toLowerCase().replace(/\.(md|jl|json|toml)$/, "")
    const id = "live-" + norm.replace(/[^a-z0-9]+/g, "-").slice(0, 48)
    return byId.get(norm) || byId.get(id) || nodes.find((x) => x.label.toLowerCase() === norm)
  }
  // marathon sessions: every unique file AND every unique search pattern
  // grafts a node + edge, and the render loop is O(nodes+edges) per frame.
  // The iframe used to reset this on every theme-flip reload; the native
  // engine persists, so cap the graft population — evict the oldest graft
  // that is not charted, not pending a plate, and not where amico stands.
  const GRAFT_CAP = 300
  function evictGraft() {
    let count = 0
    let oldest: BNode | null = null
    for (const n of nodes) {
      if (!n.id.startsWith("live-")) continue
      count++
      if (n.atlasKeep || n.id === live.cur || live.sinceChart.includes(n) || live.queue.includes(n)) continue
      if (!oldest || n.touchedAt < oldest.touchedAt) oldest = n
    }
    if (count < GRAFT_CAP || !oldest) return
    const dead = oldest
    byId.delete(dead.id)
    nodes.splice(nodes.indexOf(dead), 1)
    for (let i = edges.length - 1; i >= 0; i--) {
      const e = edges[i]
      if (e.s !== dead && e.t !== dead) continue
      edges.splice(i, 1)
      edgeSeen.delete(e.s.id < e.t.id ? e.s.id + "|" + e.t.id : e.t.id + "|" + e.s.id)
    }
    adj.delete(dead.id)
    for (const [k, list] of adj) {
      const filtered = list.filter((r) => r.to !== dead.id)
      if (filtered.length !== list.length) adj.set(k, filtered)
    }
    // an in-flight pulse may still reference the orphan; its arrival mutates
    // a detached object and every lookup path tolerates the missing id
  }
  function liveNode(label: string, type?: string): BNode {
    const norm = label.toLowerCase().replace(/\.(md|jl|json|toml)$/, "")
    const id = "live-" + norm.replace(/[^a-z0-9]+/g, "-").slice(0, 48)
    const found = findLiveNode(label)
    if (found) return found
    evictGraft()
    const src = byId.get(live.cur) || byId.get("amico")!
    const n = addNode({ id, label: label.slice(0, 28), type: type || "resource" })
    n.half = 4
    const a = Math.random() * Math.PI * 2,
      r = 0.07 + Math.random() * 0.05
    n.x = src.x + Math.cos(a) * r
    n.y = src.y + Math.sin(a) * r
    addEdge(src.id, n.id, "thought")
    return n
  }
  function liveTouch(msg: BrainTouchEvent) {
    const label = String(msg.label || "").trim()
    if (!label) return
    if (msg.replay) {
      // a prior turn's step: restore it to the atlas instantly and quietly —
      // the session's whole thought-path persists across turns
      const n = liveNode(label, msg.type)
      if (!msg.consider) {
        let path = bfs(live.cur, n.id, 4)
        if (!path) {
          addEdge(live.cur, n.id, "thought")
          path = [live.cur, n.id]
        }
        for (let i = 0; i + 1 < path.length; i++) {
          const rec = (adj.get(path[i]) || []).find((a) => a.to === path[i + 1])
          if (rec) potentiate(rec.e)
        }
        if (!n.claimed) {
          claim(n)
          n.flash = 0.25 // an ember of a past firing, not a live one
        } else n.uses++
        if (!live.sinceChart.includes(n)) live.sinceChart.push(n)
        live.cur = n.id
      } else n.consider = Math.max(n.consider, 0.3)
      return
    }
    const key = label + (msg.consider ? "?" : "!")
    if ((live.recent.get(key) ?? -9) > clock.beat - 2) return // debounce repeats
    live.recent.set(key, clock.beat)
    // marathon sessions: entries past the debounce window are dead weight
    if (live.recent.size > 512) {
      for (const [k, t] of live.recent) if (t <= clock.beat - 2) live.recent.delete(k)
    }
    const n = liveNode(label, msg.type)
    if (msg.consider) {
      n.consider = 1 // the flash itself is a fade — fine under reduced motion
      const rec = (adj.get(live.cur) || []).find((a) => a.to === n.id)
      if (rec && !reduceMotion) firePulse(rec.e, byId.get(live.cur)!, "scout", 0.5, null)
      return
    }
    live.queue.push(n)
    livePump()
  }
  function livePump() {
    if (live.pumping) return
    const n = live.queue.shift()
    if (!n) return
    live.pumping = true
    let path = bfs(live.cur, n.id, 4)
    if (path && path.length === 1) {
      // re-touching where we already are: make the repeat visible — a pulse
      // from the core out to the node (amico consulting it again)
      path = bfs("amico", n.id, 4)
    }
    if (!path) {
      addEdge(live.cur, n.id, "thought")
      path = [live.cur, n.id]
    }
    if (reduceMotion) {
      // no traveling pulses — the path still potentiates, fades only
      for (let i = 0; i + 1 < path.length; i++) {
        const rec = (adj.get(path[i]) || []).find((a) => a.to === path[i + 1])
        if (rec) potentiate(rec.e)
      }
      if (n.refractUntil > clock.beat && n.claimed) {
        n.ringT = clock.beat
        n.uses++
      } else claim(n)
      if (!live.sinceChart.includes(n)) live.sinceChart.push(n)
      live.cur = n.id
      live.pumping = false
      at(0.25, () => {
        livePump()
        maybeChart()
      })
      return
    }
    const done = () => {
      if (n.refractUntil > clock.beat && n.claimed) {
        n.ringT = clock.beat
        n.uses++
      } else claim(n)
      if (!live.sinceChart.includes(n)) live.sinceChart.push(n)
      spreadActivation(n)
      live.cur = n.id
      live.pumping = false
      at(0.25, () => {
        livePump()
        maybeChart()
      })
    }
    const hop = (i: number) => {
      if (i + 1 >= path.length) return done()
      const rec = (adj.get(path[i]) || []).find((a) => a.to === path[i + 1])
      if (!rec) return done()
      firePulse(rec.e, byId.get(path[i])!, "commit", rec.e.myelin ? 0.5 : 1, () => {
        potentiate(rec.e)
        if (i + 2 >= path.length) done()
        else {
          conduct(byId.get(path[i + 1])!)
          hop(i + 1)
        }
      })
    }
    hop(0)
  }

  /* ---------- ambient: tacet, not silence ---------- */
  let nextTwinkle = 2,
    nextGhost = 8
  function ambient() {
    if (reduceMotion) return
    if (clock.beat > nextTwinkle) {
      nextTwinkle = clock.beat + 1.5 + Math.random() * 2.5
      const n = nodes[(Math.random() * nodes.length) | 0]
      n.consider = Math.max(n.consider, 0.3) // scintillation
    }
    if (clock.beat > nextGhost) {
      nextGhost = clock.beat + 4 + Math.random() * 4
      const e = edges[(Math.random() * edges.length) | 0]
      if (!e.ghost) firePulse(e, e.s, "ghost", 1.5, null)
    }
  }

  /* ---------- render ---------- */
  let halted = false
  let destroyed = false
  let rafId = 0
  let unfurl = reduceMotion ? 1 : 0
  function tick(nowMs: number) {
    if (halted || !ctx) return
    if (!Number.isFinite(nowMs)) return // a NaN timestamp would poison clock.beat permanently
    try {
      drawFrame(nowMs)
    } catch (err) {
      // a corrupt frame must not spin the rAF chain half-rendered forever —
      // halt visibly (resume() re-arms after e.g. a session switch)
      halted = true
      console.error("[amico-brain] halted on render error:", err)
      return
    }
    // re-check halted: a dueQueue callback may have paused us mid-frame — and
    // track the id so pause() can cancel an already-scheduled frame (otherwise
    // pause→resume inside one frame breeds parallel rAF chains)
    if (!halted && animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)
  }
  function drawFrame(nowMs: number) {
    if (!ctx) return
    const dt = Math.min(nowMs - (clock.lastMs || nowMs), 50)
    clock.lastMs = nowMs
    clock.beat += (dt / 60000) * bpmNow()
    runDue()
    ambient()
    if (unfurl < 1) unfurl = Math.min(unfurl + dt / 1400, 1)
    const uf = 1 - Math.pow(1 - unfurl, 3)

    // camera
    if (H < 120) {
      // condensed = a CLOSE-UP on where amico is (never a miniature map);
      // glances steer the eye since most nodes live outside this window
      const glanced = live.glance && live.glance.until > clock.beat ? byId.get(live.glance.id) : null
      const cur = glanced || byId.get(live.cur)
      if (cur) {
        cam.tx = cur.x * worldScale
        cam.ty = cur.y * worldScale
        cam.tk = Math.min(8, Math.max(1.05, 320 / worldScale))
      }
    } else {
      // expanded = the WHOLE network with the AMICO CORE dead center (the
      // core is the world origin); zoom fits the farthest node from it so
      // nothing clips. Recomputed per frame so grafts never fall outside.
      let hw = 0.01,
        hh = 0.01
      for (const n of nodes) {
        const ax = Math.abs(n.x),
          ay = Math.abs(n.y)
        if (ax > hw) hw = ax
        if (ay > hh) hh = ay
      }
      cam.tx = 0
      cam.ty = 0
      cam.tk = Math.min((W - 28) / (2 * hw * worldScale), (H - 14) / (2 * hh * worldScale))
    }
    // a hover glance deserves a brisk look, not a two-second pan
    const camEase = live.glance && live.glance.until > clock.beat ? 0.14 : 0.035
    cam.x += (cam.tx - cam.x) * camEase
    cam.y += (cam.ty - cam.y) * camEase
    cam.k += (cam.tk - cam.k) * camEase

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H) // transparent ground — the host surface shows through

    const breathe = reduceMotion ? 0 : Math.sin(nowMs / 4800) * 0.04 // 0.1 Hz field respiration

    // ---- charted constellations (the atlas — survey lines at rest tone)
    for (const con of atlas) {
      const total = con.pts.length - 1
      const upto = con.progress * total
      ctx.lineWidth = 1
      for (let i = 0; i < total; i++) {
        const a = con.pts[i],
          b = con.pts[i + 1]
        const segT = Math.max(Math.min(upto - i, 1), 0)
        if (segT <= 0) break
        ctx.strokeStyle = rgba(css.fg, 0.16 * con.alpha)
        ctx.beginPath()
        ctx.moveTo(nx(a), ny(a))
        ctx.lineTo(nx(a) + (nx(b) - nx(a)) * segT, ny(a) + (ny(b) - ny(a)) * segT)
        ctx.stroke()
      }
    }

    // ---- edges
    for (const e of edges) {
      const x1 = nx(e.s),
        y1 = ny(e.s),
        x2 = nx(e.t),
        y2 = ny(e.t)
      if ((x1 < -40 && x2 < -40) || (x1 > W + 40 && x2 > W + 40) || (y1 < -40 && y2 < -40) || (y1 > H + 40 && y2 > H + 40))
        continue
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      let width = 1
      if (e.ember > 0) {
        if (e.passes >= 3) width = 2
        ctx.strokeStyle = rgba(css.ember, e.ember * (0.55 + breathe))
      } else {
        // skeleton: the embed shows ALL possible pathways clearly, not as a
        // whisper — ghosts too, just dimmer
        ctx.strokeStyle = rgba(css.fg, 0.2)
        if (e.ghost) ctx.globalAlpha = 0.55
      }
      ctx.lineWidth = width
      if (e.ghost) ctx.setLineDash([3, 4])
      else if (e.myelin) ctx.setLineDash([7, 2]) // segmented sheath: nodes of Ranvier
      ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
    }

    // ---- pulses (trails are the last six 32nd positions)
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]
      const tN = (clock.beat - p.t0) / p.dur
      if (tN >= 1) {
        pulses.splice(i, 1)
        if (p.onArrive) p.onArrive()
        continue
      }
      const pos = pulsePos(p, Math.max(tN, 0))
      const dim = p.kind === "scout" ? 0.5 : p.kind === "ghost" ? 0.14 : 1
      const size = p.kind === "replay" ? 5 : p.kind === "scout" ? 3 : 4
      // trail: sample on the 32nd grid
      if (p.lastSample < 0 || clock.beat - p.lastSample >= 0.125) {
        p.lastSample = clock.beat
        p.trail.unshift({ x: pos.x, y: pos.y })
        if (p.trail.length > 6) p.trail.pop()
      }
      p.trail.forEach((tp, k) => {
        const a = dim * 0.4 * (1 - k / 6)
        const s = size * (1 - k / 8)
        ctx.fillStyle = rgba(css.thought, a)
        ctx.beginPath()
        ctx.arc(tp.x, tp.y, s / 2, 0, Math.PI * 2)
        ctx.fill()
      })
      if (p.kind !== "ghost" && bloom) {
        ctx.globalAlpha = 0.5 * dim
        ctx.drawImage(bloom, pos.x - 16, pos.y - 16, 32, 32)
        ctx.globalAlpha = 1
      }
      ctx.fillStyle = rgba(css.thought, Math.min(dim + 0.15, 1))
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, size / 2, 0, Math.PI * 2)
      ctx.fill()
    }

    // ---- nodes: the embed is monochrome + brand yellow — every claimed node
    // wears the thought color (the categorical palette belonged to the
    // standalone demo, where a legend explained it)
    ctx.textBaseline = "middle"
    for (const n of nodes) {
      const x = nx(n),
        y = ny(n)
      if (x < -60 || x > W + 60 || y < -60 || y > H + 60) continue
      const catColor = css.thought
      let half = n.half * (0.6 + 0.4 * uf) * (n.uses > 1 ? 1 + Math.min(n.uses, 4) * 0.08 : 1)
      if (n.flash > 0) {
        half *= 1 + n.flash * 0.35
        n.flash = Math.max(n.flash - dt / 420, 0)
      }
      if (n.consider > 0) n.consider = Math.max(n.consider - dt / 2600, 0)
      const isCore = n.type === "core"
      const coreBr = isCore && !reduceMotion ? (Math.sin(nowMs / 2500 + 1) * 0.5 + 0.5) * 0.35 : 0

      // glow budget: flash only
      if (n.flash > 0.02 && bloom) {
        ctx.globalAlpha = n.flash
        ctx.drawImage(bloom, x - half * 4, y - half * 4, half * 8, half * 8)
        ctx.globalAlpha = 1
      }

      ctx.beginPath()
      ctx.arc(x, y, half, 0, Math.PI * 2)

      if (n.flash > 0.55) {
        ctx.fillStyle = css.thought // all-or-nothing: the attack is pure accent
        ctx.fill()
      } else if (n.claimed) {
        const sustain = n.atlasKeep ? 0.55 : 0.85
        ctx.fillStyle = rgba(catColor, sustain * (n.flash > 0 ? 1 : 0.9) + coreBr)
        ctx.fill()
        ctx.strokeStyle = rgba(catColor, 0.9)
        ctx.lineWidth = 1
        ctx.stroke()
      } else {
        // untraversed tissue recedes — the traversed path owns the contrast;
        // anything live (considered, the core) stays bright
        const chargeGlow = Math.max(n.consider, isCore ? 0.5 + coreBr : 0)
        const restDim = chargeGlow <= 0.05 ? 0.42 : 1
        ctx.globalAlpha = restDim
        ctx.fillStyle = css.nodeFill
        ctx.fill()
        ctx.strokeStyle = chargeGlow > 0 ? rgba(css.thought, 0.25 + chargeGlow * 0.6) : css.nodeBorder
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.globalAlpha = 1
      }
      if (n.cat === "agents") {
        // agents wear a double border — same circle, framed
        ctx.beginPath()
        ctx.arc(x, y, half + 2.5, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(catColor, n.claimed ? 0.8 : 0.16)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      // survey ring: an expanding circle, emitted on fire
      if (n.ringT >= 0) {
        const rt = (clock.beat - n.ringT) / 0.7
        if (rt < 1) {
          const rh = half + rt * half * 2.6
          ctx.beginPath()
          ctx.arc(x, y, rh, 0, Math.PI * 2)
          ctx.strokeStyle = rgba(css.thought, (1 - rt) * 0.8)
          ctx.lineWidth = 1
          ctx.stroke()
        } else n.ringT = -1
      }
      // labels: LOD — touched or considered; halo for legibility
      let la = n.labelA
      if (n.consider > 0.4) la = Math.max(la, 0.5)
      if (n.labelA > 0 && !n.atlasKeep) n.labelA = Math.max(n.labelA - dt / 9000, 0)
      if (n.atlasKeep) n.labelA = Math.max(n.labelA - dt / 12000, 0.5)
      if (la > 0.03) {
        ctx.font = "10px JuliaMono, ui-monospace, SFMono-Regular, Menlo, monospace"
        const tw = ctx.measureText(n.label).width
        const lx = x + half + 6,
          ly = y
        ctx.fillStyle = css.labelHalo
        ctx.fillRect(lx - 2, ly - 7, tw + 4, 14)
        ctx.fillStyle = rgba(css.fg, Math.min(la, 1) * (n.atlasKeep ? 0.8 : 0.65))
        ctx.fillText(n.label, lx, ly)
      }
    }

    // where-we-are cursor: an always-visible ring on the current node — the
    // flare fades and glows are faint on the light surface, so position gets
    // its own explicit marker in the thought color (legible in both themes)
    const curNode = byId.get(live.cur)
    if (curNode) {
      const cxp = nx(curNode),
        cyp = ny(curNode)
      const rr = curNode.half + 5 + (reduceMotion ? 0 : Math.sin(nowMs / 600) * 1.5)
      ctx.beginPath()
      ctx.arc(cxp, cyp, rr, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(css.thought, 0.85)
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cxp, cyp, rr + 3.5, 0, Math.PI * 2)
      ctx.strokeStyle = rgba(css.thought, 0.3)
      ctx.lineWidth = 1
      ctx.stroke()
      curNode.labelA = 1 // the name of where we are stays readable
    }
  }

  // waking — the thought begins here
  const core = byId.get("amico")!
  core.flash = 1
  core.ringT = clock.beat
  if (animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)

  return {
    touch: (ev) => {
      if (!destroyed) liveTouch(ev)
    },
    chart: (title, replay) => {
      if (destroyed) return
      live.pendingChart = { title: String(title || ""), replay: !!replay }
      maybeChart()
    },
    highlight: (label) => {
      if (destroyed) return
      // a glance from the log: ring the node AND turn the camera to look at
      // it — in the collapsed close-up most nodes are outside the window, so
      // an unsteered ring is invisible
      const n = findLiveNode(String(label || ""))
      if (n) {
        n.ringT = clock.beat
        n.consider = Math.max(n.consider, 0.9)
        n.labelA = 1
        live.glance = { id: n.id, until: clock.beat + 3.5 }
      }
    },
    setTheme: (next) => {
      if (next !== "dark" && next !== "light") return
      scheme = next
      css = PALETTES[scheme]
      buildSprites() // the atlas, claims, and clock all persist — only ink changes
    },
    resize: (width, height) => resize(width, height),
    tick,
    pause: () => {
      halted = true // folded away — stop burning frames
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(rafId)
    },
    resume: () => {
      if (destroyed || !halted) return
      halted = false
      clock.lastMs = 0 // dt is capped, so the gap doesn't lurch the clock
      if (animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)
    },
    destroy: () => {
      destroyed = true
      halted = true
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(rafId)
      ro?.disconnect()
      motionQuery?.removeEventListener("change", onMotionChange)
      dprQuery?.removeEventListener("change", onDprChange)
    },
    stats: () => ({
      scheme,
      nodes: nodes.length,
      edges: edges.length,
      claimed: nodes.filter((n) => n.claimed).length,
      atlas: atlas.length,
      queued: live.queue.length,
      cur: live.cur,
    }),
  }
}

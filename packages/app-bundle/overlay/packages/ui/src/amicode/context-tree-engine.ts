/* ================================================================
   the context tree — what amico is holding in mind (native engine)

   The knowledge graph, moved to the header panel and redesigned around
   the session instead of the vault sample — laid out as an ORGANIC,
   Obsidian-like graph (Kate 2026-07-27): root = amico pinned at center,
   the session's turns orbiting it, and each turn's context — markdown,
   source, skills, agents, web references — clustering around its turn
   under a deterministic force settle. A leaf touched again by a later
   turn is not duplicated — the later turn draws a recall link back to
   it, and the springs pull shared context between its turns, so the
   cloud's SHAPE shows what the session keeps returning to.

   Unlike the ambient brain (brain-engine.ts), this surface is
   INTERACTIVE: nodes hit-test, hover raises their label, and clicking a
   file node hands its path to the host (onSelect) to open the real
   markdown/source. Camera: auto-fit until the user pans/zooms; wheel
   zooms about the cursor, drag pans, double-click refits.

   Shared laws with the brain: circles only; #FFE614 belongs to the live
   position alone; both palettes carried in-module so a theme flip is a
   repaint, never a reload; DPR re-checked when the device-pixel-ratio
   itself changes (webview zoom), not only on box resize.
   ================================================================ */

export type ContextTreeScheme = "dark" | "light"

export type ContextTreeKind =
  | "root"
  | "turn"
  | "note" // markdown / prose
  | "source" // code
  | "skill"
  | "agent"
  | "web"
  | "action" // solves, bash verbs
  | "resource"

export type ContextTreeNodeInput = {
  id: string
  label: string
  kind: ContextTreeKind
  /** full or repo-relative file path — presence makes the node openable */
  path?: string
  /** the file lives in a vault mount (open via the Vault panel, not a tab) */
  vault?: boolean
  /** the vault refuses browsing (proprietary data/software) — the node renders
   *  dimmed with a padlock and is NOT openable, path or not */
  locked?: boolean
  /** where the agent currently works — wears the thought-color cursor */
  active?: boolean
  children?: ContextTreeNodeInput[]
  /** ids of earlier nodes this node re-touched — drawn as recall links */
  recalls?: string[]
}

export type ContextTreeSelection = {
  id: string
  label: string
  kind: ContextTreeKind
  path?: string
  vault?: boolean
  locked?: boolean
}

export interface ContextTreeEngineOptions {
  scheme?: ContextTreeScheme
  /** override prefers-reduced-motion (tests) */
  reduceMotion?: boolean
  /** drive the render loop via requestAnimationFrame (default true; tests call tick()) */
  animate?: boolean
  /** layout fallback when the canvas has no measured size yet */
  size?: { width: number; height: number }
  onSelect?: (node: ContextTreeSelection) => void
  onHover?: (node: ContextTreeSelection | null) => void
}

export interface ContextTreeStats {
  scheme: ContextTreeScheme
  nodes: number
  edges: number
  recalls: number
  depth: number
}

export interface ContextTreeEngine {
  /** declaratively replace the tree; known ids keep their motion state */
  setTree(root: ContextTreeNodeInput): void
  /** lossless palette swap + repaint */
  setTheme(scheme: ContextTreeScheme): void
  /** a glance from the log: ring the node whose label matches */
  highlight(label: string): void
  /** keyboard focus: ring + camera-glance a node by ID (host-driven nav) */
  focus(id: string): void
  /** re-fit the camera to the whole tree (also clears manual pan/zoom) */
  fit(): void
  /** omit both to re-measure from the canvas box */
  resize(width?: number, height?: number): void
  tick(nowMs: number): void
  pause(): void
  resume(): void
  destroy(): void
  /** screen-space hit test (CSS px) — the id under the point, if any */
  pick(x: number, y: number): string | undefined
  /** screen-space position of a node (CSS px) — tests + host tooltips */
  locate(id: string): { x: number; y: number } | undefined
  stats(): ContextTreeStats
}

/* ---------- tokens: both palettes in-module (same idiom as brain-engine) ---------- */
type Palette = {
  fg: string
  edge: string
  recall: string
  nodeFill: string
  nodeBorder: string
  thought: string
  labelHalo: string
  kind: Record<string, string>
}
const PALETTES: Record<ContextTreeScheme, Palette> = {
  dark: {
    fg: "#d6d6d2",
    edge: "rgba(255, 255, 255, 0.16)",
    recall: "rgba(255, 255, 255, 0.10)",
    nodeFill: "#242423",
    nodeBorder: "rgba(255, 255, 255, 0.24)",
    thought: "#FFE614",
    labelHalo: "rgba(19, 19, 18, 0.72)",
    kind: {
      root: "#FFE614",
      turn: "#d6d6d2",
      note: "#3794ff",
      source: "#4d9e51",
      skill: "#9b6bc4",
      agent: "#c9c9c4",
      web: "#c17800",
      action: "#c17800",
      resource: "#8a8a86",
    },
  },
  light: {
    fg: "#22221f",
    edge: "rgba(0, 0, 0, 0.18)",
    recall: "rgba(0, 0, 0, 0.10)",
    nodeFill: "#eae7dd",
    nodeBorder: "rgba(0, 0, 0, 0.26)",
    thought: "#8f8000",
    labelHalo: "rgba(250, 249, 246, 0.78)",
    kind: {
      root: "#8f8000",
      turn: "#22221f",
      note: "#1866c9",
      source: "#33753a",
      skill: "#7b4fa8",
      agent: "#4a4a44",
      web: "#8f5800",
      action: "#8f5800",
      resource: "#77776f",
    },
  },
}

/** The kind→color mapping, for host chrome (the panel legend) — single source
 *  with the render palette so the dots can never drift from the canvas. */
export function contextTreeKindColor(scheme: ContextTreeScheme, kind: ContextTreeKind): string {
  return PALETTES[scheme].kind[kind] ?? PALETTES[scheme].fg
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "")
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgba(color: string, a: number): string {
  if (color.startsWith("rgba") || color.startsWith("rgb")) return color
  const [r, g, b] = hexToRgb(color)
  return `rgba(${r},${g},${b},${a})`
}

/* ---------- internal shapes ---------- */
interface TNode {
  id: string
  label: string
  kind: ContextTreeKind
  path?: string
  vault?: boolean
  locked?: boolean
  active: boolean
  depth: number
  // world targets (tidy layout) and animated positions
  tx: number
  ty: number
  x: number
  y: number
  alpha: number
  flash: number
  ringT: number
  half: number
  parent?: TNode
}
interface TEdge {
  s: TNode
  t: TNode
  recall: boolean
}

const TURN_RING = 150 // base rest distance root -> turn (grows with turn count)
const LEAF_REST = 70 // rest distance turn -> leaf
const RECALL_REST = 200 // weak spring across recall links
const SETTLE_STEPS = 240
const HALF: Record<string, number> = { root: 8, turn: 5.5, agent: 5 }
// deterministic jitter — no Math.random (identical trees settle identically)
const jitter = (i: number) => Math.sin(i * 12.9898) * 0.5

export function createContextTreeEngine(
  canvas: HTMLCanvasElement,
  opts: ContextTreeEngineOptions = {},
): ContextTreeEngine {
  let scheme: ContextTreeScheme = opts.scheme === "light" ? "light" : "dark"
  let css: Palette = PALETTES[scheme]
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

  let nodes: TNode[] = []
  let byId = new Map<string, TNode>()
  let edges: TEdge[] = []
  let recallCount = 0
  let maxDepth = 0

  /* ---------- canvas, DPR, camera ---------- */
  let W = 0,
    H = 0,
    DPR = 1
  function resize(width?: number, height?: number) {
    DPR = Math.min((typeof devicePixelRatio !== "undefined" ? devicePixelRatio : 1) || 1, 2)
    W = width ?? canvas.clientWidth ?? 0
    H = height ?? canvas.clientHeight ?? 0
    if (!Number.isFinite(W) || !Number.isFinite(H) || W < 1 || H < 1) {
      W = opts.size?.width ?? 800
      H = opts.size?.height ?? 208
    }
    canvas.width = W * DPR
    canvas.height = H * DPR
  }
  resize()
  let ro: ResizeObserver | null = null
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => resize())
    ro.observe(canvas)
  }
  // webview/app zoom changes devicePixelRatio WITHOUT changing the CSS box —
  // ResizeObserver stays silent and the backing store goes stale (blurry).
  // Watch the dppx itself and re-arm after every change.
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

  // fit-derived camera with manual override; k is world→screen scale
  const cam = { x: 0, y: 0, k: 1, tx: 0, ty: 0, tk: 1 }
  let userCam = false
  function fitTarget() {
    if (!nodes.length) return
    let minX = 1e9,
      maxX = -1e9,
      minY = 1e9,
      maxY = -1e9
    for (const n of nodes) {
      minX = Math.min(minX, n.tx)
      maxX = Math.max(maxX, n.tx)
      minY = Math.min(minY, n.ty)
      maxY = Math.max(maxY, n.ty)
    }
    const padX = 56, // room for centered labels at the cloud's edges
      padY = 32
    const spanX = Math.max(maxX - minX, 1)
    const spanY = Math.max(maxY - minY, 1)
    cam.tk = Math.min((W - padX * 2) / spanX, (H - padY * 2) / spanY, 1.6)
    cam.tk = Math.max(cam.tk, 0.04)
    cam.tx = (minX + maxX) / 2
    cam.ty = (minY + maxY) / 2
  }
  const sx = (wx: number) => (wx - cam.x) * cam.k + W / 2
  const sy = (wy: number) => (wy - cam.y) * cam.k + H / 2

  /* ---------- organic layout: deterministic force settle ----------
     Root pinned at center, turns seeded on a ring in session order, leaves
     fanned outward from their turn — then a fixed number of repel+spring
     iterations (no randomness, so the same tree always settles the same
     way). The settle runs synchronously here; the render loop only LERPS
     nodes toward their new equilibrium, which is what gives the cloud its
     Obsidian-like drift when context arrives. */
  function layout(root: ContextTreeNodeInput) {
    const nextNodes: TNode[] = []
    const nextById = new Map<string, TNode>()
    const nextEdges: TEdge[] = []
    const recallPairs: [string, string][] = []
    maxDepth = 0
    const visit = (input: ContextTreeNodeInput, depth: number, parent?: TNode): TNode => {
      maxDepth = Math.max(maxDepth, depth)
      const prior = byId.get(input.id)
      const n: TNode = prior ?? {
        id: input.id,
        label: input.label,
        kind: input.kind,
        active: false,
        depth,
        tx: 0,
        ty: 0,
        // newborns condense out of their parent's position, not (0,0)
        x: parent ? parent.x : 0,
        y: parent ? parent.y : 0,
        alpha: 0,
        flash: reduceMotion ? 0 : 1,
        ringT: -1,
        half: 4,
      }
      n.label = input.label
      n.kind = input.kind
      n.path = input.path
      n.vault = input.vault
      n.locked = input.locked
      n.active = !!input.active
      n.depth = depth
      n.half = HALF[input.kind] ?? 4
      n.parent = parent
      nextNodes.push(n)
      nextById.set(n.id, n)
      for (const c of input.children ?? []) {
        const cn = visit(c, depth + 1, n)
        nextEdges.push({ s: n, t: cn, recall: false })
      }
      for (const r of input.recalls ?? []) recallPairs.push([input.id, r])
      return n
    }
    const rootNode = visit(root, 0, undefined)
    recallCount = 0
    for (const [from, to] of recallPairs) {
      const s = nextById.get(from)
      const t = nextById.get(to)
      if (!s || !t || s === t) continue
      nextEdges.push({ s, t, recall: true })
      recallCount++
    }

    // --- seed (deterministic): root center; turns on the ring; leaves fanned
    const turns = nextNodes.filter((n) => n.depth === 1)
    // busy sessions need a wider orbit or the clusters shove each other apart
    const ring = Math.min(TURN_RING + turns.length * 12, 320)
    rootNode.tx = 0
    rootNode.ty = 0
    turns.forEach((t, i) => {
      const ang = -Math.PI / 2 + (i * Math.PI * 2) / Math.max(turns.length, 3)
      t.tx = Math.cos(ang) * ring
      t.ty = Math.sin(ang) * ring
      const leaves = nextNodes.filter((n) => n.parent === t)
      leaves.forEach((l, j) => {
        const spread = Math.min(Math.PI * 0.9, 0.5 * Math.max(leaves.length - 1, 1))
        const la = ang - spread / 2 + (leaves.length > 1 ? (j * spread) / (leaves.length - 1) : 0)
        l.tx = t.tx + Math.cos(la) * (LEAF_REST + jitter(i * 31 + j) * 14)
        l.ty = t.ty + Math.sin(la) * (LEAF_REST + jitter(i * 17 + j * 3) * 14)
      })
    })

    // --- settle: pairwise repulsion + edge springs + weak center gravity
    const index = new Map<TNode, number>()
    nextNodes.forEach((n, i) => index.set(n, i))
    for (let it = 0; it < SETTLE_STEPS; it++) {
      const fx = new Array<number>(nextNodes.length).fill(0)
      const fy = new Array<number>(nextNodes.length).fill(0)
      for (let a = 0; a < nextNodes.length; a++) {
        for (let b = a + 1; b < nextNodes.length; b++) {
          const A = nextNodes[a]
          const B = nextNodes[b]
          let dx = A.tx - B.tx
          let dy = A.ty - B.ty
          let d2 = dx * dx + dy * dy
          if (d2 < 1) {
            d2 = 1
            dx = jitter(a * 7 + b) || 0.5
            dy = jitter(a - b * 3) || -0.5
          }
          const f = Math.min(1400 / d2, 6)
          const d = Math.sqrt(d2)
          fx[a] += (dx / d) * f
          fy[a] += (dy / d) * f
          fx[b] -= (dx / d) * f
          fy[b] -= (dy / d) * f
        }
      }
      for (const e of nextEdges) {
        const ai = index.get(e.s)!
        const bi = index.get(e.t)!
        const dx = e.t.tx - e.s.tx
        const dy = e.t.ty - e.s.ty
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 0.01)
        const rest = e.recall ? RECALL_REST : e.s.depth === 0 ? ring : LEAF_REST
        const k = e.recall ? 0.004 : 0.02
        const f = (d - rest) * k
        fx[ai] += (dx / d) * f
        fy[ai] += (dy / d) * f
        fx[bi] -= (dx / d) * f
        fy[bi] -= (dy / d) * f
      }
      for (let i = 0; i < nextNodes.length; i++) {
        const n = nextNodes[i]
        if (n.depth === 0) continue // the root IS the world origin
        fx[i] += -n.tx * 0.004
        fy[i] += -n.ty * 0.004
        n.tx += Math.max(-7, Math.min(7, fx[i]))
        n.ty += Math.max(-7, Math.min(7, fy[i]))
      }
    }

    nodes = nextNodes
    byId = nextById
    edges = nextEdges
    if (reduceMotion)
      for (const n of nodes) {
        n.x = n.tx
        n.y = n.ty
        n.alpha = 1
      }
    if (!userCam) fitTarget()
  }

  /* ---------- interaction ---------- */
  let hovered: TNode | null = null
  function pick(px: number, py: number): string | undefined {
    // topmost-last: later nodes (deeper/younger) win overlapping hits
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      const dx = px - sx(n.x)
      const dy = py - sy(n.y)
      const r = Math.max(n.half * cam.k, 5) + 4
      if (dx * dx + dy * dy <= r * r) return n.id
    }
    return undefined
  }
  const selection = (n: TNode): ContextTreeSelection => ({
    id: n.id,
    label: n.label,
    kind: n.kind,
    path: n.path,
    vault: n.vault,
    locked: n.locked,
  })
  // openable = the click actually goes somewhere; everything else (turns,
  // skills, agents, actions, locked vault files) must not wear the pointer
  const openable = (n: TNode) => !!n.path && !n.locked
  let dragging = false
  let dragMoved = false
  let lastPX = 0,
    lastPY = 0
  const local = (e: MouseEvent) => {
    const rect = typeof canvas.getBoundingClientRect === "function" ? canvas.getBoundingClientRect() : undefined
    if (!rect) return { x: e.clientX, y: e.clientY }
    // the rect is post-zoom/post-transform (CSS zoom on the root scales it)
    // while W/H are the engine's pre-zoom CSS px — normalize so hit-testing
    // stays true at any app zoom level
    const kx = rect.width > 0 && W > 0 ? rect.width / W : 1
    const ky = rect.height > 0 && H > 0 ? rect.height / H : 1
    return { x: (e.clientX - rect.left) / kx, y: (e.clientY - rect.top) / ky }
  }
  const onPointerDown = (e: PointerEvent) => {
    dragging = true
    dragMoved = false
    const p = local(e)
    lastPX = p.x
    lastPY = p.y
  }
  const onPointerMove = (e: PointerEvent) => {
    const p = local(e)
    if (dragging) {
      const dx = p.x - lastPX
      const dy = p.y - lastPY
      if (Math.abs(dx) + Math.abs(dy) > 2) dragMoved = true
      if (dragMoved) {
        userCam = true
        cam.tx -= dx / cam.k
        cam.ty -= dy / cam.k
        cam.x = cam.tx
        cam.y = cam.ty
        lastPX = p.x
        lastPY = p.y
      }
      return
    }
    const id = pick(p.x, p.y)
    const n = id ? (byId.get(id) ?? null) : null
    if (n !== hovered) {
      hovered = n
      // pointer only where a click opens something; a locked node says so
      if (canvas.style) canvas.style.cursor = n && openable(n) ? "pointer" : n?.locked ? "not-allowed" : "grab"
      opts.onHover?.(n ? selection(n) : null)
    }
  }
  const onPointerUp = (e: PointerEvent) => {
    const wasDrag = dragging && dragMoved
    dragging = false
    if (wasDrag) return
    const p = local(e)
    const id = pick(p.x, p.y)
    const n = id ? byId.get(id) : undefined
    // only openable nodes acknowledge the click — a ring on a dead-end node
    // would promise an action that never comes
    if (n && openable(n)) {
      n.ringT = beatNow
      opts.onSelect?.(selection(n))
    }
  }
  const onPointerLeave = () => {
    dragging = false
    if (hovered) {
      hovered = null
      opts.onHover?.(null)
    }
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    userCam = true
    const p = local(e)
    const factor = Math.exp(-e.deltaY * 0.0015)
    const k0 = cam.k
    const k1 = Math.min(Math.max(k0 * factor, 0.15), 4)
    // zoom about the cursor: keep the world point under it fixed
    const wx = (p.x - W / 2) / k0 + cam.x
    const wy = (p.y - H / 2) / k0 + cam.y
    cam.k = k1
    cam.tk = k1
    cam.x = wx - (p.x - W / 2) / k1
    cam.y = wy - (p.y - H / 2) / k1
    cam.tx = cam.x
    cam.ty = cam.y
  }
  const onDblClick = () => {
    userCam = false
    fitTarget()
  }
  const listeners: [string, EventListener][] = [
    ["pointerdown", onPointerDown as EventListener],
    ["pointermove", onPointerMove as EventListener],
    ["pointerup", onPointerUp as EventListener],
    ["pointerleave", onPointerLeave as EventListener],
    ["wheel", onWheel as EventListener],
    ["dblclick", onDblClick as EventListener],
  ]
  if (typeof canvas.addEventListener === "function")
    for (const [ev, fn] of listeners) canvas.addEventListener(ev, fn, ev === "wheel" ? { passive: false } : undefined)

  /* ---------- render ---------- */
  let halted = false
  let destroyed = false
  let rafId = 0
  let lastMs = 0
  let beatNow = 0 // seconds-ish clock for rings
  let glance: { id: string; until: number } | null = null

  function tick(nowMs: number) {
    if (halted || !ctx) return
    if (!Number.isFinite(nowMs)) return
    try {
      drawFrame(nowMs)
    } catch (err) {
      halted = true
      console.error("[amico-context-tree] halted on render error:", err)
      return
    }
    if (!halted && animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)
  }

  function drawFrame(nowMs: number) {
    if (!ctx) return
    const dt = Math.min(nowMs - (lastMs || nowMs), 50)
    lastMs = nowMs
    beatNow += dt / 1000

    const ease = reduceMotion ? 1 : 1 - Math.pow(0.0015, dt / 1000)
    cam.x += (cam.tx - cam.x) * ease
    cam.y += (cam.ty - cam.y) * ease
    cam.k += (cam.tk - cam.k) * ease
    for (const n of nodes) {
      n.x += (n.tx - n.x) * ease
      n.y += (n.ty - n.y) * ease
      n.alpha = Math.min(n.alpha + dt / 320, 1)
      if (n.flash > 0) n.flash = Math.max(n.flash - dt / 600, 0)
    }

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.clearRect(0, 0, W, H) // transparent ground — the panel surface shows through

    // ---- edges: straight lines (the Obsidian idiom); recall links dashed;
    // the hovered node's edges brighten so its neighborhood reads at a glance
    for (const e of edges) {
      const x1 = sx(e.s.x),
        y1 = sy(e.s.y),
        x2 = sx(e.t.x),
        y2 = sy(e.t.y)
      if ((x1 < -60 && x2 < -60) || (x1 > W + 60 && x2 > W + 60) || (y1 < -60 && y2 < -60) || (y1 > H + 60 && y2 > H + 60))
        continue
      const a = Math.min(e.s.alpha, e.t.alpha)
      if (a <= 0.02) continue
      const near = hovered !== null && (e.s === hovered || e.t === hovered)
      ctx.beginPath()
      ctx.moveTo(x1, y1)
      ctx.lineTo(x2, y2)
      if (e.recall) {
        ctx.strokeStyle = rgba(css.fg, (near ? 0.3 : 0.1) * a)
        ctx.setLineDash([3, 4])
      } else {
        ctx.strokeStyle = rgba(css.fg, (near ? 0.42 : 0.16) * a)
      }
      ctx.lineWidth = near ? 1.5 : 1
      ctx.stroke()
      ctx.setLineDash([])
    }

    // ---- nodes
    ctx.textBaseline = "middle"
    for (const n of nodes) {
      const x = sx(n.x),
        y = sy(n.y)
      if (x < -80 || x > W + 80 || y < -40 || y > H + 40) continue
      const color = css.kind[n.kind] ?? css.fg
      const isRoot = n.kind === "root"
      let half = Math.max(n.half * Math.min(cam.k, 1.4), isRoot ? 5 : 3)
      if (n.flash > 0) half *= 1 + n.flash * 0.35
      const hoveredNow = hovered === n

      ctx.globalAlpha = n.alpha
      ctx.beginPath()
      ctx.arc(x, y, half, 0, Math.PI * 2)
      if (isRoot) {
        // the root wears the thought color — the one yellow on the surface
        ctx.fillStyle = css.thought
        ctx.fill()
      } else if (n.kind === "turn") {
        ctx.fillStyle = css.nodeFill
        ctx.fill()
        ctx.strokeStyle = rgba(color, 0.85)
        ctx.lineWidth = 1
        ctx.stroke()
      } else {
        // locked (non-browsable vault) leaves read clearly non-interactive:
        // reduced emphasis, plus the padlock by the label (shape, not color)
        ctx.fillStyle = rgba(color, n.locked ? 0.3 : hoveredNow ? 0.95 : 0.75)
        ctx.fill()
        ctx.strokeStyle = rgba(color, n.locked ? 0.45 : 0.9)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      if (n.kind === "agent") {
        // agents wear the double border, same as on the brain
        ctx.beginPath()
        ctx.arc(x, y, half + 2.5, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(color, 0.5)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      // active cursor: where the agent currently works
      if (n.active) {
        const rr = half + 4 + (reduceMotion ? 0 : Math.sin(nowMs / 600) * 1.5)
        ctx.beginPath()
        ctx.arc(x, y, rr, 0, Math.PI * 2)
        ctx.strokeStyle = rgba(css.thought, 0.85)
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      // click/glance ring
      if (n.ringT >= 0) {
        const rt = (beatNow - n.ringT) / 0.7
        if (rt >= 0 && rt < 1) {
          ctx.beginPath()
          ctx.arc(x, y, half + rt * half * 2.6, 0, Math.PI * 2)
          ctx.strokeStyle = rgba(css.thought, (1 - rt) * 0.8)
          ctx.lineWidth = 1
          ctx.stroke()
        } else if (rt >= 1) n.ringT = -1
      }
      // labels: centered under the node (the Obsidian idiom); turns + root
      // always readable, leaves at rest tone — raised on hover, keyboard
      // focus, a log glance, or being the hovered node's neighbor
      const glancedNow = glance !== null && glance.id === n.id
      const nearHover = hovered !== null && (n.parent === hovered || hovered.parent === n)
      const la =
        isRoot || n.kind === "turn" ? 0.85 : hoveredNow || glancedNow || n.active ? 1 : nearHover ? 0.85 : 0.6
      ctx.font = `${n.kind === "turn" || isRoot ? "600 " : ""}10px JuliaMono, ui-monospace, SFMono-Regular, Menlo, monospace`
      const text = n.label.length > 30 ? n.label.slice(0, 29) + "…" : n.label
      const lockW = n.locked ? 10 : 0
      const tw = ctx.measureText(text).width
      const lx = x - (tw + lockW) / 2,
        ly = y + half + 10
      ctx.fillStyle = css.labelHalo
      ctx.fillRect(lx - 2, ly - 7, tw + lockW + 4, 14)
      const inkA = Math.min(la, 1) * n.alpha
      if (n.locked) {
        // padlock: shackle arc over a body — the non-color "cannot open" signal
        ctx.strokeStyle = rgba(css.fg, inkA)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(lx + 3, ly - 1.5, 2, Math.PI, 0)
        ctx.stroke()
        ctx.fillStyle = rgba(css.fg, inkA)
        ctx.fillRect(lx, ly - 1.5, 6, 5)
      }
      ctx.fillStyle = rgba(css.fg, inkA)
      ctx.fillText(text, lx + lockW, ly)
      ctx.globalAlpha = 1
    }

    // a glance from the log fades on its own clock
    if (glance && glance.until < beatNow) glance = null
  }

  if (animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)

  return {
    setTree: (root) => {
      if (!destroyed) layout(root)
    },
    setTheme: (next) => {
      if (next !== "dark" && next !== "light") return
      scheme = next
      css = PALETTES[scheme]
    },
    highlight: (label) => {
      if (destroyed) return
      const norm = String(label || "")
        .toLowerCase()
        .replace(/\.(md|jl|json|toml)$/, "")
      const n = nodes.find((x) => x.label.toLowerCase().replace(/\.(md|jl|json|toml)$/, "") === norm)
      if (n) {
        n.ringT = beatNow
        glance = { id: n.id, until: beatNow + 3 }
      }
    },
    focus: (id) => {
      if (destroyed) return
      const n = byId.get(id)
      if (!n) return
      n.ringT = beatNow
      glance = { id: n.id, until: beatNow + 3 }
    },
    fit: () => {
      userCam = false
      fitTarget()
    },
    resize: (width, height) => resize(width, height),
    tick,
    pause: () => {
      halted = true
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(rafId)
    },
    resume: () => {
      if (destroyed || !halted) return
      halted = false
      lastMs = 0
      if (animate && typeof requestAnimationFrame !== "undefined") rafId = requestAnimationFrame(tick)
    },
    destroy: () => {
      destroyed = true
      halted = true
      if (typeof cancelAnimationFrame !== "undefined") cancelAnimationFrame(rafId)
      ro?.disconnect()
      motionQuery?.removeEventListener("change", onMotionChange)
      dprQuery?.removeEventListener("change", onDprChange)
      if (typeof canvas.removeEventListener === "function")
        for (const [ev, fn] of listeners) canvas.removeEventListener(ev, fn)
    },
    pick,
    locate: (id) => {
      const n = byId.get(id)
      if (!n) return undefined
      return { x: sx(n.x), y: sy(n.y) }
    },
    stats: () => ({
      scheme,
      nodes: nodes.length,
      edges: edges.filter((e) => !e.recall).length,
      recalls: recallCount,
      depth: maxDepth,
    }),
  }
}

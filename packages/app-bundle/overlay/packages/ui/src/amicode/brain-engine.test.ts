import { describe, expect, test } from "bun:test"
import { createBrainEngine, type BrainEngineOptions } from "./brain-engine"
import { BRAIN_DATA } from "./brain-data"

/* The engine must run headless: bun test has no DOM, no rAF, no matchMedia.
   That is the point — the old /brain.html iframe could only be exercised by
   booting a server and a browser, which is why it broke three times before
   anyone saw it. A recording 2d-context stub is enough to pin the behavior. */

type Call = { method: string; args: unknown[] }
function recordingCtx() {
  const calls: Call[] = []
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args })
      if (method === "measureText") return { width: 42 }
      return undefined
    }
  const ctx: Record<string, unknown> = { calls }
  for (const m of [
    "setTransform",
    "clearRect",
    "fillRect",
    "beginPath",
    "moveTo",
    "lineTo",
    "stroke",
    "fill",
    "arc",
    "setLineDash",
    "drawImage",
    "fillText",
    "measureText",
  ])
    ctx[m] = record(m)
  return ctx as { calls: Call[] } & Record<string, unknown>
}
function stubCanvas(ctx: unknown) {
  return {
    clientWidth: 0,
    clientHeight: 0,
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement
}
function makeEngine(opts: Partial<BrainEngineOptions> = {}) {
  const ctx = recordingCtx()
  const engine = createBrainEngine(stubCanvas(ctx), {
    scheme: "dark",
    reduceMotion: true,
    animate: false,
    size: { width: 800, height: 224 },
    ...opts,
  })
  return { engine, ctx }
}

describe("boot", () => {
  test("builds the full skeleton graph headless, centered on the amico core", () => {
    const { engine } = makeEngine()
    const s = engine.stats()
    // every vault-sample node plus the core; edges include the dispatch spokes
    expect(s.nodes).toBe(BRAIN_DATA.nodes.length + 1)
    expect(s.edges).toBeGreaterThan(BRAIN_DATA.edges.length)
    expect(s.cur).toBe("amico")
    expect(s.claimed).toBe(0)
    expect(s.atlas).toBe(0)
  })

  test("wears the requested scheme from frame zero — no wrong-theme first frame", () => {
    // the iframe read its theme AFTER load (async in the VS Code webview), so
    // the first frames painted the wrong palette or opaque white; the native
    // engine takes the scheme as a constructor input
    const { engine } = makeEngine({ scheme: "light" })
    expect(engine.stats().scheme).toBe("light")
  })

  test("first frame clears to transparent, never paints an opaque ground", () => {
    const { engine, ctx } = makeEngine()
    engine.tick(16)
    engine.tick(32)
    const clears = ctx.calls.filter((c) => c.method === "clearRect")
    expect(clears.length).toBeGreaterThanOrEqual(2)
    expect(clears[0].args).toEqual([0, 0, 800, 224])
    // the unwanted first frame was the old page's own body { background }
    // fill — a full-canvas fillRect has no business here (label halos are
    // small rects)
    const fullFills = ctx.calls.filter(
      (c) => c.method === "fillRect" && (c.args[2] as number) >= 800 && (c.args[3] as number) >= 224,
    )
    expect(fullFills).toEqual([])
  })
})

describe("live thought", () => {
  test("a replay commit claims the node instantly and moves the cursor", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "solve", replay: true })
    const s = engine.stats()
    expect(s.claimed).toBe(1)
    expect(s.cur).toBe("solve")
  })

  test("a consider touch is a scout flash — it never claims", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "debugging", consider: true })
    const s = engine.stats()
    expect(s.claimed).toBe(0)
    expect(s.cur).toBe("amico")
  })

  test("an unknown label grafts a new node over a thought edge", () => {
    const { engine } = makeEngine()
    const before = engine.stats()
    engine.touch({ label: "scratch/wip-notes.md", replay: true })
    const after = engine.stats()
    expect(after.nodes).toBe(before.nodes + 1)
    expect(after.edges).toBe(before.edges + 1)
    expect(after.claimed).toBe(1)
  })

  test("a live commit claims through the reduced-motion pump", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "setup" })
    // reduced motion: no traveling pulses — the claim lands synchronously
    const s = engine.stats()
    expect(s.claimed).toBe(1)
    expect(s.cur).toBe("setup")
  })

  test("charting two commits since the last plate yields one constellation", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "solve", replay: true })
    engine.touch({ label: "piccolo-jl", replay: true })
    engine.chart("optimize a fluxonium X gate", true)
    expect(engine.stats().atlas).toBe(1)
  })
})

describe("theme", () => {
  test("setTheme is lossless: the atlas, claims, and cursor all survive a flip", () => {
    // the iframe workaround reloaded the document on every flip and re-flushed
    // the whole event history; the native engine just swaps ink
    const { engine } = makeEngine()
    engine.touch({ label: "solve", replay: true })
    engine.touch({ label: "piccolo-jl", replay: true })
    engine.chart("plate the thought", true)
    const before = engine.stats()
    engine.setTheme("light")
    const after = engine.stats()
    expect(after.scheme).toBe("light")
    expect(after.claimed).toBe(before.claimed)
    expect(after.atlas).toBe(before.atlas)
    expect(after.cur).toBe(before.cur)
    expect(after.nodes).toBe(before.nodes)
  })

  test("setTheme ignores junk", () => {
    const { engine } = makeEngine()
    engine.setTheme("hotdog" as never)
    expect(engine.stats().scheme).toBe("dark")
  })
})

describe("lifecycle", () => {
  test("pause stops the frame loop; resume restarts it", () => {
    const { engine, ctx } = makeEngine()
    engine.tick(16)
    const n = ctx.calls.length
    engine.pause()
    engine.tick(1000)
    expect(ctx.calls.length).toBe(n) // folded away — no frames burned
    engine.resume()
    engine.tick(1016)
    expect(ctx.calls.length).toBeGreaterThan(n)
  })

  test("destroy is terminal: later events and ticks are no-ops", () => {
    const { engine, ctx } = makeEngine()
    engine.destroy()
    const n = ctx.calls.length
    engine.touch({ label: "solve", replay: true })
    engine.resume()
    engine.tick(2000)
    expect(ctx.calls.length).toBe(n)
    expect(engine.stats().claimed).toBe(0)
  })

  test("highlight tolerates unknown labels", () => {
    const { engine } = makeEngine()
    expect(() => {
      engine.highlight("tdd")
      engine.highlight("definitely-not-a-node")
      engine.highlight("")
    }).not.toThrow()
  })
})

describe("hostile input", () => {
  test("a NaN timestamp is a no-op and does not poison the clock", () => {
    const { engine, ctx } = makeEngine()
    engine.tick(Number.NaN)
    engine.tick(Number.POSITIVE_INFINITY)
    expect(ctx.calls.length).toBe(0) // rejected before any drawing
    engine.tick(16)
    engine.touch({ label: "solve", replay: true })
    engine.tick(32) // a poisoned beat would NaN every projection from here on
    expect(ctx.calls.filter((c) => c.method === "clearRect").length).toBe(2)
    expect(engine.stats().claimed).toBe(1)
  })

  test("junk resize falls back instead of zeroing the world scale", () => {
    const { engine, ctx } = makeEngine()
    engine.resize(Number.NaN, -5)
    engine.resize(0, 0)
    engine.tick(16)
    const clears = ctx.calls.filter((c) => c.method === "clearRect")
    expect(clears[0].args).toEqual([0, 0, 800, 224]) // opts.size fallback held
  })

  test("charting fewer than two commits never plates a constellation", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "solve", replay: true })
    engine.chart("one lonely commit", true)
    expect(engine.stats().atlas).toBe(0)
  })

  test("rapid theme flips stay stable and lossless", () => {
    const { engine } = makeEngine()
    engine.touch({ label: "solve", replay: true })
    for (let i = 0; i < 50; i++) engine.setTheme(i % 2 ? "dark" : "light")
    engine.tick(16)
    expect(engine.stats().scheme).toBe("dark") // 50 flips from i=0 end on i=49 → dark
    expect(engine.stats().claimed).toBe(1)
  })

  test("the graft population is capped — marathon sessions cannot grow the graph unboundedly", () => {
    const { engine } = makeEngine()
    const boot = engine.stats().nodes
    for (let i = 0; i < 340; i++) engine.touch({ label: `scratch/probe-${i}.md`, consider: true })
    // 340 unique search patterns grafted, but eviction holds the line at the cap
    expect(engine.stats().nodes).toBeLessThanOrEqual(boot + 300)
    expect(engine.stats().edges).toBeLessThanOrEqual(boot + 300 + 200) // skeleton edges + capped thought edges
    engine.tick(16) // and the survivors still draw
  })

  test("a render error halts the loop instead of spinning half-rendered", () => {
    const ctx = recordingCtx()
    let arcs = 0
    ctx.arc = (..._args: unknown[]) => {
      if (++arcs > 4) throw new Error("boom")
    }
    const canvas = stubCanvas(ctx)
    const engine = createBrainEngine(canvas, {
      scheme: "dark",
      reduceMotion: true,
      animate: false,
      size: { width: 800, height: 224 },
    })
    engine.tick(16) // throws internally → halts, no propagation
    const n = ctx.calls.length
    engine.tick(32) // halted: no further drawing
    expect(ctx.calls.length).toBe(n)
    engine.resume() // re-arms after e.g. a session switch
    arcs = -1e9
    engine.tick(48)
    expect(ctx.calls.length).toBeGreaterThan(n)
  })
})

describe("animated pipeline (manual clock)", () => {
  // full motion: reduceMotion off, clock driven by hand — a commit is a pulse
  // that must physically travel the skeleton before its node claims
  const drive = (engine: ReturnType<typeof makeEngine>["engine"], fromMs: number, toMs: number) => {
    for (let t = fromMs; t <= toMs; t += 16) engine.tick(t)
    return toMs
  }

  test("a live commit claims only after its pulse arrives", () => {
    const { engine } = makeEngine({ reduceMotion: false })
    engine.tick(0)
    engine.touch({ label: "setup" }) // amico → experimenter → setup, one beat per hop
    expect(engine.stats().claimed).toBe(0) // departure is not arrival
    drive(engine, 16, 4000) // allegro q=126: plenty of beats for both hops
    const s = engine.stats()
    expect(s.claimed).toBeGreaterThanOrEqual(1)
    expect(s.cur).toBe("setup")
  })

  test("a chart waits for the pump to drain, then plates every commit", () => {
    const { engine } = makeEngine({ reduceMotion: false })
    engine.tick(0)
    engine.touch({ label: "setup" })
    engine.touch({ label: "solve" })
    engine.chart("the whole thought", false) // arrives while commits are in flight
    expect(engine.stats().atlas).toBe(0) // a plate never misses its own commits
    drive(engine, 16, 8000)
    const s = engine.stats()
    expect(s.atlas).toBe(1)
    expect(s.claimed).toBeGreaterThanOrEqual(2)
    expect(s.queued).toBe(0)
  })

  test("destroy with pulses in flight is safe", () => {
    const { engine } = makeEngine({ reduceMotion: false })
    engine.tick(0)
    engine.touch({ label: "setup" })
    drive(engine, 16, 200) // pulse mid-edge
    expect(() => engine.destroy()).not.toThrow()
    engine.tick(300) // halted — no draw, no arrival callbacks
    expect(engine.stats().cur).toBe("amico")
  })
})

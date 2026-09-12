import { describe, expect, test } from "bun:test"
import { createContextTreeEngine, type ContextTreeEngineOptions, type ContextTreeNodeInput } from "./context-tree-engine"

/* Headless like brain-engine.test.ts: no DOM, no rAF, no matchMedia. The stub
   canvas has no addEventListener, so pointer wiring is skipped — interaction
   logic is exercised through pick()/locate() directly. */

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
    "bezierCurveTo",
    "stroke",
    "fill",
    "arc",
    "setLineDash",
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
function makeEngine(opts: Partial<ContextTreeEngineOptions> = {}) {
  const ctx = recordingCtx()
  const engine = createContextTreeEngine(stubCanvas(ctx), {
    scheme: "dark",
    reduceMotion: true,
    animate: false,
    size: { width: 800, height: 208 },
    ...opts,
  })
  return { engine, ctx }
}

const TREE: ContextTreeNodeInput = {
  id: "root",
  label: "amico",
  kind: "root",
  children: [
    {
      id: "turn-1",
      label: "I",
      kind: "turn",
      children: [
        { id: "f-strategy", label: "STRATEGY.md", kind: "note", path: "STRATEGY.md", vault: true },
        { id: "f-solve", label: "solve.jl", kind: "source", path: "scripts/solve.jl" },
        { id: "s-transmon", label: "transmon", kind: "skill" },
      ],
    },
    {
      id: "turn-2",
      label: "II",
      kind: "turn",
      recalls: ["f-solve"],
      children: [{ id: "a-explore", label: "Explore", kind: "agent", active: true }],
    },
  ],
}

describe("setTree", () => {
  test("counts nodes, tree edges, recall links, and depth", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    const s = engine.stats()
    expect(s.nodes).toBe(7) // root + 2 turns + 4 leaves
    expect(s.edges).toBe(6) // tree edges: every non-root has exactly one
    expect(s.recalls).toBe(1)
    expect(s.depth).toBe(2)
  })
  test("re-setting keeps known ids and absorbs new ones", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    const before = engine.locate("f-solve")
    const grown = structuredClone(TREE)
    grown.children![1].children!.push({ id: "f-new", label: "new.md", kind: "note", path: "new.md" })
    engine.setTree(grown)
    expect(engine.stats().nodes).toBe(8)
    // the force settle re-equilibrates around the newcomer — known ids
    // persist (locate resolves), exact positions legitimately shift
    expect(before).toBeDefined()
    expect(engine.locate("f-solve")).toBeDefined()
    expect(engine.locate("f-new")).toBeDefined()
  })
  test("recall to an unknown id is dropped, not fatal", () => {
    const { engine } = makeEngine()
    const t = structuredClone(TREE)
    t.children![1].recalls = ["ghost-id"]
    engine.setTree(t)
    expect(engine.stats().recalls).toBe(0)
  })
})

describe("pick / locate", () => {
  test("pick at a node's location returns its id; empty space returns undefined", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    engine.tick(16)
    const p = engine.locate("f-strategy")!
    expect(engine.pick(p.x, p.y)).toBe("f-strategy")
    expect(engine.pick(-9999, -9999)).toBeUndefined()
  })
  test("locate of an unknown id is undefined", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    expect(engine.locate("nope")).toBeUndefined()
  })
})

describe("render", () => {
  test("a tick paints the frame: transform, clear, edges, circles, labels", () => {
    const { engine, ctx } = makeEngine()
    engine.setTree(TREE)
    engine.tick(16)
    const methods = new Set(ctx.calls.map((c) => c.method))
    expect(methods.has("setTransform")).toBe(true)
    expect(methods.has("clearRect")).toBe(true)
    expect(methods.has("lineTo")).toBe(true) // straight Obsidian-style edges
    expect(methods.has("arc")).toBe(true)
    expect(methods.has("fillText")).toBe(true)
  })
  test("a NaN timestamp is refused (would poison the clock)", () => {
    const { engine, ctx } = makeEngine()
    engine.setTree(TREE)
    engine.tick(Number.NaN)
    expect(ctx.calls.length).toBe(0)
  })
  test("recall edges render dashed", () => {
    const { engine, ctx } = makeEngine()
    engine.setTree(TREE)
    engine.tick(16)
    const dashes = ctx.calls.filter((c) => c.method === "setLineDash" && (c.args[0] as number[]).length > 0)
    expect(dashes.length).toBeGreaterThan(0)
  })
})

describe("theme / lifecycle", () => {
  test("setTheme swaps the scheme losslessly", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    engine.setTheme("light")
    expect(engine.stats().scheme).toBe("light")
    expect(engine.stats().nodes).toBe(7)
  })
  test("highlight of unknown label is a no-op; known label survives a tick", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    engine.highlight("does-not-exist")
    engine.highlight("solve.jl")
    engine.tick(16)
    expect(engine.stats().nodes).toBe(7)
  })
  test("resize with explicit dims scales the backing store by DPR", () => {
    const { engine } = makeEngine()
    const canvas = stubCanvas(recordingCtx())
    const e2 = createContextTreeEngine(canvas, { reduceMotion: true, animate: false })
    e2.resize(400, 100)
    expect((canvas as unknown as { width: number }).width).toBeGreaterThanOrEqual(400)
    e2.destroy()
    engine.destroy()
  })
  test("destroy is idempotent and setTree after destroy is ignored", () => {
    const { engine } = makeEngine()
    engine.setTree(TREE)
    engine.destroy()
    engine.destroy()
    engine.setTree(structuredClone(TREE))
    expect(engine.stats().nodes).toBe(7)
  })
})

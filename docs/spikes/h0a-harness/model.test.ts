import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { freePort } from "./common.ts"
import { kindFor, plan, startModel } from "./model.ts"

const opts = { seed: 42, minMs: 2000, maxMs: 8000, frameMs: 250 }

describe("pacing plan", () => {
  test("every turn lasts 2-8 s and spreads its frames across that time", () => {
    for (let n = 1; n <= 500; n++) {
      const p = plan(opts, n)
      expect(p.durationMs).toBeGreaterThanOrEqual(2000)
      expect(p.durationMs).toBeLessThanOrEqual(8000)
      expect(p.frames.at(-1)!.atMs).toBe(p.durationMs)
      expect(p.frames[0]!.atMs).toBe(0)
      const times = p.frames.map((f) => f.atMs)
      expect(times).toEqual([...times].sort((a, b) => a - b))
      if (p.kind !== "tool") expect(p.frames.length).toBeGreaterThanOrEqual(8) // not an instantaneous fake
    }
  })
  test("durations are spread over the range, not clustered", () => {
    const durations = Array.from({ length: 1000 }, (_, i) => plan(opts, i + 1).durationMs)
    expect(Math.min(...durations)).toBeLessThan(2400)
    expect(Math.max(...durations)).toBeGreaterThan(7600)
    const mean = durations.reduce((a, b) => a + b, 0) / durations.length
    expect(mean).toBeGreaterThan(4700)
    expect(mean).toBeLessThan(5300)
  })
  test("seeded: same seed and request number give the same plan, another seed does not", () => {
    expect(plan(opts, 17)).toEqual(plan(opts, 17))
    expect(plan({ ...opts, seed: 43 }, 17).durationMs).not.toBe(plan(opts, 17).durationMs)
  })
  test("kinds: every 5th request calls the shell tool, every 7th reasons, a tool result gets text", () => {
    expect([5, 10, 15, 20].map((n) => kindFor(n, false))).toEqual(["tool", "tool", "tool", "tool"])
    expect([7, 14, 21].map((n) => kindFor(n, false))).toEqual(["reasoning", "reasoning", "reasoning"])
    expect(kindFor(35, false)).toBe("tool")
    expect(kindFor(1, false)).toBe("text")
    expect(kindFor(5, true)).toBe("text")
    expect(plan(opts, 5).frames.map((f) => f.sse).join("")).toContain('"name":"shell"')
    expect(plan(opts, 7).frames.map((f) => f.sse).join("")).toContain("reasoning_content")
    expect(plan(opts, 7).frames.map((f) => f.sse).join("")).toContain("content")
  })
})

describe("the paced server, on the wire", () => {
  let model: ReturnType<typeof startModel>
  beforeAll(async () => {
    model = startModel({ ...opts, port: await freePort() })
  })
  afterAll(() => model.stop())

  const ask = async (messages: object[]) => {
    const started = performance.now()
    const res = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ stream: true, messages }),
    })
    const arrivals: number[] = []
    let text = ""
    for await (const chunk of res.body!) {
      arrivals.push(performance.now() - started)
      text += new TextDecoder().decode(chunk)
    }
    return { arrivals, text, total: performance.now() - started }
  }

  test("a streamed turn takes the planned 2-8 s, arrives in many frames, and ends with usage and [DONE]", async () => {
    const [first, second] = await Promise.all([ask([{ role: "user", content: "a" }]), ask([{ role: "user", content: "b" }])])
    for (const [i, turn] of [first, second].entries()) {
      const planned = plan(opts, i + 1)
      expect(turn.total).toBeGreaterThanOrEqual(2000)
      expect(turn.total).toBeLessThanOrEqual(8600)
      expect(Math.abs(turn.total - planned.durationMs)).toBeLessThan(400)
      expect(turn.arrivals.length).toBeGreaterThanOrEqual(6)
      expect(turn.arrivals[0]!).toBeLessThan(500) // the role frame is immediate
      expect(turn.text).toContain('"usage"')
      expect(turn.text.trimEnd().endsWith("data: [DONE]")).toBe(true)
    }
    const stats = await (await fetch(`http://127.0.0.1:${model.port}/__stats`)).json()
    expect(stats).toMatchObject({ requests: 2, completed: 2, active: 0, maxActive: 2, aborted: 0 })
  }, 20_000)

  test("an aborted stream is counted and releases its slot", async () => {
    const controller = new AbortController()
    const res = await fetch(`http://127.0.0.1:${model.port}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "c" }] }),
      signal: controller.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()
    expect(((await (await fetch(`http://127.0.0.1:${model.port}/__stats`)).json()) as { active: number }).active).toBe(1)
    await reader.cancel()
    await Bun.sleep(100)
    expect(await (await fetch(`http://127.0.0.1:${model.port}/__stats`)).json()).toMatchObject({ active: 0, aborted: 1 })
  }, 20_000)

  test("refuses a port outside 53000-53999", () => {
    expect(() => startModel({ ...opts, port: 52000 })).toThrow(/outside the H0a range/)
    expect(() => startModel({ ...opts, port: 49374 })).toThrow(/outside the H0a range/)
  })
})

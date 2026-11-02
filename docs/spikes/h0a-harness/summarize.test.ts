import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { evaluate, summarizeRun, type RunData } from "./summarize.ts"

const T0 = 1_000_000 // measurement starts here (epoch ms)
const GB = 1e9

/** A healthy 60 s window at 4 Hz unless a field is overridden. */
function healthy(over: Partial<{ host: number; control: number; seconds: number }> = {}): RunData {
  const seconds = over.seconds ?? 60
  const ticks = seconds * 4
  return {
    config: { measure_from: T0, measure_until: T0 + seconds * 1000, duration_s: seconds, warmup_s: 10, sessions: 4 },
    probe: Array.from({ length: ticks }, (_, i) => ({ t: T0 + i * 250, h: over.host ?? 5, c: over.control ?? 1, hs: 200, cs: 200 })),
    sampler: Array.from({ length: Math.floor(seconds / 10) + 1 }, (_, i) => ({ t: T0 + i * 10_000, rss: 1 * GB, cpu_s: i, load1: 3 })),
    turns: Array.from({ length: 100 }, (_, i) => ({ session: `s${i % 4}`, start: T0 + i * 100, end: T0 + i * 100 + 5000, outcome: "succeeded" as const })),
    lag: Array.from({ length: seconds * 10 }, (_, i) => ({ t: T0 + i * 100, d: 1 })),
    events: [{ t: T0 - 20_000, event: "host_started", planned: true }],
  }
}
const status = (data: RunData, criterion: string) => evaluate(data).criteria.find((c) => c.criterion === criterion)!.status

describe("latency criterion at its boundaries (pre-registered: excess < 250 ms and host p99 < 500 ms; control p99 > 100 ms is inconclusive)", () => {
  test("excess 249 ms passes, 251 ms fails, exactly 250 ms fails (strictly under)", () => {
    expect(status(healthy({ host: 300, control: 51 }), "latency")).toBe("pass")
    expect(status(healthy({ host: 302, control: 51 }), "latency")).toBe("fail")
    expect(status(healthy({ host: 301, control: 51 }), "latency")).toBe("fail")
  })
  test("host p99 of 500 ms fails even with a small excess", () => {
    expect(status(healthy({ host: 500, control: 100 }), "latency")).toBe("fail")
  })
  test("control p99 over 100 ms is inconclusive, never a pass, even when the host looks fine", () => {
    expect(status(healthy({ host: 105, control: 101 }), "latency")).toBe("inconclusive")
    expect(evaluate(healthy({ host: 105, control: 101 })).verdict).toBe("inconclusive")
    expect(status(healthy({ host: 105, control: 100 }), "latency")).toBe("pass")
  })
  test("reports the numbers it judged", () => {
    const latency = evaluate(healthy({ host: 300, control: 51 })).criteria.find((c) => c.criterion === "latency")!
    expect(latency).toMatchObject({ host_p99_ms: 300, control_p99_ms: 51, excess_p99_ms: 249 })
  })
  test("a miss counts as the 2 s timeout in the percentile, not as a missing sample", () => {
    const data = healthy()
    for (let i = 0; i < 10; i++) data.probe[i] = { ...data.probe[i]!, h: null, hs: 0 } // 10 of 240 = 4 % of ticks missed
    expect(status(data, "latency")).toBe("fail")
  })
  test("host answering errors (non-200) is not a latency pass", () => {
    const data = healthy()
    data.probe.forEach((p) => (p.hs = 401))
    expect(status(data, "latency")).toBe("inconclusive")
  })
})

describe("wedge criterion", () => {
  test("clean run: zero wedges and zero unplanned exits passes", () => {
    expect(status(healthy(), "no_wedge")).toBe("pass")
  })
  test("one missed tick is not a wedge; two consecutive are", () => {
    const one = healthy()
    one.probe[50] = { ...one.probe[50]!, h: null, hs: 0 }
    expect(status(one, "no_wedge")).toBe("pass")
    const two = healthy()
    two.probe[50] = { ...two.probe[50]!, h: null, hs: 0 }
    two.probe[51] = { ...two.probe[51]!, h: null, hs: 0 }
    expect(status(two, "no_wedge")).toBe("fail")
    expect(evaluate(two).criteria.find((c) => c.criterion === "no_wedge")).toMatchObject({ wedges: 1 })
  })
  test("a slow answer (>= 2 s) is a miss", () => {
    const data = healthy()
    data.probe[10] = { ...data.probe[10]!, h: 2000, hs: 200 }
    data.probe[11] = { ...data.probe[11]!, h: 2400, hs: 200 }
    expect(evaluate(data).criteria.find((c) => c.criterion === "no_wedge")).toMatchObject({ wedges: 1 })
  })
  test("an unplanned host exit fails; a planned stop does not", () => {
    const planned = healthy()
    planned.events = [...planned.events, { t: T0 + 59_000, event: "host_exit", planned: true }]
    expect(status(planned, "no_wedge")).toBe("pass")
    const unplanned = healthy()
    unplanned.events = [...unplanned.events, { t: T0 + 30_000, event: "host_exit", planned: false }]
    expect(status(unplanned, "no_wedge")).toBe("fail")
  })
  test("a wedge during warm-up is reported but excluded from the verdict", () => {
    const data = healthy()
    data.probe.unshift({ t: T0 - 500, h: null, c: 1, hs: 0, cs: 200 }, { t: T0 - 250, h: null, c: 1, hs: 0, cs: 200 })
    expect(status(data, "no_wedge")).toBe("pass")
    expect(evaluate(data).criteria.find((c) => c.criterion === "no_wedge")).toMatchObject({ wedges: 0, warmup_wedges: 1 })
  })
})

describe("memory criterion (growth < 2 GB and 24 h extrapolation < 8 GB)", () => {
  const withRss = (fn: (i: number) => number, seconds = 3600) => {
    const data = healthy({ seconds })
    data.sampler = Array.from({ length: seconds / 10 + 1 }, (_, i) => ({ t: T0 + i * 10_000, rss: fn(i * 10), cpu_s: i, load1: 3 }))
    return data
  }
  test("flat RSS passes", () => {
    expect(status(withRss(() => 1.5 * GB), "memory")).toBe("pass")
  })
  test("growth just under / over 2 GB over the window", () => {
    // growth 1.99 GB in 2 h would extrapolate far past 8 GB at 24 h, so test growth on its own with a step at the end.
    const step = (g: number) => withRss((s) => (s >= 3590 ? 1 * GB + g : 1 * GB))
    expect(status(step(1.99 * GB), "memory")).toBe("pass")
    expect(status(step(2.01 * GB), "memory")).toBe("fail")
  })
  test("a slow leak that stays under 2 GB but extrapolates past 8 GB at 24 h fails", () => {
    // 1.5 GB over 1 h -> 36 GB/day
    expect(status(withRss((s) => 1 * GB + (1.5 * GB * s) / 3600), "memory")).toBe("fail")
  })
  test("a gentle slope passes, and the extrapolation is reported", () => {
    // 0.1 GB per hour = 2.4 GB/day: 1 GB + 2.4 GB projected
    const result = evaluate(withRss((s) => 1 * GB + (0.1 * GB * s) / 3600)).criteria.find((c) => c.criterion === "memory")!
    expect(result.status).toBe("pass")
    expect(result.projected_rss_24h_bytes as number).toBeGreaterThan(3.3 * GB)
    expect(result.projected_rss_24h_bytes as number).toBeLessThan(3.5 * GB)
  })
  test("fewer than two RSS samples in the window is invalid, not a pass", () => {
    const data = healthy()
    data.sampler = [{ t: T0, rss: GB, cpu_s: 0, load1: 1 }]
    expect(status(data, "memory")).toBe("invalid")
  })
})

describe("turn correctness (>= 99 % complete, none silently lost)", () => {
  const turns = (succeeded: number, failed: number, lost: number) => [
    ...Array.from({ length: succeeded }, () => ({ session: "s", start: T0 + 1, end: T0 + 5000, outcome: "succeeded" as const })),
    ...Array.from({ length: failed }, () => ({ session: "s", start: T0 + 1, end: T0 + 5000, outcome: "failed" as const })),
    ...Array.from({ length: lost }, () => ({ session: "s", start: T0 + 1, end: null, outcome: "lost" as const })),
  ]
  test("99/100 passes, 98/100 fails", () => {
    const a = healthy()
    a.turns = turns(99, 1, 0)
    expect(status(a, "turns")).toBe("pass")
    const b = healthy()
    b.turns = turns(98, 2, 0)
    expect(status(b, "turns")).toBe("fail")
  })
  test("one silently lost turn fails even at 99.9 %", () => {
    const data = healthy()
    data.turns = turns(999, 0, 1)
    expect(status(data, "turns")).toBe("fail")
  })
  test("turns started during warm-up do not count; no turns at all is invalid", () => {
    const data = healthy()
    data.turns = [{ session: "s", start: T0 - 5000, end: T0 - 1, outcome: "failed" }]
    expect(status(data, "turns")).toBe("invalid")
  })
})

describe("driver saturation", () => {
  test("p99 event-loop drift over 50 ms flags driver_saturated and makes the run inconclusive, not a pass", () => {
    const data = healthy()
    data.lag = data.lag.map((l, i) => ({ ...l, d: i % 50 === 0 ? 80 : 1 })) // 2 % of samples at 80 ms -> p99 80
    const result = evaluate(data)
    expect(result.driver_saturated).toBe(true)
    expect(result.verdict).toBe("inconclusive")
  })
  test("a quiet driver is not flagged", () => {
    expect(evaluate(healthy()).driver_saturated).toBe(false)
  })
})

describe("overall verdict", () => {
  test("a healthy run passes all four", () => {
    const result = evaluate(healthy())
    expect(result.verdict).toBe("pass")
    expect(result.criteria.map((c) => c.status)).toEqual(["pass", "pass", "pass", "pass"])
  })
  test("any failed criterion fails the run", () => {
    expect(evaluate(healthy({ host: 400, control: 1 })).verdict).toBe("fail")
  })
  test("an unplanned exit of a harness process (model/probe/driver) makes the run inconclusive", () => {
    const data = healthy()
    data.events = [...data.events, { t: T0 + 100, event: "model_exit", planned: false }]
    expect(evaluate(data).verdict).toBe("inconclusive")
  })
  test("a definitive failure (unplanned host exit) is a fail even when the run was cut short and other inputs are unusable", () => {
    const data = healthy()
    data.probe = data.probe.slice(0, 40) // the host died, the run ended early
    data.events = [...data.events, { t: T0 + 10_000, event: "host_exit", planned: false }]
    const result = evaluate(data)
    expect(result.criteria.find((c) => c.criterion === "latency")!.status).toBe("invalid")
    expect(result.verdict).toBe("fail")
  })
  test("a probe that ran for less than 90 % of the window is invalid", () => {
    const data = healthy()
    data.probe = data.probe.slice(0, 100) // 100 of 240 expected
    expect(evaluate(data).verdict).toBe("invalid")
  })
})

describe("summarizeRun refuses to pass on missing or empty inputs", () => {
  const dirs: string[] = []
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })))
  const write = (dir: string, data: RunData, skip: string[] = [], empty: string[] = []) => {
    const rows: Record<string, unknown[]> = { "probe.ndjson": data.probe, "sampler.ndjson": data.sampler, "turns.ndjson": data.turns, "driver-lag.ndjson": data.lag, "events.ndjson": data.events }
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(data.config))
    for (const [name, list] of Object.entries(rows)) {
      if (skip.includes(name)) continue
      fs.writeFileSync(path.join(dir, name), empty.includes(name) ? "" : list.map((r) => JSON.stringify(r)).join("\n") + (list.length ? "\n" : ""))
    }
  }
  const fresh = () => {
    const dir = fs.mkdtempSync(path.join("/tmp/opencode/", "h0a-summ-"))
    dirs.push(dir)
    return dir
  }

  test("a complete run directory passes", () => {
    const dir = fresh()
    write(dir, healthy())
    const summary = summarizeRun(dir)
    expect(summary.verdict).toBe("pass")
    expect(summary.problems).toEqual([])
  })
  test.each(["probe.ndjson", "sampler.ndjson", "turns.ndjson", "driver-lag.ndjson", "events.ndjson", "run.json"])("missing %s is invalid", (name) => {
    const dir = fresh()
    write(dir, healthy(), [name])
    if (name === "run.json") fs.rmSync(path.join(dir, name), { force: true })
    const summary = summarizeRun(dir)
    expect(summary.verdict).toBe("invalid")
    expect(summary.problems.join(" ")).toContain(name)
  })
  test.each(["probe.ndjson", "sampler.ndjson", "turns.ndjson", "driver-lag.ndjson", "events.ndjson"])("empty %s is invalid", (name) => {
    const dir = fresh()
    write(dir, healthy(), [], [name])
    expect(summarizeRun(dir).verdict).toBe("invalid")
  })
  test("an empty directory is invalid", () => {
    expect(summarizeRun(fresh()).verdict).toBe("invalid")
  })
  test("a directory that does not exist is invalid", () => {
    expect(summarizeRun("/tmp/opencode/h0a-does-not-exist-" + process.pid).verdict).toBe("invalid")
  })
  test("a truncated last line (writer killed mid-write) is tolerated, garbage elsewhere is invalid", () => {
    const dir = fresh()
    write(dir, healthy())
    fs.appendFileSync(path.join(dir, "probe.ndjson"), '{"t":1,"h":')
    expect(summarizeRun(dir).verdict).toBe("pass")
    const bad = fresh()
    write(bad, healthy())
    fs.writeFileSync(path.join(bad, "turns.ndjson"), "not json\n" + fs.readFileSync(path.join(bad, "turns.ndjson"), "utf8"))
    expect(summarizeRun(bad).verdict).toBe("invalid")
  })
})

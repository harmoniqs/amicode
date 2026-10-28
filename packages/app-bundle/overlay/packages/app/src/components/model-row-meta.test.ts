// amicode#1988 (#1979 S5): the picker row meta — price / context / tools /
// measured latency — and the cheapest-that-works search order. Pure, pinned
// without mounting the SolidJS picker.
import { describe, expect, test } from "bun:test"
import type { ModelReachabilityView, ReachabilitySnapshot } from "./dialog-select-model-reachability"
import {
  compareCheapestOk,
  effectivePrice,
  formatContext,
  formatLatency,
  formatPrice,
  formatPriceCompact,
  formatTools,
  formatUsd,
  latencyOf,
  modelRowMeta,
  searchTier,
} from "./model-row-meta"

describe("formatUsd — per-Mtok rounding", () => {
  test(">= 1: at most 2 decimals, trailing zeros dropped", () => {
    expect(formatUsd(3)).toBe("$3")
    expect(formatUsd(15)).toBe("$15")
    expect(formatUsd(1.25)).toBe("$1.25")
    expect(formatUsd(2.5)).toBe("$2.5")
    expect(formatUsd(1.256)).toBe("$1.26")
    expect(formatUsd(15.004)).toBe("$15")
  })

  test("< 1: up to 3 decimals, trailing zeros dropped", () => {
    expect(formatUsd(0.3)).toBe("$0.3")
    expect(formatUsd(0.075)).toBe("$0.075")
    expect(formatUsd(0.1234)).toBe("$0.123")
    expect(formatUsd(0.08)).toBe("$0.08")
  })

  test("tiny non-zero prices never round down to $0", () => {
    expect(formatUsd(0.0001)).toBe("<$0.001")
  })

  test("0 is $0; missing / non-finite / negative is —", () => {
    expect(formatUsd(0)).toBe("$0")
    expect(formatUsd(undefined)).toBe("—")
    expect(formatUsd(Number.NaN)).toBe("—")
    expect(formatUsd(-1)).toBe("—")
  })
})

describe("formatPrice — $in/$out · cache $c per Mtok", () => {
  test("full price with cache read", () => {
    expect(formatPrice({ input: 3, output: 15, cache_read: 0.3 })).toBe("$3/$15 · cache $0.3 per Mtok")
    // the SDK shape (cost.cache.read) reads the same
    expect(formatPrice({ input: 3, output: 15, cache: { read: 0.3 } })).toBe("$3/$15 · cache $0.3 per Mtok")
  })

  test("no cache-read price → the cache segment is omitted", () => {
    expect(formatPrice({ input: 0.15, output: 0.6 })).toBe("$0.15/$0.6 per Mtok")
  })

  test("all-zero price is free", () => {
    expect(formatPrice({ input: 0, output: 0 })).toBe("free")
    expect(formatPrice({ input: 0, output: 0, cache_read: 0 })).toBe("free")
    expect(formatPriceCompact({ input: 0, output: 0 })).toBe("free")
  })

  test("missing price shows as —", () => {
    expect(formatPrice(undefined)).toBe("—")
    expect(formatPrice({})).toBe("—")
    expect(formatPriceCompact(undefined)).toBe("—")
    // one side missing: that side is —
    expect(formatPrice({ input: 3 })).toBe("$3/— per Mtok")
  })

  test("compact form is $in/$out", () => {
    expect(formatPriceCompact({ input: 3, output: 15, cache_read: 0.3 })).toBe("$3/$15")
  })

  test("labels are injectable (i18n)", () => {
    const labels = { free: "gratis", cache: "caché", perMtok: "por Mtok" }
    expect(formatPrice({ input: 0, output: 0 }, labels)).toBe("gratis")
    expect(formatPrice({ input: 3, output: 15, cache_read: 0.3 }, labels)).toBe("$3/$15 · caché $0.3 por Mtok")
  })
})

describe("formatContext — K / M units", () => {
  test("thousands → K, millions → M", () => {
    expect(formatContext(200_000)).toBe("200K")
    expect(formatContext(128_000)).toBe("128K")
    expect(formatContext(131_072)).toBe("131K")
    expect(formatContext(1_000_000)).toBe("1M")
    expect(formatContext(1_048_576)).toBe("1M")
    expect(formatContext(1_500_000)).toBe("1.5M")
    expect(formatContext(999_999)).toBe("1M")
    expect(formatContext(512)).toBe("512")
  })

  test("missing / zero → —", () => {
    expect(formatContext(undefined)).toBe("—")
    expect(formatContext(0)).toBe("—")
  })
})

describe("formatTools", () => {
  test("SDK capabilities.toolcall or catalog tool_call; unknown → undefined", () => {
    expect(formatTools({ capabilities: { toolcall: true } })).toBe("yes")
    expect(formatTools({ capabilities: { toolcall: false } })).toBe("no")
    expect(formatTools({ tool_call: true })).toBe("yes")
    expect(formatTools({})).toBeUndefined()
  })
})

describe("formatLatency — measured, from reachability latency_ms", () => {
  test("seconds with one decimal under 10 s, whole seconds above", () => {
    expect(formatLatency(900)).toBe("0.9 s")
    expect(formatLatency(1234)).toBe("1.2 s")
    expect(formatLatency(12_500)).toBe("13 s")
    expect(formatLatency(45)).toBe("<0.1 s")
  })

  test("missing → omitted (undefined)", () => {
    expect(formatLatency(undefined)).toBeUndefined()
    expect(formatLatency(null)).toBeUndefined()
    expect(formatLatency(-5)).toBeUndefined()
  })

  test("latencyOf reads the snapshot row", () => {
    const snapshot: ReachabilitySnapshot = {
      catalog_known: true,
      providers: [],
      models: [
        {
          provider: "a",
          model: "x",
          status: "ok",
          reason: null,
          latency_ms: 900,
          checked_at: 1,
          credential_fp: null,
          source: "probe",
        },
      ],
    }
    expect(latencyOf(snapshot, { providerID: "a", modelID: "x" })).toBe(900)
    expect(latencyOf(snapshot, { providerID: "a", modelID: "y" })).toBeUndefined()
    expect(latencyOf(undefined, { providerID: "a", modelID: "x" })).toBeUndefined()
  })

  test("modelRowMeta bundles it all", () => {
    expect(
      modelRowMeta(
        { cost: { input: 3, output: 15, cache: { read: 0.3 } }, limit: { context: 200_000 }, capabilities: { toolcall: true } },
        900,
      ),
    ).toEqual({
      price: "$3/$15 · cache $0.3 per Mtok",
      priceCompact: "$3/$15",
      context: "200K",
      tools: "yes",
      latency: "0.9 s",
    })
    expect(modelRowMeta({}, undefined).latency).toBeUndefined()
  })
})

describe("effectivePrice — cache-read-weighted blend", () => {
  test("0.2·input + 0.6·cache_read + 0.2·output", () => {
    expect(effectivePrice({ input: 3, output: 15, cache_read: 0.3 })).toBeCloseTo(0.6 + 0.18 + 3)
  })

  test("no cache-read price → cache reads bill as input", () => {
    expect(effectivePrice({ input: 1, output: 2 })).toBeCloseTo(0.2 + 0.6 + 0.4)
  })

  test("free is 0; unknown input or output → undefined", () => {
    expect(effectivePrice({ input: 0, output: 0 })).toBe(0)
    expect(effectivePrice(undefined)).toBeUndefined()
    expect(effectivePrice({ input: 1 })).toBeUndefined()
  })
})

const view = (over: Partial<ModelReachabilityView>): ModelReachabilityView => ({
  status: "ok",
  reason: null,
  hidden: false,
  greyed: false,
  tag: undefined,
  ...over,
})

describe("searchTier", () => {
  test("ok / no snapshot → 0; shown-but-unproven → 1; dead (hidden or selected-dead) → 2", () => {
    expect(searchTier(view({}))).toBe(0)
    expect(searchTier(view({ status: undefined }))).toBe(0)
    expect(searchTier(view({ status: "rate-limited", tag: "rate-limited" }))).toBe(1)
    expect(searchTier(view({ status: "unchecked", tag: "unchecked" }))).toBe(1)
    expect(searchTier(view({ status: "denied", hidden: true, greyed: true }))).toBe(2)
    expect(searchTier(view({ status: "denied", tag: "selected-dead" }))).toBe(2)
  })
})

type Row = { name: string; price: number | undefined; tier: 0 | 1 | 2 }
const sortRows = (rows: Row[]) =>
  [...rows]
    .sort(compareCheapestOk<Row>({ tierOf: (r) => r.tier, priceOf: (r) => r.price, nameOf: (r) => r.name }))
    .map((r) => r.name)

describe("compareCheapestOk — cheapest-that-works", () => {
  test("cheapest ok model first", () => {
    expect(
      sortRows([
        { name: "pricey", price: 9, tier: 0 },
        { name: "cheap", price: 1, tier: 0 },
        { name: "mid", price: 4, tier: 0 },
      ]),
    ).toEqual(["cheap", "mid", "pricey"])
  })

  test("a dead model never sorts above an ok one, however cheap", () => {
    expect(
      sortRows([
        { name: "dead-free", price: 0, tier: 2 },
        { name: "ok-pricey", price: 50, tier: 0 },
        { name: "limited-cheap", price: 0.1, tier: 1 },
        { name: "ok-unknown", price: undefined, tier: 0 },
      ]),
    ).toEqual(["ok-pricey", "ok-unknown", "limited-cheap", "dead-free"])
  })

  test("unknown price sorts after known within a tier; ties by name", () => {
    expect(
      sortRows([
        { name: "b", price: 2, tier: 0 },
        { name: "z-unknown", price: undefined, tier: 0 },
        { name: "a", price: 2, tier: 0 },
        { name: "a-unknown", price: undefined, tier: 0 },
      ]),
    ).toEqual(["a", "b", "a-unknown", "z-unknown"])
  })
})

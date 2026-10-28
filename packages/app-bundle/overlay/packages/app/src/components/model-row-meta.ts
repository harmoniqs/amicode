// amicode#1988 (#1979 S5): the model picker's row meta — price, context,
// tool support (catalog: overlay packages/core/src/models-dev.ts, surfaced on
// the app's model objects as cost.{input,output,cache.read}, limit.context,
// capabilities.toolcall) and the measured latency (S2 reachability
// latency_ms) — plus the cheapest-that-works search order. PURE — no
// SolidJS — so rounding and ordering are unit-tested.
//
// Rules:
//  - Prices are USD per million tokens. >= 1 → at most 2 decimals; < 1 → up
//    to 3 decimals (a non-zero price below $0.001 reads "<$0.001", never
//    "$0"); trailing zeros dropped. A missing / non-finite price is "—".
//  - The whole price is "free" when every known part is 0, "—" when neither
//    input nor output is known. The cache segment is omitted when the catalog
//    has no cache-read price.
//  - Context: "200K" / "1M" / "1.5M"; missing → "—".
//  - Latency: "0.9 s" from latency_ms; missing → omitted (undefined).
//  - Search order (non-empty query only): reachability tier first — ok (or no
//    reachability data) → shown-but-unproven (rate-limited / unchecked) →
//    dead (hidden, or the selected-dead current model) — so a dead model never
//    sorts above an ok one; then effective price ascending (unknown last);
//    ties by name.
//  - Effective price blend (per Mtok): 0.2·input + 0.6·cache_read + 0.2·output.
//    Agent turns re-send a growing, mostly-cached prompt, so cache reads
//    dominate real spend; a model with no cache-read price bills those reads
//    at its input price.
import type { ModelRef, ModelReachabilityView, ReachabilitySnapshot } from "./dialog-select-model-reachability"

export type CatalogCost = {
  input?: number
  output?: number
  /** models.dev catalog shape */
  cache_read?: number
  /** SDK model shape */
  cache?: { read?: number }
}

export type RowMetaModel = {
  cost?: CatalogCost
  limit?: { context?: number }
  capabilities?: { toolcall?: boolean }
  tool_call?: boolean
}

export type PriceLabels = { free: string; cache: string; perMtok: string }

export const DEFAULT_PRICE_LABELS: PriceLabels = { free: "free", cache: "cache", perMtok: "per Mtok" }

export const EFFECTIVE_PRICE_BLEND = { input: 0.2, cache_read: 0.6, output: 0.2 } as const

export type ModelRowMeta = {
  price: string
  priceCompact: string
  context: string
  tools: "yes" | "no" | undefined
  latency: string | undefined
}

const MISSING = "—"

const known = (n: number | undefined | null): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0

const trim = (n: number, decimals: number) => String(Number(n.toFixed(decimals)))

export function formatUsd(n: number | undefined) {
  if (!known(n)) return MISSING
  if (n === 0) return "$0"
  if (n < 0.001) return "<$0.001"
  return `$${trim(n, n < 1 ? 3 : 2)}`
}

const cacheRead = (cost: CatalogCost) => {
  const value = cost.cache_read ?? cost.cache?.read
  return known(value) ? value : undefined
}

function priceState(cost: CatalogCost | undefined) {
  if (!cost || (!known(cost.input) && !known(cost.output))) return "missing" as const
  const cache = cacheRead(cost)
  if (cost.input === 0 && cost.output === 0 && (cache === undefined || cache === 0)) return "free" as const
  return "priced" as const
}

export function formatPriceCompact(cost: CatalogCost | undefined, labels: PriceLabels = DEFAULT_PRICE_LABELS) {
  const state = priceState(cost)
  if (state === "missing" || !cost) return MISSING
  if (state === "free") return labels.free
  return `${formatUsd(cost.input)}/${formatUsd(cost.output)}`
}

export function formatPrice(cost: CatalogCost | undefined, labels: PriceLabels = DEFAULT_PRICE_LABELS) {
  const state = priceState(cost)
  if (state === "missing" || !cost) return MISSING
  if (state === "free") return labels.free
  const cache = cacheRead(cost)
  const segment = cache === undefined ? "" : ` · ${labels.cache} ${formatUsd(cache)}`
  return `${formatUsd(cost.input)}/${formatUsd(cost.output)}${segment} ${labels.perMtok}`
}

export function formatContext(n: number | undefined) {
  if (!known(n) || n === 0) return MISSING
  if (n < 1000) return String(Math.round(n))
  const thousands = Math.round(n / 1000)
  if (thousands < 1000) return `${thousands}K`
  return `${trim(n / 1_000_000, 1)}M`
}

export function formatTools(model: RowMetaModel): "yes" | "no" | undefined {
  const value = model.capabilities?.toolcall ?? model.tool_call
  if (value === undefined) return undefined
  return value ? "yes" : "no"
}

export function formatLatency(ms: number | undefined | null) {
  if (!known(ms)) return undefined
  if (ms < 100) return "<0.1 s"
  const s = ms / 1000
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`
}

export function latencyOf(snapshot: ReachabilitySnapshot | undefined, ref: ModelRef) {
  const value = snapshot?.models.find((m) => m.provider === ref.providerID && m.model === ref.modelID)?.latency_ms
  return known(value) ? value : undefined
}

export function modelRowMeta(
  model: RowMetaModel,
  latencyMs: number | undefined,
  labels: PriceLabels = DEFAULT_PRICE_LABELS,
): ModelRowMeta {
  return {
    price: formatPrice(model.cost, labels),
    priceCompact: formatPriceCompact(model.cost, labels),
    context: formatContext(model.limit?.context),
    tools: formatTools(model),
    latency: formatLatency(latencyMs),
  }
}

/** The compact row line: "$in/$out · context · latency", plus a "no tools"
 *  marker when the catalog says the model cannot call tools. */
export function formatRowInline(meta: ModelRowMeta, options: { omitPrice?: boolean; noTools?: string } = {}) {
  return [
    options.omitPrice ? undefined : meta.priceCompact,
    meta.context,
    meta.latency,
    meta.tools === "no" ? (options.noTools ?? "no tools") : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" · ")
}

export function effectivePrice(cost: CatalogCost | undefined) {
  if (!cost || !known(cost.input) || !known(cost.output)) return undefined
  const cache = cacheRead(cost) ?? cost.input
  return (
    EFFECTIVE_PRICE_BLEND.input * cost.input +
    EFFECTIVE_PRICE_BLEND.cache_read * cache +
    EFFECTIVE_PRICE_BLEND.output * cost.output
  )
}

/** 0 = ok (or no reachability data), 1 = shown but unproven, 2 = dead. */
export function searchTier(view: ModelReachabilityView): 0 | 1 | 2 {
  if (view.hidden || view.tag === "selected-dead") return 2
  if (view.status === undefined || view.status === "ok") return 0
  return 1
}

export function compareCheapestOk<T>(input: {
  tierOf: (item: T) => number
  priceOf: (item: T) => number | undefined
  nameOf: (item: T) => string
}) {
  return (a: T, b: T) => {
    const tier = input.tierOf(a) - input.tierOf(b)
    if (tier !== 0) return tier
    const pa = input.priceOf(a)
    const pb = input.priceOf(b)
    if (pa !== undefined && pb !== undefined && pa !== pb) return pa - pb
    if (pa === undefined && pb !== undefined) return 1
    if (pa !== undefined && pb === undefined) return -1
    return input.nameOf(a).localeCompare(input.nameOf(b))
  }
}

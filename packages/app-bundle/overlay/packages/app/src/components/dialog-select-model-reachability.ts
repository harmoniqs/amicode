// amicode#1986 (#1979 S3): the model picker's reachability merge. PURE — no
// SolidJS, no fetch — so the visible-set rules are unit-tested and S4/S5 can
// reuse them. The fetch lives in dialog-select-model-reachability-source.ts.
//
// Data: GET /amicode/model-reachability (S2, #1985). Rules (the issue's):
//  - ok → shown. rate-limited → shown with a warning tag.
//  - denied / unavailable / invalid / error → hidden behind the toggle.
//  - unchecked (or no row at all) → shown labelled "unchecked" ONLY when the
//    provider has no probe data at all; otherwise hidden behind the toggle.
//    Unchecked is never presented as working.
//  - the currently selected model is always shown, even if dead (tagged).
//  - no snapshot (route unavailable / non-amicode host / ok:false) →
//    passthrough: the picker behaves exactly as upstream.

export type ReachabilityStatus = "ok" | "denied" | "unavailable" | "invalid" | "rate-limited" | "error" | "unchecked"

const STATUSES: readonly ReachabilityStatus[] = [
  "ok",
  "denied",
  "unavailable",
  "invalid",
  "rate-limited",
  "error",
  "unchecked",
]

export type ReachabilityModel = {
  provider: string
  model: string
  status: ReachabilityStatus
  reason: string | null
  latency_ms: number | null
  checked_at: number | null
  credential_fp: string | null
  source: "probe" | "demoted" | null
}

export type ReachabilityProvider = {
  provider: string
  credential_fp: string | null
  last_probe_at: number | null
  last_attempt_at: number | null
  last_error: string | null
  next_probe_at: number | null
}

export type ReachabilitySnapshot = {
  catalog_known: boolean
  models: ReachabilityModel[]
  providers: ReachabilityProvider[]
}

export type ModelRef = { providerID: string; modelID: string }

/** What the picker renders for one model. `tag` drives the inline label:
 *  "rate-limited" (warning), "unchecked" (never presented as working),
 *  "selected-dead" (the current model, kept although dead), or undefined. */
export type ModelReachabilityView = {
  status: ReachabilityStatus | undefined
  reason: string | null
  hidden: boolean
  greyed: boolean
  tag: "rate-limited" | "unchecked" | "selected-dead" | undefined
}

export type ReachabilityReasonKey =
  | "dialog.model.reachability.reason.denied"
  | "dialog.model.reachability.reason.unavailable"
  | "dialog.model.reachability.reason.invalid"
  | "dialog.model.reachability.reason.rateLimited"
  | "dialog.model.reachability.reason.unchecked"
  | "dialog.model.reachability.reason.error"

/** A human reason: an i18n key, or the probe's own (already redacted) text. */
export type ReachabilityReason = { key: ReachabilityReasonKey } | { text: string }

export const REACHABILITY_ROUTE = "/amicode/model-reachability"
export const REACHABILITY_REFRESH_ROUTE = "/amicode/model-reachability/refresh"

const DEAD: ReadonlySet<ReachabilityStatus> = new Set(["denied", "unavailable", "invalid", "error"])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : null)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)

/** Parse the S2 GET body. undefined ⇒ passthrough (no usable data). */
export function parseReachabilityResponse(raw: unknown): ReachabilitySnapshot | undefined {
  if (!isObj(raw) || raw.ok !== true || !Array.isArray(raw.models)) return undefined
  const models: ReachabilityModel[] = []
  for (const m of raw.models) {
    if (!isObj(m) || typeof m.provider !== "string" || typeof m.model !== "string") continue
    if (!STATUSES.includes(m.status as ReachabilityStatus)) continue
    models.push({
      provider: m.provider,
      model: m.model,
      status: m.status as ReachabilityStatus,
      reason: str(m.reason),
      latency_ms: num(m.latency_ms),
      checked_at: num(m.checked_at),
      credential_fp: str(m.credential_fp),
      source: m.source === "probe" || m.source === "demoted" ? m.source : null,
    })
  }
  const providers: ReachabilityProvider[] = []
  for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!isObj(p) || typeof p.provider !== "string") continue
    providers.push({
      provider: p.provider,
      credential_fp: str(p.credential_fp),
      last_probe_at: num(p.last_probe_at),
      last_attempt_at: num(p.last_attempt_at),
      last_error: str(p.last_error),
      next_probe_at: num(p.next_probe_at),
    })
  }
  return { catalog_known: raw.catalog_known === true, models, providers }
}

const refKey = (ref: ModelRef) => `${ref.providerID}\u0000${ref.modelID}`

const PASSTHROUGH: ModelReachabilityView = {
  status: undefined,
  reason: null,
  hidden: false,
  greyed: false,
  tag: undefined,
}

/** Merge reachability into the picker's (already visibility-filtered) list.
 *  `shown` / `hidden` preserve input order; `list(showUnavailable)` is what to
 *  render (shown, then hidden when the toggle is on); `view(item)` annotates. */
export function partitionByReachability<T>(
  items: readonly T[],
  keyOf: (item: T) => ModelRef,
  snapshot: ReachabilitySnapshot | undefined,
  current?: ModelRef,
) {
  if (!snapshot) {
    const all = [...items]
    return {
      shown: all,
      hidden: [] as T[],
      hiddenCount: 0,
      list: (_showUnavailable: boolean) => all,
      view: (_item: T): ModelReachabilityView => PASSTHROUGH,
    }
  }

  const rows = new Map<string, ReachabilityModel>()
  const probed = new Set<string>()
  for (const m of snapshot.models) {
    rows.set(refKey({ providerID: m.provider, modelID: m.model }), m)
    if (m.status !== "unchecked") probed.add(m.provider)
  }
  for (const p of snapshot.providers) if (p.last_probe_at !== null) probed.add(p.provider)
  const currentKey = current ? refKey(current) : undefined

  const views = new Map<string, ModelReachabilityView>()
  const viewOf = (ref: ModelRef): ModelReachabilityView => {
    const k = refKey(ref)
    const cached = views.get(k)
    if (cached) return cached
    const row = rows.get(k)
    const status: ReachabilityStatus = row?.status ?? "unchecked"
    const reason = row?.reason ?? null
    const dead = DEAD.has(status) || (status === "unchecked" && probed.has(ref.providerID))
    const v: ModelReachabilityView = !dead
      ? {
          status,
          reason,
          hidden: false,
          greyed: false,
          tag: status === "ok" ? undefined : (status as "rate-limited" | "unchecked"),
        }
      : k === currentKey
        ? { status, reason, hidden: false, greyed: false, tag: "selected-dead" }
        : { status, reason, hidden: true, greyed: true, tag: undefined }
    views.set(k, v)
    return v
  }

  const shown: T[] = []
  const hidden: T[] = []
  for (const item of items) (viewOf(keyOf(item)).hidden ? hidden : shown).push(item)
  const revealed = [...shown, ...hidden]
  return {
    shown,
    hidden,
    hiddenCount: hidden.length,
    list: (showUnavailable: boolean) => (showUnavailable ? revealed : shown),
    view: (item: T) => viewOf(keyOf(item)),
  }
}

export type ReachabilityPartition<T> = ReturnType<typeof partitionByReachability<T>>

/** The human reason for a view (undefined for ok / passthrough). */
export function reachabilityReason(view: ModelReachabilityView): ReachabilityReason | undefined {
  switch (view.status) {
    case undefined:
    case "ok":
      return undefined
    case "denied":
      return { key: "dialog.model.reachability.reason.denied" }
    case "unavailable":
      return { key: "dialog.model.reachability.reason.unavailable" }
    case "invalid":
      return { key: "dialog.model.reachability.reason.invalid" }
    case "rate-limited":
      return { key: "dialog.model.reachability.reason.rateLimited" }
    case "unchecked":
      return { key: "dialog.model.reachability.reason.unchecked" }
    case "error":
      return view.reason ? { text: view.reason } : { key: "dialog.model.reachability.reason.error" }
  }
}

// amicode#1989 (#1979 S6): fail fast on a dead pick. PURE — no SolidJS, no
// fetch — so the demote / no-demote line and the switch-target rules are
// unit-tested. The wiring (POST demote, composer warning) lives in
// model-dead-pick-warning.tsx.
//
// Rules (the issue's):
//  - A session's failed assistant turn demotes its model only for a
//    reachability-class failure: denied / unavailable / invalid (the S1
//    classifyProbeError classes, overlay packages/opencode/src/provider/error.ts,
//    re-derived here from the serialized session error the app receives).
//    Rate limits, TLS / network faults, timeouts and 5xx are transient and
//    never demote.
//  - A demotion never overrides a probe verdict NEWER than the failure (the
//    S2 cache: "a demotion sticks until the next probe").
//  - The warning shows whenever the current model is dead per the snapshot
//    (probe or demotion), before sending as well as after a failed turn.
//  - Switch target: the first ok recommended model; else the cheapest-known ok
//    model of the same provider; else the cheapest-known ok model anywhere;
//    none ⇒ the warning still shows, without a switch offer. Only selectable
//    candidates (connected providers' catalog models) are ever offered.
import {
  reachabilityReason,
  type ModelRef,
  type ReachabilityModel,
  type ReachabilityReason,
  type ReachabilitySnapshot,
  type ReachabilityStatus,
} from "./dialog-select-model-reachability"
import { ROLE_ORDER, isAllowed, type ShortlistConfig } from "./dialog-select-model-shortlist"

export const REACHABILITY_DEMOTE_ROUTE = "/amicode/model-reachability/demote"

export type DemoteStatus = "denied" | "unavailable" | "invalid"

export type TurnFailure = {
  messageID: string
  ref: ModelRef
  status: DemoteStatus
  reason: string
  /** When the failed turn ended (engine clock, epoch ms). */
  at: number
}

export type DeadPickCandidate = ModelRef & { cost?: { input?: number; output?: number } }

export type DeadPickWarning = {
  model: ModelRef
  status: ReachabilityStatus
  reason: ReachabilityReason | undefined
  switchTo?: ModelRef
}

// The S1 patterns (packages/opencode/src/provider/error.ts, #1984) — kept in
// lockstep so a real failure and a probe name the same class.
const UNAVAILABLE =
  /not available for this account|aws[- ]marketplace|marketplace (subscription|agreement)|model access is denied|access to (this|the) model is not|not subscribed/i
const RATE_LIMITED = /throttl|too many requests|rate[- ]?limit|quota exceeded|tokens per (minute|day)/i
const INVALID =
  /validationexception|inference profile|on-demand throughput|invalid model|model identifier is invalid|model[_ ]not[_ ]found|unknown model|no such model|does not exist|is not supported|resourcenotfoundexception|ProviderModelNotFoundError|AI_NoSuchModelError/i
const DENIED =
  /accessdenied|access denied|not authorized|unauthorized|unrecognizedclient|forbidden|permission denied|invalid api key|invalid_api_key|security token/i
// Transient: never a verdict on the model. Checked before every demote class.
const TRANSIENT =
  /ERR_TLS|certificate|altnames|self[- ]signed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|ENETUNREACH|socket hang up|fetch failed|network|timed? ?out|TimeoutError|AbortError|service unavailable|overloaded/i

const NOT_REACHABILITY = new Set([
  "MessageAbortedError",
  "ContextOverflowError",
  "MessageOutputLengthError",
  "StructuredOutputError",
  "ContentFilterError",
])

const REASON_MAX = 240

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === "string" ? v : "")
const clip = (s: string) => (s.length > REASON_MAX ? `${s.slice(0, REASON_MAX - 1)}…` : s)

function header(headers: unknown, name: string) {
  if (!isObj(headers)) return ""
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? str(headers[key]) : ""
}

/** A session's failed-turn error → the demote class, or null (no demotion). */
export function classifyTurnError(error: unknown): { status: DemoteStatus; reason: string } | null {
  if (!isObj(error) || typeof error.name !== "string") return null
  const data = isObj(error.data) ? error.data : {}
  const message = str(data.message)
  if (NOT_REACHABILITY.has(error.name)) return null
  if (error.name === "ProviderAuthError") return { status: "denied", reason: clip(message || "authentication failed") }

  const status = typeof data.statusCode === "number" ? data.statusCode : undefined
  if (status !== undefined && (status === 408 || status === 429 || status >= 500)) return null
  const haystack = [error.name, message, header(data.responseHeaders, "x-amzn-errortype"), str(data.responseBody)].join(
    "\n",
  )
  if (TRANSIENT.test(haystack) || RATE_LIMITED.test(haystack)) return null
  const reason = clip(message || error.name)
  if (UNAVAILABLE.test(haystack)) return { status: "unavailable", reason }
  if (status === 404 || INVALID.test(haystack)) return { status: "invalid", reason }
  if (status === 401 || status === 403 || DENIED.test(haystack)) return { status: "denied", reason }
  return null
}

/** The session's LATEST assistant turn, when it failed with a demote class.
 *  An earlier failure followed by a good turn is history, not a dead pick. */
export function latestTurnFailure(messages: readonly unknown[]): TurnFailure | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!isObj(m) || m.role !== "assistant") continue
    if (typeof m.providerID !== "string" || typeof m.modelID !== "string" || typeof m.id !== "string") return undefined
    const got = classifyTurnError(m.error)
    if (!got) return undefined
    const time = isObj(m.time) ? m.time : {}
    const at =
      typeof time.completed === "number" ? time.completed : typeof time.created === "number" ? time.created : 0
    return { messageID: m.id, ref: { providerID: m.providerID, modelID: m.modelID }, ...got, at }
  }
  return undefined
}

const same = (a: ModelRef, b: ModelRef) => a.providerID === b.providerID && a.modelID === b.modelID
const rowOf = (snapshot: ReachabilitySnapshot | undefined, ref: ModelRef) =>
  snapshot?.models.find((m) => m.provider === ref.providerID && m.model === ref.modelID)
const fresher = (row: ReachabilityModel | undefined, failure: TurnFailure) =>
  !!row && row.checked_at !== null && row.checked_at > failure.at

/** POST the demotion? Not over a newer verdict, not twice for the same one. */
export function shouldDemote(failure: TurnFailure, snapshot: ReachabilitySnapshot | undefined): boolean {
  const row = rowOf(snapshot, failure.ref)
  if (fresher(row, failure)) return false
  if (row && row.source === "demoted" && row.status === failure.status) return false
  return true
}

/** The snapshot with the failure overlaid locally — the warning shows even
 *  when the demote POST fails or the host serves no reachability route. */
export function applyTurnFailure(
  snapshot: ReachabilitySnapshot | undefined,
  failure: TurnFailure | undefined,
): ReachabilitySnapshot | undefined {
  if (!failure) return snapshot
  const row = rowOf(snapshot, failure.ref)
  if (fresher(row, failure)) return snapshot
  const demoted: ReachabilityModel = {
    provider: failure.ref.providerID,
    model: failure.ref.modelID,
    status: failure.status,
    reason: failure.reason,
    latency_ms: null,
    checked_at: failure.at,
    credential_fp: row?.credential_fp ?? null,
    source: "demoted",
  }
  const base = snapshot ?? { catalog_known: false, models: [], providers: [] }
  return {
    ...base,
    models: row ? base.models.map((m) => (m === row ? demoted : m)) : [...base.models, demoted],
  }
}

/** The S2 demote route body. */
export function demoteRequest(failure: TurnFailure) {
  return {
    provider: failure.ref.providerID,
    model: failure.ref.modelID,
    status: failure.status,
    reason: failure.reason,
  }
}

/** Once per model per session. */
export function createDemoteGate() {
  const seen = new Set<string>()
  return {
    claim(sessionID: string, ref: ModelRef) {
      const key = `${sessionID}\u0000${ref.providerID}\u0000${ref.modelID}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  }
}

const DEAD: ReadonlySet<ReachabilityStatus> = new Set(["denied", "unavailable", "invalid", "error"])

const price = (c: DeadPickCandidate) =>
  c.cost && (typeof c.cost.input === "number" || typeof c.cost.output === "number")
    ? (c.cost.input ?? 0) + (c.cost.output ?? 0)
    : undefined

function cheapest(pool: readonly DeadPickCandidate[]): ModelRef | undefined {
  let best: DeadPickCandidate | undefined
  let bestPrice: number | undefined
  for (const c of pool) {
    const p = price(c)
    if (!best || (p !== undefined && (bestPrice === undefined || p < bestPrice))) {
      best = c
      bestPrice = p
    }
  }
  return best ? { providerID: best.providerID, modelID: best.modelID } : undefined
}

/** The composer's warning for the current model, or undefined when it is not
 *  known dead (ok / rate-limited / unchecked / no row / no snapshot). */
export function deadPickWarning(input: {
  current: ModelRef | undefined
  snapshot: ReachabilitySnapshot | undefined
  candidates: readonly DeadPickCandidate[]
  recommended?: readonly ModelRef[]
}): DeadPickWarning | undefined {
  const current = input.current
  if (!current || !input.snapshot) return undefined
  const row = rowOf(input.snapshot, current)
  if (!row || !DEAD.has(row.status)) return undefined
  const reason = reachabilityReason({
    status: row.status,
    reason: row.reason,
    hidden: false,
    greyed: false,
    tag: "selected-dead",
  })
  const model = { providerID: current.providerID, modelID: current.modelID }

  const ok = input.candidates.filter((c) => !same(c, current) && rowOf(input.snapshot, c)?.status === "ok")
  const recommended = (input.recommended ?? []).find((r) => ok.some((c) => same(c, r)))
  const switchTo = recommended
    ? { providerID: recommended.providerID, modelID: recommended.modelID }
    : (cheapest(ok.filter((c) => c.providerID === current.providerID)) ?? cheapest(ok))
  return switchTo ? { model, status: row.status, reason, switchTo } : { model, status: row.status, reason }
}

/** amicode#1988 (S5, the S6 follow-up): the S4 deployment config's recommended
 *  list as dead-pick switch targets — role order (default, fast, strong,
 *  open-weight), config order within a role, deduped, allowlist-filtered.
 *  No config ⇒ none (deadPickWarning falls back to the cheapest ok model). */
export function recommendedSwitchTargets(config: ShortlistConfig | undefined): ModelRef[] {
  const seen = new Set<string>()
  return ROLE_ORDER.flatMap((role) =>
    (config?.recommended ?? [])
      .filter((entry) => entry.role === role && isAllowed(entry.ref, config?.allowlist))
      .flatMap((entry) => {
        const key = `${entry.ref.providerID}\u0000${entry.ref.modelID}`
        if (seen.has(key)) return []
        seen.add(key)
        return [{ providerID: entry.ref.providerID, modelID: entry.ref.modelID }]
      }),
  )
}

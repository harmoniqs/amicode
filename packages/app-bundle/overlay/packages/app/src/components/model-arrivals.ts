// amicode#2000: model arrivals — the picker's "New" tag. PURE (no SolidJS, no
// fetch; the fetch is model-arrivals-source.ts). Data: GET /amicode/model-
// arrivals (the amicode service diffs each connected provider's catalog against
// a snapshot, probes the new ids, and records an event per arrival).
//
// Rules:
//  - Only an `available` arrival (callable now) is tagged; listed / needs-
//    allowlist / needs-agreement models are not selectable yet.
//  - "New" for NEW_TAG_MS (7 days) after first_seen_at — read or not: `seen`
//    only clears the inbox/badge, never the tag.
//  - Regional variants (us./global./eu./apac. + the same id) are one model: the
//    event names one representative; every variant of its base id is tagged.
import type { ModelRef } from "./dialog-select-model-reachability"

export const ARRIVALS_ROUTE = "/amicode/model-arrivals"
export const ARRIVALS_SEEN_ROUTE = "/amicode/model-arrivals/seen"

export const NEW_TAG_MS = 7 * 24 * 60 * 60 * 1000

export type ArrivalKind = "available" | "needs-allowlist" | "needs-agreement" | "listed"
const KINDS: readonly ArrivalKind[] = ["available", "needs-allowlist", "needs-agreement", "listed"]

export type ModelArrival = {
  id: string
  provider: string
  model: string
  status: string
  kind: ArrivalKind
  first_seen_at: number
  seen: boolean
  watch: boolean
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

const REGION_PREFIX = /^(?:us-gov|us|eu|apac|ap|global|jp|au|ca)\./

/** "us.anthropic.claude-x" → "anthropic.claude-x" (mirrors the service). */
export const baseModelId = (id: string) => id.replace(REGION_PREFIX, "")

/** Parse the GET body. undefined ⇒ no arrivals (route missing / ok:false). */
export function parseArrivalsResponse(raw: unknown): ModelArrival[] | undefined {
  if (!isObj(raw) || raw.ok !== true || !Array.isArray(raw.arrivals)) return undefined
  const out: ModelArrival[] = []
  for (const a of raw.arrivals) {
    if (!isObj(a) || typeof a.id !== "string" || typeof a.provider !== "string" || typeof a.model !== "string") continue
    if (!KINDS.includes(a.kind as ArrivalKind)) continue
    if (typeof a.first_seen_at !== "number" || !Number.isFinite(a.first_seen_at)) continue
    out.push({
      id: a.id,
      provider: a.provider,
      model: a.model,
      status: typeof a.status === "string" ? a.status : "unchecked",
      kind: a.kind as ArrivalKind,
      first_seen_at: a.first_seen_at,
      seen: a.seen === true,
      watch: a.watch === true,
    })
  }
  return out
}

const key = (provider: string, base: string) => `${provider}\u0000${base}`

/** The set of (provider, base id) that wear the "New" tag at `now`. */
export function newModelKeys(arrivals: readonly ModelArrival[] | undefined, now: number): Set<string> {
  const keys = new Set<string>()
  for (const a of arrivals ?? []) {
    if (a.kind !== "available") continue
    if (now - a.first_seen_at < 0 || now - a.first_seen_at >= NEW_TAG_MS) continue
    keys.add(key(a.provider, baseModelId(a.model)))
  }
  return keys
}

export const isNewModel = (keys: ReadonlySet<string>, ref: ModelRef) =>
  keys.has(key(ref.providerID, baseModelId(ref.modelID)))

// amicode#1766 — the app's FLEET session-status re-seed client (pure; no imports,
// so it is unit-testable without Solid and loadable by the service's vitest
// end-to-end test).
//
// A peer session's busy/idle reaches this app only through the live event
// fan-in, which does not replay on reconnect; the old re-seed asked only the
// LOCAL engine, without a directory, and learned nothing. The fleet read
// (GET /amicode/fleet/session-status?ids=…) resolves each pinned session's owner
// and directory service-side and returns one tri-state map: every COVERED
// session has an explicit status (idle by absence), every uncovered one is
// OMITTED. Applied through the store's recency-guarded reconcile, an explicit
// idle settles a stale busy and an omission preserves the current value.
//
// When the read is unavailable (not served on a machine without fleet peers,
// refused, a network error, a timeout, or a body that is not the documented
// shape) the app performs TODAY's local re-seed, unchanged — silently for the
// expected not-served 404, with a rate-limited per-cause diagnostic otherwise.

export const FLEET_SESSION_STATUS_ROUTE = "/amicode/fleet/session-status"
/** The client-side bound on one fleet read: above the service's 3 s deadline,
 *  below the 10 s self-heal cadence, so a hung read can never block later ones. */
export const FLEET_READ_TIMEOUT_MS = 5000
/** One diagnostic per cause per window. */
export const FLEET_DIAGNOSTIC_WINDOW_MS = 60_000

/** The engine's SessionStatus union, as the fleet read passes it through. */
export type FleetSessionStatus =
  | { type: "idle" }
  | { type: "busy" }
  | { type: "retry"; attempt: number; message: string; next: number; action?: Record<string, unknown> }

export type FleetUnresolvedReason = "unknown" | "no-directory" | "over-cap"
export type FleetUnresolved = { id: string; reason: FleetUnresolvedReason }

export type FleetDirectoryRecord = { ok: boolean; reason?: string; detail?: string; sessions?: number }
export type FleetSourceRecord = {
  present?: boolean
  reason?: string
  directories: Record<string, FleetDirectoryRecord>
}

export type FleetFallbackCause = "not-served" | "not-found" | "refused" | "http-error" | "network" | "timeout" | "bad-shape"

export type FleetParseResult =
  | {
      kind: "ok"
      statuses: Record<string, FleetSessionStatus>
      unresolved: FleetUnresolved[]
      sources: Record<string, FleetSourceRecord>
      /** How many individual invalid entries were dropped. */
      dropped: number
    }
  | { kind: "fallback"; cause: FleetFallbackCause; silent: boolean; detail?: string }

/** The request route: the ids as ONE comma-separated `ids` query value, order
 *  significant (the viewed session first). */
export function fleetSessionStatusRoute(ids: readonly string[]): string {
  return `${FLEET_SESSION_STATUS_ROUTE}?ids=${encodeURIComponent(ids.join(","))}`
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const isNonNegativeInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0

/** Validate ONE status entry against the engine's SessionStatus union (excess
 *  keys ignored, only documented fields kept). Undefined ⇒ invalid. */
export function parseSessionStatusEntry(entry: unknown): FleetSessionStatus | undefined {
  if (!isPlainObject(entry)) return undefined
  if (entry.type === "idle") return { type: "idle" }
  if (entry.type === "busy") return { type: "busy" }
  if (entry.type === "retry") {
    const { attempt, message, next, action } = entry
    if (!isNonNegativeInt(attempt) || typeof message !== "string" || !isNonNegativeInt(next)) return undefined
    if (action !== undefined && !isPlainObject(action)) return undefined
    return { type: "retry", attempt, message, next, ...(action !== undefined ? { action } : {}) }
  }
  return undefined
}

const UNRESOLVED_REASONS = new Set<string>(["unknown", "no-directory", "over-cap"])

/** Parse a fleet read response. Anything other than a 200 with the documented
 *  top-level shape is a fallback (404 `no-fleet-peers` silently; anything else
 *  diagnosed). Inside a documented body, an individual invalid entry is DROPPED
 *  (the others kept) — never a whole-body rejection. */
export function parseFleetStatusResponse(status: number, body: unknown): FleetParseResult {
  if (status === 404) {
    if (isPlainObject(body) && body.reason === "no-fleet-peers") return { kind: "fallback", cause: "not-served", silent: true }
    return { kind: "fallback", cause: "not-found", silent: false, detail: "HTTP 404" }
  }
  if (status === 401 || status === 403) return { kind: "fallback", cause: "refused", silent: false, detail: `HTTP ${status}` }
  if (status !== 200) return { kind: "fallback", cause: "http-error", silent: false, detail: `HTTP ${status}` }
  if (
    !isPlainObject(body) ||
    body.ok !== true ||
    !isPlainObject(body.statuses) ||
    !Array.isArray(body.unresolved) ||
    (body.sources !== undefined && !isPlainObject(body.sources))
  ) {
    return { kind: "fallback", cause: "bad-shape", silent: false, detail: "response is not the documented shape" }
  }
  let dropped = 0
  const statuses: Record<string, FleetSessionStatus> = {}
  for (const [id, entry] of Object.entries(body.statuses)) {
    const parsed = parseSessionStatusEntry(entry)
    if (parsed) statuses[id] = parsed
    else dropped++
  }
  const unresolved: FleetUnresolved[] = []
  for (const entry of body.unresolved) {
    if (isPlainObject(entry) && typeof entry.id === "string" && typeof entry.reason === "string" && UNRESOLVED_REASONS.has(entry.reason)) {
      unresolved.push({ id: entry.id, reason: entry.reason as FleetUnresolvedReason })
    } else dropped++
  }
  const sources: Record<string, FleetSourceRecord> = {}
  for (const [machine, rec] of Object.entries(isPlainObject(body.sources) ? body.sources : {})) {
    if (!isPlainObject(rec) || !isPlainObject(rec.directories)) continue
    const directories: Record<string, FleetDirectoryRecord> = {}
    for (const [dir, d] of Object.entries(rec.directories)) {
      if (isPlainObject(d) && typeof d.ok === "boolean") {
        directories[dir] = {
          ok: d.ok,
          ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
          ...(typeof d.detail === "string" ? { detail: d.detail } : {}),
          ...(typeof d.sessions === "number" ? { sessions: d.sessions } : {}),
        }
      }
    }
    sources[machine] = {
      ...(typeof rec.present === "boolean" ? { present: rec.present } : {}),
      ...(typeof rec.reason === "string" ? { reason: rec.reason } : {}),
      directories,
    }
  }
  return { kind: "ok", statuses, unresolved, sources, dropped }
}

// ── diagnostics ─────────────────────────────────────────────────────────────

export type FleetDiagnostics = { report(cause: string, message: string): void }

/** A rate-limited console diagnostic: at most one warning per cause per window. */
export function createFleetDiagnostics(opts: {
  warn?: (message: string) => void
  now?: () => number
  windowMs?: number
} = {}): FleetDiagnostics {
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const now = opts.now ?? Date.now
  const windowMs = opts.windowMs ?? FLEET_DIAGNOSTIC_WINDOW_MS
  const last = new Map<string, number>()
  return {
    report(cause, message) {
      const t = now()
      const prev = last.get(cause)
      if (prev !== undefined && t - prev < windowMs) return
      last.set(cause, t)
      warn(`[amicode] fleet session-status re-seed: ${cause} — ${message}`)
    },
  }
}

// ── one re-seed ─────────────────────────────────────────────────────────────

export type FleetReseedDeps = {
  /** Issue the fleet read for `ids` (one comma-separated `ids` parameter) with
   *  the service credential; resolve the HTTP status + parsed JSON body (body
   *  undefined when not JSON). Rejects on a network error. */
  fetchFleet: (ids: readonly string[], signal: AbortSignal) => Promise<{ status: number; body: unknown }>
  /** The store's recency-guarded reconcile. */
  reconcile: (statuses: Record<string, FleetSessionStatus>, opts: { fetchedAt: number }) => void
  /** Today's local `/session/status` re-seed, unchanged. */
  localReseed: () => Promise<void>
  diagnostics: FleetDiagnostics
  now?: () => number
  /** Client timeout (default FLEET_READ_TIMEOUT_MS). */
  timeoutMs?: number
}

export type FleetReseedOutcome =
  | { kind: "applied"; result: Extract<FleetParseResult, { kind: "ok" }> }
  | { kind: "fallback"; cause: FleetFallbackCause }

/** One fleet re-seed: issue the read (timestamped BEFORE the request so the
 *  store's recency guard can refuse a downgrade of a busy mutated after it),
 *  bound it by the client timeout (a late response is DISCARDED, never
 *  applied), and apply the documented map through the reconcile — or fall back
 *  to today's local re-seed. Never throws. */
export async function runFleetReseed(ids: readonly string[], deps: FleetReseedDeps): Promise<FleetReseedOutcome> {
  const now = deps.now ?? Date.now
  const fetchedAt = now()
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve("timeout")
    }, deps.timeoutMs ?? FLEET_READ_TIMEOUT_MS)
  })
  let parsed: FleetParseResult
  try {
    const raced = await Promise.race([deps.fetchFleet(ids, controller.signal), timedOut])
    parsed =
      raced === "timeout"
        ? { kind: "fallback", cause: "timeout", silent: false, detail: `no answer within ${deps.timeoutMs ?? FLEET_READ_TIMEOUT_MS} ms` }
        : parseFleetStatusResponse(raced.status, raced.body)
  } catch (err) {
    parsed = controller.signal.aborted
      ? { kind: "fallback", cause: "timeout", silent: false, detail: "aborted at the client timeout" }
      : { kind: "fallback", cause: "network", silent: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (parsed.kind === "ok") {
    deps.reconcile(parsed.statuses, { fetchedAt })
    return { kind: "applied", result: parsed }
  }
  if (!parsed.silent) deps.diagnostics.report(parsed.cause, parsed.detail ?? "fleet read unavailable; local re-seed")
  try {
    await deps.localReseed()
  } catch {
    // A failed local re-seed is non-fatal — the next trigger retries.
  }
  return { kind: "fallback", cause: parsed.cause }
}

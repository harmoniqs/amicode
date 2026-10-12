// amicode#1766 — the fleet session-status RE-SEED SCHEDULER (pure; timers and
// every input injected, so it is fake-clock testable without Solid).
//
// Triggers (each sends the pinned ids, the viewed session first, to the fleet
// read and applies the answer through the recency-guarded reconcile):
//   - the event stream's CONNECTED edge and a SYNC-GAP frame (the #1637 edges);
//   - a NEWLY PINNED session, debounced (covers tabs restored after the
//     connected edge already fired);
//   - `unknown` RETRIES: an answer listing a pinned id as unresolved `unknown`
//     (the service's owner map may lag a cold start) re-tries after 2 s, at most
//     3 times per trigger;
//   - the SELF-HEAL tick: every 10 s while connected AND visible, with pinned
//     sessions, on a machine where the read is served.
// Discipline: single-flight (a trigger during a flight sets a pending flag that
// runs exactly ONE more re-seed when the current one settles); each read is
// bounded by the client timeout inside runFleetReseed; teardown stops all of it.
// Diagnostics: 3 consecutive re-seeds in which EVERY requested id was omitted or
// unresolved, and a partial failure persisting 3 consecutive re-seeds for the
// same (owner, directory).
import type { FleetDiagnostics, FleetReseedOutcome, FleetTimers } from "./fleet-session-status"
import { defaultFleetTimers } from "./fleet-session-status"

export const FLEET_RESEED_INTERVAL_MS = 10_000
export const FLEET_PIN_DEBOUNCE_MS = 500
export const FLEET_UNKNOWN_RETRY_MS = 2000
export const FLEET_UNKNOWN_RETRY_MAX = 3
/** Consecutive re-seeds before the all-omitted / partial-failure diagnostics. */
export const FLEET_FAILURE_STREAK = 3

export type FleetReseedTrigger = "connected" | "gap"
type RunKind = "edge" | "tick" | "pin" | "retry"

export type FleetReseedSchedulerDeps = {
  /** The currently pinned session ids (every open tab's + the viewed one). */
  pinnedIds: () => readonly string[]
  /** The viewed session id, if any — sent first. */
  viewedId?: () => string | undefined
  /** One fleet re-seed (runFleetReseed); `signal` aborts on teardown. */
  reseed: (ids: readonly string[], signal: AbortSignal) => Promise<FleetReseedOutcome>
  /** Today's local re-seed — the edges' behavior when nothing is pinned. */
  localReseed: () => Promise<void>
  isConnected: () => boolean
  isVisible: () => boolean
  diagnostics: FleetDiagnostics
  timers?: FleetTimers
  now?: () => number
  intervalMs?: number
  pinDebounceMs?: number
  unknownRetryMs?: number
  unknownRetryMax?: number
}

export type FleetReseedScheduler = {
  /** Arm the self-heal tick. */
  start(): void
  /** Teardown: clear every timer, cancel the in-flight read, ignore triggers. */
  stop(): void
  /** A connected edge or a sync-gap frame. */
  trigger(reason: FleetReseedTrigger): void
  /** A session became newly pinned (debounced re-seed). */
  notePinned(sessionID: string): void
}

/** The viewed session id from the app location (both the server-keyed
 *  `/server/<key>/session/<id>` and the legacy `/<dir>/session/<id>` routes,
 *  path- or hash-routed). */
export function viewedSessionIdFromLocation(href: string): string | undefined {
  return href.match(/\/session\/([^/?#]+)/)?.[1]
}

export function createFleetReseedScheduler(deps: FleetReseedSchedulerDeps): FleetReseedScheduler {
  const timers = deps.timers ?? defaultFleetTimers
  const intervalMs = deps.intervalMs ?? FLEET_RESEED_INTERVAL_MS
  const pinDebounceMs = deps.pinDebounceMs ?? FLEET_PIN_DEBOUNCE_MS
  const unknownRetryMs = deps.unknownRetryMs ?? FLEET_UNKNOWN_RETRY_MS
  const unknownRetryMax = deps.unknownRetryMax ?? FLEET_UNKNOWN_RETRY_MAX
  const teardown = new AbortController()

  let stopped = false
  let inFlight = false
  /** The coalesced follow-up (an edge outranks the others: it may need the
   *  no-pins local re-seed). */
  let pending: RunKind | undefined
  /** Set once the read answered its expected not-served 404 (a machine without
   *  fleet peers): the periodic and pin-driven re-seeds stand down so the app
   *  keeps today's behavior; the edges still re-probe. */
  let notServed = false
  let tickTimer: unknown
  let debounceTimer: unknown
  let retryTimer: unknown
  let retriesLeft = 0
  let allOmittedStreak = 0
  const partialStreak = new Map<string, number>()
  /** Cap fairness: when each id last got a status (a monotonic sequence). */
  const lastReseeded = new Map<string, number>()
  let reseedSeq = 0

  const orderedIds = (): string[] => {
    const pins = [...new Set(deps.pinnedIds())]
    const viewed = deps.viewedId?.()
    const rest = pins.filter((id) => id !== viewed)
    // least-recently-reseeded first (never-reseeded ids first); a stable sort
    // keeps the pin order among ties
    rest.sort((a, b) => (lastReseeded.get(a) ?? -1) - (lastReseeded.get(b) ?? -1))
    return viewed !== undefined && pins.includes(viewed) ? [viewed, ...rest] : rest
  }

  const observe = (ids: readonly string[], outcome: FleetReseedOutcome, kind: RunKind): void => {
    // per TRIGGER: a fresh trigger (an edge or a new pin) re-arms the retry
    // budget and supersedes any retry still waiting. A self-heal TICK does not:
    // it is already the periodic re-read, and re-arming on every tick would make
    // a permanently-`unknown` pinned id (a deleted session, a peer that stopped
    // serving) cost the tick's read + every retry, each interval (PR #1768 review).
    if (kind === "edge" || kind === "pin") {
      if (retryTimer !== undefined) timers.clearTimeout(retryTimer)
      retryTimer = undefined
      retriesLeft = unknownRetryMax
    }
    if (outcome.kind === "fallback") {
      if (outcome.cause === "not-served") notServed = true
      return
    }
    if (outcome.kind !== "applied") return
    notServed = false
    const { statuses, unresolved, sources } = outcome.result
    // cap fairness bookkeeping
    let covered = 0
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(statuses, id)) {
        covered++
        lastReseeded.set(id, ++reseedSeq)
      }
    }
    // every requested id omitted or unresolved, 3 re-seeds running
    allOmittedStreak = covered === 0 ? allOmittedStreak + 1 : 0
    if (allOmittedStreak >= FLEET_FAILURE_STREAK) {
      deps.diagnostics.report(
        "all-omitted",
        `${allOmittedStreak} consecutive re-seeds covered none of the ${ids.length} pinned session(s)`,
      )
    }
    // a partial failure persisting for the same (owner, directory)
    const failing = new Set<string>()
    for (const [machine, rec] of Object.entries(sources)) {
      for (const [dir, d] of Object.entries(rec.directories)) {
        if (d.ok) continue
        const key = `${machine}\u0000${dir}`
        failing.add(key)
        const n = (partialStreak.get(key) ?? 0) + 1
        partialStreak.set(key, n)
        if (n >= FLEET_FAILURE_STREAK) {
          deps.diagnostics.report(
            `partial-failure ${machine} ${dir}`,
            `${machine} ${dir}: ${d.reason ?? "failed"}${d.detail ? ` (${d.detail})` : ""} for ${n} consecutive re-seeds`,
          )
        }
      }
    }
    for (const key of [...partialStreak.keys()]) if (!failing.has(key)) partialStreak.delete(key)
    // a cold owner map: retry shortly while a pinned id is still `unknown`
    const pinned = new Set(ids)
    const unknown = unresolved.some((u) => u.reason === "unknown" && pinned.has(u.id))
    if (unknown && retriesLeft > 0) {
      retriesLeft--
      retryTimer = timers.setTimeout(() => {
        retryTimer = undefined
        request("retry")
      }, unknownRetryMs)
    }
  }

  const run = async (kind: RunKind): Promise<void> => {
    const ids = orderedIds()
    if (ids.length === 0) {
      // nothing displayed to re-seed: the edges keep today's local re-seed;
      // the self-heal / pin / retry paths simply skip
      if (kind === "edge") {
        try {
          await deps.localReseed()
        } catch {
          // non-fatal — the next edge retries
        }
      }
      return
    }
    inFlight = true
    let outcome: FleetReseedOutcome
    try {
      outcome = await deps.reseed(ids, teardown.signal)
    } catch {
      outcome = { kind: "fallback", cause: "network" }
    } finally {
      inFlight = false
    }
    if (stopped) return
    observe(ids, outcome, kind)
    if (pending !== undefined) {
      const next = pending
      pending = undefined
      request(next)
    }
  }

  const request = (kind: RunKind): void => {
    if (stopped) return
    if (inFlight) {
      pending = pending === "edge" || kind === "edge" ? "edge" : kind
      return
    }
    void run(kind)
  }

  const armTick = (): void => {
    tickTimer = timers.setTimeout(() => {
      tickTimer = undefined
      if (stopped) return
      armTick() // a fixed cadence; a hung read cannot block it (client timeout)
      if (notServed || !deps.isConnected() || !deps.isVisible()) return
      if (deps.pinnedIds().length === 0) return
      request("tick")
    }, intervalMs)
  }

  return {
    start() {
      if (stopped || tickTimer !== undefined) return
      armTick()
    },
    stop() {
      stopped = true
      pending = undefined
      for (const t of [tickTimer, debounceTimer, retryTimer]) if (t !== undefined) timers.clearTimeout(t)
      tickTimer = debounceTimer = retryTimer = undefined
      teardown.abort()
    },
    trigger() {
      request("edge")
    },
    notePinned() {
      if (stopped) return
      if (debounceTimer !== undefined) timers.clearTimeout(debounceTimer)
      debounceTimer = timers.setTimeout(() => {
        debounceTimer = undefined
        if (notServed || !deps.isConnected()) return
        request("pin")
      }, pinDebounceMs)
    },
  }
}

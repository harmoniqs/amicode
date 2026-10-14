// ── #1798 Phase A: SSE heartbeat tick telemetry + the out-of-tree self-stall watchdog ──
//
// The heartbeat tick contract (#1760 lesson, one level deeper, stated here where
// the next wire-contract change trips it): while the engine is healthy, every
// live SSE connection on the instance /event route receives a `server.heartbeat`
// once per cadence (10s in production), and each emission logs one SSE-TICK
// telemetry line. Heartbeats on the connection are the ONLY valid liveness
// signal — HTTP health is NOT a stall signal: /config stayed fast through every
// observed stall, and any detector keyed on HTTP health conflates
// new-connection health with existing-stream health (the reverted 2026-10-13
// mistake, recorded on #1798).
//
// INVARIANT — the observation channel must not share the failure domain with
// the observed system. The SELF-STALL watchdog below is a RAW Bun timer with
// zero Effect involvement: the #775 wedge was the Effect runLoop, and a
// watchdog living in the fiber tree wedges with it and observes nothing. This
// module must never import from Effect.
//
// Discriminator payload (#1798 hypothesis ladder — one natural occurrence must
// discriminate all three):
//   - queue_depth on every tick line and the last-seen depth on the SELF-STALL
//     line → hypothesis 1, blocked shared emit loop (depth grows/sticks at
//     stall onset while emission stops).
//   - lag_ms (event-loop drift probe) on both lines → hypothesis 2, Effect
//     scheduler starvation (lag spikes at stall).
//   - rss_bytes on both lines → hypothesis 3, listener/queue leak (slope rises
//     before the stall). Sampled in-line here at tick time; the #1717 watchdog
//     keeps sampling RSS shard-wide on its own interval from outside —
//     referenced, not duplicated.

export interface TickTelemetryConfig {
  /** Heartbeat cadence: one server.heartbeat per live SSE connection per window. */
  readonly cadenceMs: number
  /**
   * Watchdog check interval. Must cover a full cadence so a check window with
   * zero ticks implies a silent tick source; clamped up to cadenceMs otherwise.
   */
  readonly watchdogIntervalMs: number
  /** Event-loop drift probe interval. */
  readonly probeIntervalMs: number
  /** Line sink. Default: console.log — engine stdout, which journald captures. */
  readonly sink?: (line: string) => void
  /** Clock for tests. Default: Date.now. */
  readonly now?: () => number
}

// Production cadence 10s (the frontdoor cadence telemetry counts 3 ticks/30s on
// member-bearing upstreams); the watchdog checks every 15s, so the worst-case
// since-last-tick at the first SELF-STALL fire is watchdogIntervalMs + cadenceMs
// = 25s — inside the 30s both-ends agreement window of the #1748/#1758 cadence
// telemetry (both_ends_timestamp_delta_s <= 30). Exported so the harness can
// pin that guarantee structurally.
export const defaultTickTelemetryConfig: TickTelemetryConfig = {
  cadenceMs: 10_000,
  watchdogIntervalMs: 15_000,
  probeIntervalMs: 1_000,
}

export interface SseTickTelemetry {
  readonly cadenceMs: number
  /**
   * Watchdog check interval — also the ceiling the fan-out write stall bound
   * derives from (#1798 phase C): a stalled subscriber must be dropped well
   * before the watchdog could declare the tick source silent, so the engine
   * heals itself instead of naming its own death.
   */
  readonly watchdogIntervalMs: number
  registerConnection(route: string, connId: string): void
  unregisterConnection(connId: string): void
  noteTick(route: string, connId: string, state: { queueDepth: number; fiberId: number }): void
  /**
   * #1798 phase C: name a dropped connection in telemetry and unregister it.
   * Called by the bounded fan-out write path when a subscriber's write stalls
   * past the stall bound — an explicit drop line beats a silent eviction.
   */
  noteDrop(
    route: string,
    connId: string,
    state: { reason: string; eventQueueDepth: number; writeQueueDepth: number },
  ): void
  /** Last event-loop drift sample, in ms. */
  eventLoopLagMs(): number
  rssBytes(): number
  stop(): void
  /** Test/ops introspection: live connection count and the process-wide last tick time. */
  snapshot(): { connections: number; lastTickAt: number | undefined }
}

export function makeSseTickTelemetry(config: TickTelemetryConfig): SseTickTelemetry {
  const cadenceMs = Math.max(1, config.cadenceMs)
  const watchdogIntervalMs = Math.max(config.watchdogIntervalMs, cadenceMs)
  const sink = config.sink ?? ((line: string) => console.log(line))
  const now = config.now ?? (() => Date.now())

  interface Connection {
    readonly route: string
    readonly registeredAt: number
    lastTickAt: number | undefined
    queueDepth: number
    fiberId: number
  }
  const connections = new Map<string, Connection>()
  let seen = 0
  let lastTickAt: number | undefined
  let started = false
  let stopped = false
  let lagMs = 0
  let expectedAt = now()
  let watchdogTimer: ReturnType<typeof setInterval> | undefined
  let probeTimer: ReturnType<typeof setInterval> | undefined

  const rssBytes = () => process.memoryUsage().rss

  const start = () => {
    if (started || stopped) return
    started = true
    // Event-loop lag probe: drift between a raw timer's expected and actual fire
    // time. Raw Bun timer on purpose — Effect's clock shares the failure domain
    // under test (the same reasoning as the watchdog).
    probeTimer = setInterval(() => {
      const t = now()
      lagMs = Math.max(0, t - expectedAt)
      expectedAt = t + config.probeIntervalMs
    }, config.probeIntervalMs)
    probeTimer.unref?.()
    // The SELF-STALL watchdog: a raw Bun timer outside the Effect fiber tree.
    // Fires only while live connections exist and a full check window passed
    // with zero ticks from any of them — the tick source went silent, and the
    // engine names its own death instead of being inferred dead from the
    // frontdoor.
    watchdogTimer = setInterval(() => {
      const t = now()
      const expected = Math.ceil(watchdogIntervalMs / cadenceMs)
      const conns = connections.size
      if (conns > 0 && seen === 0) {
        // Grace: a connection registered inside this window may legitimately
        // not have ticked yet (its first heartbeat lands at cadenceMs). Only a
        // window fully covered by live connections counts as silence.
        const covered = connections.size > 0 && [...connections.values()].every((c) => t - c.registeredAt >= cadenceMs)
        if (covered) {
          const firstRegistered = Math.min(...[...connections.values()].map((c) => c.registeredAt))
          const sinceMs = lastTickAt === undefined ? t - firstRegistered : t - lastTickAt
          const routes = [...new Set([...connections.values()].map((c) => c.route))].join(",")
          const lastDepth = Math.max(...[...connections.values()].map((c) => c.queueDepth))
          sink(
            `SELF-STALL ticks_expected=${expected} seen=${seen} conns=${conns} route=${routes} ` +
              `since_last_tick_ms=${Math.round(sinceMs)} last_queue_depth=${lastDepth} ` +
              `lag_ms=${Math.round(lagMs)} rss_bytes=${rssBytes()} ts_ms=${t}`,
          )
        }
      }
      seen = 0
    }, watchdogIntervalMs)
    watchdogTimer.unref?.()
  }

  return {
    cadenceMs,
    watchdogIntervalMs,
    registerConnection(route, connId) {
      start()
      connections.set(connId, { route, registeredAt: now(), lastTickAt: undefined, queueDepth: -1, fiberId: -1 })
    },
    unregisterConnection(connId) {
      connections.delete(connId)
    },
    noteTick(route, connId, state) {
      const t = now()
      const connection = connections.get(connId)
      if (connection !== undefined) {
        connection.lastTickAt = t
        connection.queueDepth = state.queueDepth
        connection.fiberId = state.fiberId
      }
      seen++
      lastTickAt = t
      sink(
        `SSE-TICK route=${route} conn=${connId} cadence_ms=${cadenceMs} ` +
          `queue_depth=${state.queueDepth} fiber=${state.fiberId} ` +
          `lag_ms=${Math.round(lagMs)} rss_bytes=${rssBytes()} ts_ms=${t}`,
      )
    },
    noteDrop(route, connId, state) {
      const t = now()
      const connection = connections.get(connId)
      const sinceLastTickMs = connection?.lastTickAt === undefined ? -1 : t - connection.lastTickAt
      connections.delete(connId)
      sink(
        `SSE-DROP route=${route} conn=${connId} reason=${state.reason} ` +
          `since_last_tick_ms=${Math.round(sinceLastTickMs)} ` +
          `event_queue_depth=${state.eventQueueDepth} write_queue_depth=${state.writeQueueDepth} ` +
          `lag_ms=${Math.round(lagMs)} rss_bytes=${rssBytes()} ts_ms=${t}`,
      )
    },
    eventLoopLagMs() {
      return lagMs
    },
    rssBytes,
    stop() {
      stopped = true
      if (watchdogTimer !== undefined) clearInterval(watchdogTimer)
      if (probeTimer !== undefined) clearInterval(probeTimer)
      watchdogTimer = undefined
      probeTimer = undefined
    },
    snapshot() {
      return { connections: connections.size, lastTickAt }
    },
  }
}

// Process-wide singleton. Timers start lazily on the first registered SSE
// connection, so processes that never serve SSE (CLI, TUI) pay nothing.
export let sseTickTelemetry: SseTickTelemetry = makeSseTickTelemetry(defaultTickTelemetryConfig)

/** Test seam: swap the singleton (fast cadence + captured sink) for the route's. */
export function setSseTickTelemetry(next: SseTickTelemetry) {
  sseTickTelemetry = next
}

/** Test seam: restore the production singleton. */
export function resetSseTickTelemetry() {
  sseTickTelemetry = makeSseTickTelemetry(defaultTickTelemetryConfig)
}

export * as SseTickTelemetry from "./sse-tick-telemetry"

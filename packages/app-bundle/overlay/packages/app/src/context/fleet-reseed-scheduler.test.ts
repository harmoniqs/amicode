import { describe, expect, test } from "bun:test"
import {
  FLEET_RESEED_INTERVAL_MS,
  FLEET_PIN_DEBOUNCE_MS,
  FLEET_UNKNOWN_RETRY_MS,
  FLEET_UNKNOWN_RETRY_MAX,
  createFleetReseedScheduler,
  viewedSessionIdFromLocation,
  type FleetReseedSchedulerDeps,
} from "./fleet-reseed-scheduler"
import { createFleetDiagnostics, runFleetReseed, type FleetReseedOutcome } from "./fleet-session-status"

// amicode#1766 checkpoint 5 — the fleet re-seed TRIGGERS (connected edge, gap
// frame, debounced new pin, `unknown` retries) and the 10 s SELF-HEAL scheduler
// (visibility-gated, single-flight with pending coalescing, no-pins skip,
// consecutive-failure diagnostics, teardown) — driven by an injected fake clock.

// ── a deterministic fake clock for the injected timers ───────────────────────
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    now: () => now,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq
        timers.set(id, { at: now + Math.max(0, ms), fn })
        return id
      },
      clearTimeout: (id: unknown) => {
        timers.delete(id as number)
      },
    },
    pending: () => timers.size,
    async advance(ms: number) {
      const target = now + ms
      await flush()
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | undefined
        for (const e of timers) if (e[1].at <= target && (!next || e[1].at < next[1].at)) next = e
        if (!next) break
        timers.delete(next[0])
        now = next[1].at
        next[1].fn()
        await flush()
      }
      now = target
      await flush()
    },
    flush,
  }
}

const applied = (requested: readonly string[], over: { statuses?: Record<string, unknown>; unresolved?: Array<{ id: string; reason: string }>; sources?: Record<string, unknown> } = {}): FleetReseedOutcome =>
  ({
    kind: "applied",
    result: {
      kind: "ok",
      statuses: over.statuses ?? Object.fromEntries(requested.map((id) => [id, { type: "idle" }])),
      unresolved: over.unresolved ?? [],
      sources: over.sources ?? {},
      dropped: 0,
    },
  }) as FleetReseedOutcome

/** A harness: scripted reseed results, observable calls, controllable gates. */
function harness(over: Partial<FleetReseedSchedulerDeps> & { pins?: string[]; respond?: (ids: readonly string[], n: number) => FleetReseedOutcome | Promise<FleetReseedOutcome> } = {}) {
  const clock = fakeClock()
  const state = { pins: over.pins ?? ["ses_a", "ses_b"], connected: true, visible: true, viewed: undefined as string | undefined }
  const calls: string[][] = []
  const local: number[] = []
  const warned: string[] = []
  let inFlight = 0
  let maxInFlight = 0
  const deps: FleetReseedSchedulerDeps = {
    pinnedIds: () => state.pins,
    viewedId: () => state.viewed,
    reseed: async (ids) => {
      calls.push([...ids])
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        return await (over.respond ?? ((i) => applied(i)))(ids, calls.length)
      } finally {
        inFlight--
      }
    },
    localReseed: async () => {
      local.push(clock.now())
    },
    isConnected: () => state.connected,
    isVisible: () => state.visible,
    diagnostics: createFleetDiagnostics({ warn: (m) => warned.push(m), now: clock.now, windowMs: 1 }),
    timers: clock.timers,
    now: clock.now,
    ...over,
  }
  const scheduler = createFleetReseedScheduler(deps)
  return { clock, state, calls, local, warned, scheduler, maxInFlight: () => maxInFlight }
}

describe("#1766 — fleet re-seed triggers", () => {
  test("the connected edge and a gap frame each run a fleet re-seed of the pinned ids immediately", async () => {
    const h = harness()
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls).toEqual([["ses_a", "ses_b"]])
    h.scheduler.trigger("gap")
    await h.clock.flush()
    expect(h.calls).toHaveLength(2)
  })

  test("the viewed session is sent FIRST", async () => {
    const h = harness({ pins: ["ses_a", "ses_b", "ses_c"] })
    h.state.viewed = "ses_c"
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls[0]).toEqual(["ses_c", "ses_a", "ses_b"])
  })

  test("a viewed id that is not pinned is never added", async () => {
    const h = harness({ pins: ["ses_a"] })
    h.state.viewed = "ses_x"
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls[0]).toEqual(["ses_a"])
  })

  test("after the viewed one, ids go least-recently-reseeded first (an id left uncovered moves to the front)", async () => {
    const h = harness({
      pins: ["s1", "s2", "s3"],
      // the first read covers only s1 (s2, s3 omitted — e.g. past a cap)
      respond: (ids, n) => (n === 1 ? applied(ids, { statuses: { s1: { type: "idle" } } }) : applied(ids)),
    })
    h.scheduler.trigger("connected")
    await h.clock.flush()
    h.scheduler.trigger("gap")
    await h.clock.flush()
    expect(h.calls[1]).toEqual(["s2", "s3", "s1"])
  })

  test(`a NEWLY pinned session triggers a re-seed debounced by ${FLEET_PIN_DEBOUNCE_MS} ms (a burst of pins → one read)`, async () => {
    const h = harness()
    h.scheduler.start()
    h.scheduler.notePinned("ses_a")
    await h.clock.advance(FLEET_PIN_DEBOUNCE_MS - 1)
    h.scheduler.notePinned("ses_b") // restarts the debounce
    await h.clock.advance(FLEET_PIN_DEBOUNCE_MS - 1)
    expect(h.calls).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.calls).toHaveLength(1)
    h.scheduler.stop()
  })

  test("a no-pins connected edge / gap frame performs today's LOCAL re-seed (no fleet read)", async () => {
    const h = harness({ pins: [] })
    h.scheduler.trigger("connected")
    h.scheduler.trigger("gap")
    await h.clock.flush()
    expect(h.calls).toEqual([])
    expect(h.local.length).toBeGreaterThanOrEqual(1)
  })
})

describe("#1766 — unknown retries (cold owner map)", () => {
  test(`a response listing a pinned id as unresolved \`unknown\` retries after ${FLEET_UNKNOWN_RETRY_MS} ms, at most ${FLEET_UNKNOWN_RETRY_MAX} times per trigger`, async () => {
    expect(FLEET_UNKNOWN_RETRY_MS).toBe(2000)
    expect(FLEET_UNKNOWN_RETRY_MAX).toBe(3)
    const h = harness({ respond: (ids) => applied(ids, { statuses: {}, unresolved: [{ id: "ses_a", reason: "unknown" }] }) })
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(FLEET_UNKNOWN_RETRY_MS - 1)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(1)
    expect(h.calls).toHaveLength(2)
    await h.clock.advance(FLEET_UNKNOWN_RETRY_MS * 5)
    expect(h.calls).toHaveLength(1 + FLEET_UNKNOWN_RETRY_MAX) // the trigger + 3 retries, then it stops
  })

  test("retries stop as soon as the owner map has caught up (no unknown left)", async () => {
    const h = harness({
      respond: (ids, n) => (n === 1 ? applied(ids, { statuses: {}, unresolved: [{ id: "ses_a", reason: "unknown" }] }) : applied(ids)),
    })
    h.scheduler.trigger("connected")
    await h.clock.advance(FLEET_UNKNOWN_RETRY_MS * 10)
    expect(h.calls).toHaveLength(2)
  })

  test("over-cap / no-directory unresolved ids do NOT trigger the short retry", async () => {
    const h = harness({
      respond: (ids) => applied(ids, { statuses: {}, unresolved: [{ id: "ses_a", reason: "over-cap" }, { id: "ses_b", reason: "no-directory" }] }),
    })
    h.scheduler.trigger("connected")
    await h.clock.advance(FLEET_UNKNOWN_RETRY_MS * 3)
    expect(h.calls).toHaveLength(1)
  })
})

describe("#1766 — self-heal scheduler", () => {
  test(`repeats the fleet re-seed every ${FLEET_RESEED_INTERVAL_MS} ms while connected and visible`, async () => {
    expect(FLEET_RESEED_INTERVAL_MS).toBe(10_000)
    const h = harness()
    h.scheduler.start()
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS - 1)
    expect(h.calls).toHaveLength(0)
    await h.clock.advance(1)
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 2)
    expect(h.calls).toHaveLength(3)
    h.scheduler.stop()
  })

  test("pauses while the document is hidden, resumes when visible", async () => {
    const h = harness()
    h.scheduler.start()
    h.state.visible = false
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 3)
    expect(h.calls).toHaveLength(0)
    h.state.visible = true
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS)
    expect(h.calls).toHaveLength(1)
    h.scheduler.stop()
  })

  test("does not tick while the event stream is disconnected", async () => {
    const h = harness()
    h.scheduler.start()
    h.state.connected = false
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 2)
    expect(h.calls).toHaveLength(0)
    h.scheduler.stop()
  })

  test("does not run when there are no pinned sessions (and does no local re-seed either)", async () => {
    const h = harness({ pins: [] })
    h.scheduler.start()
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 3)
    expect(h.calls).toEqual([])
    expect(h.local).toEqual([])
    h.scheduler.stop()
  })

  test("never runs two re-seeds at once: triggers during a flight coalesce into exactly ONE more run", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      respond: async (ids, n) => {
        if (n === 1) await gate
        return applied(ids)
      },
    })
    h.scheduler.trigger("connected")
    await h.clock.flush()
    h.scheduler.trigger("gap")
    h.scheduler.trigger("gap")
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls).toHaveLength(1) // still in flight
    release()
    await h.clock.flush()
    expect(h.calls).toHaveLength(2) // exactly one coalesced follow-up
    expect(h.maxInFlight()).toBe(1)
  })

  test("a HUNG fleet read is cut by the 5 s client timeout (late response discarded) and cannot block the next tick", async () => {
    const clock = fakeClock()
    const reconciled: Array<Record<string, unknown>> = []
    let lateResolve!: (v: { status: number; body: unknown }) => void
    let fetches = 0
    const diagnostics = createFleetDiagnostics({ warn: () => {}, now: clock.now })
    const scheduler = createFleetReseedScheduler({
      pinnedIds: () => ["ses_a"],
      reseed: (ids, signal) =>
        runFleetReseed(ids, {
          fetchFleet: () => {
            fetches++
            if (fetches === 1) return new Promise((r) => (lateResolve = r)) // hangs, ignores abort
            return Promise.resolve({ status: 200, body: { ok: true, statuses: { ses_a: { type: "busy" } }, sources: {}, unresolved: [] } })
          },
          reconcile: (s) => reconciled.push(s),
          localReseed: async () => {},
          diagnostics,
          now: clock.now,
          timers: clock.timers,
          signal,
        }),
      localReseed: async () => {},
      isConnected: () => true,
      isVisible: () => true,
      diagnostics,
      timers: clock.timers,
      now: clock.now,
    })
    scheduler.start()
    await clock.advance(FLEET_RESEED_INTERVAL_MS) // tick 1: the hung read
    expect(fetches).toBe(1)
    await clock.advance(5000) // the client timeout frees the scheduler
    lateResolve({ status: 200, body: { ok: true, statuses: { ses_a: { type: "idle" } }, sources: {}, unresolved: [] } })
    await clock.flush()
    expect(reconciled).toEqual([]) // the late response is discarded, never applied
    await clock.advance(FLEET_RESEED_INTERVAL_MS) // tick 2 runs (not blocked)
    expect(fetches).toBe(2)
    expect(reconciled).toEqual([{ ses_a: { type: "busy" } }])
    scheduler.stop()
  })

  test("after the read is known NOT SERVED (no fleet peers), self-heal and pin triggers stop — the app keeps today's behavior", async () => {
    const h = harness({ respond: () => ({ kind: "fallback", cause: "not-served" }) })
    h.scheduler.start()
    h.scheduler.trigger("connected")
    await h.clock.flush()
    expect(h.calls).toHaveLength(1)
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 3)
    h.scheduler.notePinned("ses_new")
    await h.clock.advance(FLEET_PIN_DEBOUNCE_MS * 2)
    expect(h.calls).toHaveLength(1) // no periodic or pin-driven reads on a fleet-less machine
    h.scheduler.trigger("connected") // the existing edges still re-probe (→ local fallback)
    await h.clock.flush()
    expect(h.calls).toHaveLength(2)
    h.scheduler.stop()
  })

  test("emits a diagnostic after 3 consecutive re-seeds in which every requested id was omitted or unresolved", async () => {
    let covered = false
    const h = harness({
      respond: (ids) =>
        covered ? applied(ids) : applied(ids, { statuses: {}, unresolved: [{ id: ids[0], reason: "over-cap" }] }),
    })
    h.scheduler.trigger("connected")
    await h.clock.flush()
    h.scheduler.trigger("gap")
    await h.clock.flush()
    expect(h.warned.filter((w) => w.includes("all-omitted"))).toHaveLength(0)
    h.scheduler.trigger("gap")
    await h.clock.flush()
    expect(h.warned.filter((w) => w.includes("all-omitted"))).toHaveLength(1)
    covered = true // one covered read resets the streak
    h.scheduler.trigger("gap")
    await h.clock.flush()
    covered = false
    for (let i = 0; i < 2; i++) {
      h.scheduler.trigger("gap")
      await h.clock.flush()
    }
    expect(h.warned.filter((w) => w.includes("all-omitted"))).toHaveLength(1)
  })

  test("a partial failure persisting 3 consecutive re-seeds for the same (owner, directory) is diagnosed", async () => {
    const failing = { studio: { present: true, directories: { "/p": { ok: false, reason: "timeout", sessions: 1 } } } }
    const h = harness({ respond: (ids) => applied(ids, { statuses: { ses_a: { type: "idle" } }, sources: failing }) })
    for (let i = 0; i < 2; i++) {
      h.scheduler.trigger("gap")
      await h.clock.flush()
    }
    expect(h.warned.filter((w) => w.includes("studio") && w.includes("/p"))).toHaveLength(0)
    h.scheduler.trigger("gap")
    await h.clock.flush()
    const hit = h.warned.filter((w) => w.includes("studio") && w.includes("/p"))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain("timeout")
  })

  test("stops on teardown: no ticks, no debounced or retry runs, and an in-flight result is not followed up", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const h = harness({
      respond: async (ids, n) => {
        if (n === 1) await gate
        return applied(ids, { statuses: {}, unresolved: [{ id: "ses_a", reason: "unknown" }] })
      },
    })
    h.scheduler.start()
    h.scheduler.trigger("connected")
    await h.clock.flush()
    h.scheduler.trigger("gap") // pending
    h.scheduler.notePinned("ses_z") // debounce armed
    h.scheduler.stop()
    expect(h.clock.pending()).toBe(0) // every timer (tick, debounce) cleared AT teardown
    release()
    await h.clock.advance(FLEET_RESEED_INTERVAL_MS * 5)
    expect(h.calls).toHaveLength(1) // nothing after teardown: no pending run, no retry, no tick, no debounce
    expect(h.clock.pending()).toBe(0) // and none re-armed by the settling in-flight read (no retry)
    h.scheduler.trigger("connected") // a stopped scheduler ignores triggers
    await h.clock.flush()
    expect(h.calls).toHaveLength(1)
  })
})

describe("#1766 — viewedSessionIdFromLocation", () => {
  test.each([
    ["/server/aHR0cA/session/ses_abc", "ses_abc"],
    ["/L1VzZXJzL2pq/session/ses_def?x=1", "ses_def"],
    ["/#/server/aHR0cA/session/ses_hash", "ses_hash"],
    ["/server/aHR0cA/session/ses_sub/files", "ses_sub"],
    ["/new-session?draftId=1", undefined],
    ["/", undefined],
  ])("%s → %s", (href, id) => {
    expect(viewedSessionIdFromLocation(href)).toBe(id)
  })
})

describe("#1766 — runFleetReseed teardown signal", () => {
  test("an outer (teardown) abort cancels the read: nothing applied, no local fallback", async () => {
    const ac = new AbortController()
    const seen = { reconcile: 0, local: 0 }
    const p = runFleetReseed(["a"], {
      fetchFleet: () => new Promise(() => {}),
      reconcile: () => seen.reconcile++,
      localReseed: async () => {
        seen.local++
      },
      diagnostics: createFleetDiagnostics({ warn: () => {} }),
      signal: ac.signal,
    })
    ac.abort()
    expect(await p).toEqual({ kind: "cancelled" })
    expect(seen).toEqual({ reconcile: 0, local: 0 })
  })
})

import { describe, expect, test } from "bun:test"
import {
  FLEET_SESSION_STATUS_ROUTE,
  FLEET_READ_TIMEOUT_MS,
  createFleetDiagnostics,
  fleetSessionStatusRoute,
  parseFleetStatusResponse,
  runFleetReseed,
  type FleetReseedDeps,
} from "./fleet-session-status"

// amicode#1766 checkpoint 4 — the app's fleet session-status read client: the
// documented response shape parse (per-entry drop of invalid entries; whole-body
// fallback only for a non-documented top level), the apply through the
// recency-guarded reconcile, and the fallback to today's LOCAL re-seed with
// rate-limited, per-cause diagnostics.

const OK_BODY = {
  ok: true,
  statuses: { ses_a: { type: "busy" }, ses_b: { type: "idle" } },
  sources: { studio: { present: true, directories: { "/p": { ok: true, sessions: 2 } } } },
  unresolved: [{ id: "ses_c", reason: "unknown" }],
}

describe("#1766 — fleet read route", () => {
  test("sends the ids as ONE comma-separated `ids` parameter, order preserved, under the fleet namespace", () => {
    expect(FLEET_SESSION_STATUS_ROUTE).toBe("/amicode/fleet/session-status")
    const route = fleetSessionStatusRoute(["ses_viewed", "ses b", "ses,c"])
    const u = new URL(route, "http://x")
    expect(u.pathname).toBe("/amicode/fleet/session-status")
    expect(u.searchParams.get("ids")).toBe("ses_viewed,ses b,ses,c")
    expect(u.searchParams.getAll("ids")).toHaveLength(1)
  })
})

describe("#1766 — parseFleetStatusResponse", () => {
  test("a 200 with the documented shape parses to its statuses + unresolved", () => {
    const r = parseFleetStatusResponse(200, OK_BODY)
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.statuses).toEqual({ ses_a: { type: "busy" }, ses_b: { type: "idle" } })
    expect(r.unresolved).toEqual([{ id: "ses_c", reason: "unknown" }])
    expect(r.dropped).toBe(0)
  })

  test("an individual invalid status entry is DROPPED; the other entries are kept", () => {
    const r = parseFleetStatusResponse(200, {
      ...OK_BODY,
      statuses: {
        good: { type: "busy" },
        retry: { type: "retry", attempt: 1, message: "m", next: 2, action: { reason: "r" } },
        bad_type: { type: "running" },
        bad_retry: { type: "retry", attempt: -1, message: "m", next: 2 },
        not_obj: "busy",
        nul: null,
      },
    })
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.statuses).toEqual({
      good: { type: "busy" },
      retry: { type: "retry", attempt: 1, message: "m", next: 2, action: { reason: "r" } },
    })
    expect(r.dropped).toBe(4)
  })

  test("an invalid unresolved entry is dropped individually too", () => {
    const r = parseFleetStatusResponse(200, {
      ...OK_BODY,
      unresolved: [{ id: "a", reason: "unknown" }, { id: "b", reason: "bogus" }, { reason: "unknown" }, "c", { id: "d", reason: "over-cap" }],
    })
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.unresolved).toEqual([
      { id: "a", reason: "unknown" },
      { id: "d", reason: "over-cap" },
    ])
  })

  test.each([
    ["an array", []],
    ["null", null],
    ["a string", "ok"],
    ["ok:false", { ...OK_BODY, ok: false }],
    ["missing statuses", { ok: true, sources: {}, unresolved: [] }],
    ["statuses as an array", { ...OK_BODY, statuses: [] }],
    ["unresolved not an array", { ...OK_BODY, unresolved: {} }],
    ["sources not an object", { ...OK_BODY, sources: [] }],
  ])("a 200 whose top level is not the documented shape (%s) is a diagnosed fallback", (_name, body) => {
    expect(parseFleetStatusResponse(200, body)).toMatchObject({ kind: "fallback", cause: "bad-shape", silent: false })
  })

  test("404 with reason no-fleet-peers is the EXPECTED not-served fallback — silent", () => {
    expect(parseFleetStatusResponse(404, { ok: false, reason: "no-fleet-peers" })).toEqual({
      kind: "fallback",
      cause: "not-served",
      silent: true,
    })
  })

  test.each([
    [404, { ok: false, error: "no route: GET /amicode/fleet/session-status" }, "not-found"],
    [404, undefined, "not-found"],
    [401, { ok: false, error: "unauthorized" }, "refused"],
    [403, {}, "refused"],
    [500, {}, "http-error"],
    [503, {}, "http-error"],
  ])("HTTP %i (%j) is a DIAGNOSED %s fallback", (status, body, cause) => {
    expect(parseFleetStatusResponse(status, body)).toMatchObject({ kind: "fallback", cause, silent: false })
  })
})

describe("#1766 — createFleetDiagnostics (rate-limited per cause)", () => {
  test("warns at most once per cause per window; distinct causes are independent; a new window warns again", () => {
    let t = 1_000_000
    const warned: string[] = []
    const d = createFleetDiagnostics({ warn: (m) => warned.push(m), now: () => t, windowMs: 60_000 })
    d.report("timeout", "fleet read timed out")
    d.report("timeout", "again")
    d.report("refused", "HTTP 401")
    t += 30_000
    d.report("timeout", "still within the window")
    expect(warned).toHaveLength(2)
    expect(warned[0]).toContain("timeout")
    expect(warned[1]).toContain("refused")
    t += 30_001
    d.report("timeout", "next window")
    expect(warned).toHaveLength(3)
  })
})

/** Deps for one re-seed with a scripted fleet response. */
function deps(over: Partial<FleetReseedDeps> & { reply?: () => Promise<{ status: number; body: unknown }> }) {
  const calls = { fleet: [] as string[][], reconcile: [] as Array<{ statuses: Record<string, unknown>; fetchedAt: number }>, local: 0, warned: [] as string[] }
  let t = 5_000
  const d: FleetReseedDeps = {
    fetchFleet: async (ids) => {
      calls.fleet.push([...ids])
      t += 10 // the response lands after the request was issued
      return (over.reply ?? (async () => ({ status: 200, body: OK_BODY })))()
    },
    reconcile: (statuses, opts) => calls.reconcile.push({ statuses, fetchedAt: opts.fetchedAt }),
    localReseed: async () => {
      calls.local++
    },
    diagnostics: createFleetDiagnostics({ warn: (m) => calls.warned.push(m), now: () => t }),
    now: () => t,
    ...over,
  }
  return { d, calls }
}

describe("#1766 — runFleetReseed (checkpoint 4: apply + fallback)", () => {
  test("a documented 200 is applied through the reconcile, stamped with the time the read was ISSUED", async () => {
    const { d, calls } = deps({})
    const out = await runFleetReseed(["ses_a", "ses_b"], d)
    expect(out.kind).toBe("applied")
    expect(calls.fleet).toEqual([["ses_a", "ses_b"]])
    expect(calls.reconcile).toEqual([{ statuses: { ses_a: { type: "busy" }, ses_b: { type: "idle" } }, fetchedAt: 5_000 }])
    expect(calls.local).toBe(0)
    expect(calls.warned).toEqual([])
  })

  test("not served (404 no-fleet-peers) → today's local re-seed, silently", async () => {
    const { d, calls } = deps({ reply: async () => ({ status: 404, body: { ok: false, reason: "no-fleet-peers" } }) })
    const out = await runFleetReseed(["ses_a"], d)
    expect(out).toMatchObject({ kind: "fallback", cause: "not-served" })
    expect(calls.local).toBe(1)
    expect(calls.reconcile).toEqual([])
    expect(calls.warned).toEqual([])
  })

  test.each([
    ["refused", async () => ({ status: 401, body: { ok: false, error: "unauthorized" } })],
    ["not-found", async () => ({ status: 404, body: { ok: false, error: "no route" } })],
    ["bad-shape", async () => ({ status: 200, body: { hello: "world" } })],
    [
      "network",
      async (): Promise<{ status: number; body: unknown }> => {
        throw new TypeError("Failed to fetch")
      },
    ],
  ])("an unavailable read (%s) → today's local re-seed + a diagnostic naming the cause", async (cause, reply) => {
    const { d, calls } = deps({ reply })
    const out = await runFleetReseed(["ses_a"], d)
    expect(out).toMatchObject({ kind: "fallback", cause })
    expect(calls.local).toBe(1)
    expect(calls.reconcile).toEqual([])
    expect(calls.warned).toHaveLength(1)
    expect(calls.warned[0]).toContain(cause)
  })

  test("diagnostics are rate-limited per cause across re-seeds", async () => {
    const { d, calls } = deps({ reply: async () => ({ status: 500, body: {} }) })
    await runFleetReseed(["a"], d)
    await runFleetReseed(["a"], d)
    await runFleetReseed(["a"], d)
    expect(calls.local).toBe(3) // every re-seed still falls back
    expect(calls.warned).toHaveLength(1) // but warns once per window
  })

  test(`a fleet read past the ${FLEET_READ_TIMEOUT_MS} ms client timeout falls back (timeout), and its LATE response is discarded, never applied`, async () => {
    expect(FLEET_READ_TIMEOUT_MS).toBe(5000)
    let resolveLate!: (v: { status: number; body: unknown }) => void
    const late = new Promise<{ status: number; body: unknown }>((r) => (resolveLate = r))
    let signalSeen: AbortSignal | undefined
    const { d, calls } = deps({ timeoutMs: 20 })
    d.fetchFleet = async (ids, signal) => {
      calls.fleet.push([...ids])
      signalSeen = signal
      return late // ignores the abort on purpose
    }
    const out = await runFleetReseed(["ses_a"], d)
    expect(out).toMatchObject({ kind: "fallback", cause: "timeout" })
    expect(signalSeen?.aborted).toBe(true) // the request was told to stop
    expect(calls.local).toBe(1)
    resolveLate({ status: 200, body: OK_BODY })
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.reconcile).toEqual([]) // the late response was discarded
  })

  test("a throwing local fallback is contained (the re-seed never throws)", async () => {
    const { d } = deps({ reply: async () => ({ status: 500, body: {} }) })
    d.localReseed = async () => {
      throw new Error("engine down")
    }
    await expect(runFleetReseed(["a"], d)).resolves.toMatchObject({ kind: "fallback" })
  })
})

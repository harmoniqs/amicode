import { describe, expect, test } from "bun:test"
import type { OpencodeClient, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"
import { E2E, FLEET_STATUS_E2E_RESPONSE } from "./fleet-session-status.e2e-fixture"
import { createFleetDiagnostics, runFleetReseed } from "./fleet-session-status"

// amicode#1766 END TO END (app half). FLEET_STATUS_E2E_RESPONSE is the exact
// body the REAL GET /amicode/fleet/session-status handler returns when driven
// against a stubbed peer owner that reports a pinned session busy in its
// directory — the service half (packages/extension/test/
// fleet_session_status_e2e.test.ts) asserts the live handler's answer equals it.
// Here that response goes through the app's real parse + runFleetReseed + the
// real ServerSession recency-guarded reconcile, into the store.

function createSession() {
  return createServerSession({ session: { get: async () => ({ data: undefined }) } } as unknown as OpencodeClient)
}

describe("#1766 — end to end: the real route's response → the app's parse + reconcile → the store", () => {
  test("the peer session the owner reported busy becomes busy in the store for that EXACT pinned id", async () => {
    const session = createSession()
    for (const id of E2E.pinnedIds) session.pin(id)
    // after a reopen: the store had re-learned nothing — the peer session reads idle
    expect(session.data.session_working(E2E.peerBusySession)).toBe(false)
    // a stale busy left on a session that has since gone quiet, and a busy the
    // app holds for a session the service cannot resolve
    session.apply({ type: "session.status", properties: { sessionID: E2E.peerQuietSession, status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: E2E.unknownSession, status: { type: "busy" } } })

    let requested: readonly string[] = []
    const out = await runFleetReseed(session.pinnedIds(), {
      fetchFleet: async (ids) => {
        requested = ids
        return { status: 200, body: structuredClone(FLEET_STATUS_E2E_RESPONSE) }
      },
      reconcile: (statuses, opts) => session.reconcileStatuses(statuses as Record<string, SessionStatus>, opts),
      localReseed: async () => {
        throw new Error("the fleet read was served — no local fallback expected")
      },
      diagnostics: createFleetDiagnostics({ warn: () => {} }),
      now: () => Date.now() + 1000, // issued after the local mutations above
    })

    expect(out.kind).toBe("applied")
    // the ids the app sent ARE the ids the service resolved and the owner answered
    expect([...requested].sort()).toEqual([...E2E.pinnedIds].sort())
    // busy for that exact session id → the rail's working floor and the tab's active indicator light
    expect(session.data.session_status[E2E.peerBusySession]).toEqual({ type: "busy" })
    expect(session.data.session_working(E2E.peerBusySession)).toBe(true)
    // the stale busy settled to idle (idle by absence in its own queried directory)
    expect(session.data.session_status[E2E.peerQuietSession]?.type).toBe("idle")
    // honest absence: the omitted (unknown) session keeps its current status
    expect(session.data.session_status[E2E.unknownSession]?.type).toBe("busy")
  })
})

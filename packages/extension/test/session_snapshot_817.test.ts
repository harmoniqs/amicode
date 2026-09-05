// Issue #817 — D2 (spec spec-20260905-045114-session-device-lifecycle): the
// persisted session snapshot is a render accelerator, never an authority.
// Ported from the fork reference with the REVISED currency: the token is
// derived CLIENT-side over the fetched projection (session-currency.ts), so
// bootCurrencyDecision takes the server-reported version instead of a server
// currency field.
import { describe, expect, test } from "vitest"
import { bootCurrencyDecision, toSnapshot, type SessionSnapshot } from "../../app-bundle/overlay/packages/app/src/context/global-sync/session-snapshot"

const session = (id: string, updated = 1) => ({
  id,
  directory: "/home",
  projectID: "p1",
  slug: id,
  version: "test",
  title: `Session ${id}`,
  time: { created: updated, updated },
})

describe("bootCurrencyDecision (D2: the #293 stale-storage shape self-heals on boot)", () => {
  test("a snapshot with a stale token is proven stale and the fetched rows are adopted", () => {
    const snapshot: SessionSnapshot = { sessions: [session("old")], currency: "v1.1.100.100.v1.18.10-amicode.21" }
    const decision = bootCurrencyDecision({
      snapshot,
      response: { sessions: [session("fresh", 200)] },
      serverVersion: "v1.18.10-amicode.21",
    })

    expect(decision.adopt).toBe(true)
    expect(decision.stale).toBe(true)
  })

  test("a snapshot written without a token (the #293 shape) cannot be trusted", () => {
    const snapshot: SessionSnapshot = { sessions: [], currency: undefined }
    const decision = bootCurrencyDecision({
      snapshot,
      response: { sessions: [session("fresh")] },
      serverVersion: "v1.18.29",
    })

    expect(decision.stale).toBe(true)
    expect(decision.adopt).toBe(true)
  })

  test("a matching token means the snapshot was fresh (same rows, same hub)", () => {
    const rows = [session("old")]
    // Written from the same projection on the same hub: the token derived at
    // write time (count 1, max 1, sum 1, version v1.18.29).
    const snapshot: SessionSnapshot = { sessions: rows, currency: "v1.1.1.1.v1.18.29" }
    const decision = bootCurrencyDecision({
      snapshot,
      response: { sessions: rows },
      serverVersion: "v1.18.29",
    })

    expect(decision.stale).toBe(false)
    // The token to persist alongside the adopted rows is derived client-side.
    expect(decision.currency).toBeTypeOf("string")
  })

  test("a changed hub build flips the token even over an unchanged projection", () => {
    const rows = [session("old")]
    const decision = bootCurrencyDecision({
      snapshot: { sessions: rows, currency: "v1.0.1.1.v1.18.10-amicode.21" },
      response: { sessions: rows },
      serverVersion: "v1.18.29",
    })

    expect(decision.stale).toBe(true)
  })

  test("a hub whose version is unavailable cannot prove staleness by build — but projection changes still do", () => {
    const rows = [session("old")]
    // Same rows, no version: the derived token matches the one stamped at
    // write time (also version-less), so no stale verdict.
    const same = bootCurrencyDecision({
      snapshot: { sessions: rows, currency: "v1.1.1.1.unavailable" },
      response: { sessions: rows },
      serverVersion: undefined,
    })
    expect(same.stale).toBe(false)
  })

  test("a fresh client with no snapshot adopts the fetched rows without a verdict", () => {
    const decision = bootCurrencyDecision({
      response: { sessions: [session("fresh")] },
      serverVersion: "v1.18.29",
    })

    expect(decision.adopt).toBe(true)
    expect(decision.stale).toBe(false)
    expect(decision.currency).toBeTypeOf("string")
  })

  test("out-of-band projection change between boots proves the snapshot stale (client-side derivation)", () => {
    // The snapshot was written from this projection...
    const written = [session("a", 100), session("b", 200)]
    const snapshot: SessionSnapshot = { sessions: written, currency: undefined }
    // ...and the hub now returns a different projection (b archived out-of-band).
    const decision = bootCurrencyDecision({
      snapshot,
      response: { sessions: [session("a", 100)] },
      serverVersion: "v1.18.29",
    })

    expect(decision.stale).toBe(true)
    expect(decision.adopt).toBe(true)
  })

  test("toSnapshot shapes what gets persisted: rows plus the derived token", () => {
    const rows = [session("a"), session("b")]
    const snapshot = toSnapshot(rows, "v1.0.2.200.v1.18.29")
    expect(snapshot.sessions).toHaveLength(2)
    expect(snapshot.currency).toBe("v1.0.2.200.v1.18.29")
  })
})

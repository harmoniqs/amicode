import { describe, expect, test } from "bun:test"
import { sessionWorkingFromStore } from "./session-working"

// ── #1637 — the store-readable half of the session_working floor ──
// Both session_working implementations (server-session store + global-sync child
// store) must honor the SAME turn-active floor. This is the shared predicate they
// read: a session is working when its turn flag is up OR its status is not idle.
// (server-session ORs in its in-memory streamActiveParts stream floor on top.)
describe("#1637 sessionWorkingFromStore — shared turn floor", () => {
  test("a raised turn flag reads working even when status is idle (no-part turn / stray idle)", () => {
    expect(sessionWorkingFromStore({ type: "idle" }, true)).toBe(true)
  })

  test("a busy status reads working when the turn flag is down", () => {
    expect(sessionWorkingFromStore({ type: "busy" }, false)).toBe(true)
  })

  test("idle status and a cleared turn flag reads not-working", () => {
    expect(sessionWorkingFromStore({ type: "idle" }, false)).toBe(false)
    expect(sessionWorkingFromStore(undefined, false)).toBe(false)
  })
})

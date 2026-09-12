import { describe, expect, test } from "bun:test"
import { reduceDevToolsRequest, type DevToolsRequestState } from "./developer-tools-request-state"
import type { DevToolsStatus } from "./developer-tools-controller"

// ============================================================================
// The devtools path-validation flicker (#940): sendUpdate() used to clear
// `status` to undefined the instant a validation round-trip started, so any
// visible error/success indicator vanished and then snapped back when the
// reply arrived — a visible flash on every path edit. This models the
// request lifecycle as a pure reducer so the "don't blank the status while
// a request is in flight" invariant is directly testable.
// ============================================================================

const sampleStatus: DevToolsStatus = {
  opencodeValid: false,
  opencodeError: "Binary not found at this path",
  amicodeValid: true,
  serverRestarted: false,
  reloadNeeded: false,
}

const idle: DevToolsRequestState = { status: undefined, pending: false }

describe("reduceDevToolsRequest", () => {
  test("request-sent while idle marks pending without inventing a status", () => {
    const next = reduceDevToolsRequest(idle, { type: "request-sent" })
    expect(next).toEqual({ status: undefined, pending: true })
  })

  test("status-received clears pending and sets the new status", () => {
    const sent = reduceDevToolsRequest(idle, { type: "request-sent" })
    const received = reduceDevToolsRequest(sent, { type: "status-received", status: sampleStatus })
    expect(received.pending).toBe(false)
    expect(received.status).toEqual(sampleStatus)
  })

  test("REGRESSION: a second request-sent must keep the STALE status visible, not blank it", () => {
    // First round-trip already completed and produced an error.
    const afterFirst: DevToolsRequestState = { status: sampleStatus, pending: false }

    // User edits the path again — a new request goes out.
    const midSecondRequest = reduceDevToolsRequest(afterFirst, { type: "request-sent" })

    // This is the exact bug: status must stay visible (not undefined) while
    // the second round-trip is in flight. Only `pending` should flip.
    expect(midSecondRequest.status).toEqual(sampleStatus)
    expect(midSecondRequest.pending).toBe(true)
  })

  test("the second round-trip's reply replaces the stale status once it lands", () => {
    const afterFirst: DevToolsRequestState = { status: sampleStatus, pending: false }
    const midSecondRequest = reduceDevToolsRequest(afterFirst, { type: "request-sent" })
    const newStatus: DevToolsStatus = { ...sampleStatus, opencodeValid: true, opencodeError: undefined }
    const afterSecond = reduceDevToolsRequest(midSecondRequest, { type: "status-received", status: newStatus })
    expect(afterSecond.status).toEqual(newStatus)
    expect(afterSecond.pending).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import {
  amicodeWarrants,
  hasApprovalBridge,
  registerAmicodeApprovalBridge,
  submitApproval,
  type ApprovalBridge,
} from "./approval-bridge"
import type { ApprovalRequest, Warrant } from "./approval"

const REQ: ApprovalRequest = { plan_hash: "9f2c", bounds: { max_solves: 8 } }
const WARRANT: Warrant = {
  plan_hash: "9f2c",
  bounds: { max_solves: 8 },
  expires_at: "2026-07-27T21:00:00Z",
  issued_by: "user:ui",
}

const stub = (): { bridge: ApprovalBridge; sent: ApprovalRequest[] } => {
  const sent: ApprovalRequest[] = []
  return { bridge: { approve: (r) => sent.push(r), warrants: () => [WARRANT] }, sent }
}

describe("approval bridge", () => {
  test("no bridge → not actionable, no warrants, and submitting is a silent no-op", () => {
    expect(hasApprovalBridge()).toBe(false)
    expect(amicodeWarrants()).toEqual([])
    expect(() => submitApproval(REQ)).not.toThrow() // must not appear to have approved
  })

  test("registering exposes the host's warrants and routes approvals to it", () => {
    const { bridge, sent } = stub()
    const dispose = registerAmicodeApprovalBridge(bridge)
    try {
      expect(hasApprovalBridge()).toBe(true)
      expect(amicodeWarrants()).toEqual([WARRANT])
      submitApproval(REQ)
      expect(sent).toEqual([REQ])
    } finally {
      dispose()
    }
    expect(hasApprovalBridge()).toBe(false)
  })

  test("a stale disposer cannot wipe a newer registration", () => {
    const first = stub()
    const second = stub()
    const disposeFirst = registerAmicodeApprovalBridge(first.bridge)
    const disposeSecond = registerAmicodeApprovalBridge(second.bridge)
    disposeFirst() // late unmount of the older card
    expect(hasApprovalBridge()).toBe(true)
    submitApproval(REQ)
    expect(second.sent).toEqual([REQ])
    expect(first.sent).toEqual([])
    disposeSecond()
  })
})

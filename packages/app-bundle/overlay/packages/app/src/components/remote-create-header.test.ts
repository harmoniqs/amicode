/**
 * remote-create-header.test.ts — #1643 (completes #1484 AC3)
 *
 * The owner-header producer: given the pre-flight-resolved creation target, it
 * decides what the composer does on submit — attach `x-amicode-owner` and
 * create remotely, create locally with NO header, or refuse with a blocked
 * reason. This is the missing PRODUCER for ADR 0031 §D1a leg 2 (the multiplexer
 * has consumed the header since #1449; nothing emitted it).
 */
import { describe, expect, test } from "bun:test"
import {
  OWNER_HEADER,
  planRemoteCreate,
  type CreationTargetView,
} from "./remote-create-header"

describe("#1643 planRemoteCreate — the owner-header producer", () => {
  test("local target → proceed, no owner header", () => {
    const plan = planRemoteCreate({ kind: "local" })
    expect(plan.proceed).toBe(true)
    expect(plan.headers).toEqual({})
    expect(plan.blockedReason).toBeUndefined()
  })

  test("remote target → proceed, attach x-amicode-owner = machineId", () => {
    const plan = planRemoteCreate({ kind: "remote", machineId: "studio-001" })
    expect(plan.proceed).toBe(true)
    expect(plan.headers[OWNER_HEADER]).toBe("studio-001")
  })

  test("blocked target → do NOT proceed, carry the reason, no header", () => {
    const plan = planRemoteCreate({ kind: "blocked", machineId: "studio-001", reason: "no-control-grant" })
    expect(plan.proceed).toBe(false)
    expect(plan.blockedReason).toBe("no-control-grant")
    expect(plan.headers).toEqual({})
  })

  test("the header key is the exact routing header the multiplexer reads", () => {
    // Must byte-match session_multiplexer.ts OWNER_ROUTING_HEADER.
    expect(OWNER_HEADER).toBe("x-amicode-owner")
  })

  test("remote target with an empty machineId is refused (never an empty header)", () => {
    const plan = planRemoteCreate({ kind: "remote", machineId: "" } as CreationTargetView)
    expect(plan.proceed).toBe(false)
    expect(plan.headers).toEqual({})
  })
})

describe("#1643 blocked-reason display text", () => {
  test("every blocked reason maps to human-readable inline text", () => {
    const reasons = [
      "no-control-grant",
      "grant-revoked",
      "insufficient-scope",
      "transport-down",
      "no-remote-root",
    ] as const
    for (const r of reasons) {
      const plan = planRemoteCreate({ kind: "blocked", machineId: "m", reason: r })
      expect(plan.displayText).toBeTruthy()
      expect(typeof plan.displayText).toBe("string")
    }
  })
})

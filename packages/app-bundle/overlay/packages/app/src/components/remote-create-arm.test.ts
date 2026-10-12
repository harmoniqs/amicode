/**
 * remote-create-arm.test.ts — #1643 (completes #1484 AC3)
 *
 * The arming store + fetch-seam attachment. The composer, having pre-flight
 * resolved a REMOTE target, ARMS the owner id; the SDK's custom fetch (the
 * sseFetch-precedent seam, server-sdk.tsx) reads the armed owner and attaches
 * `x-amicode-owner` to the NEXT path-less session-create POST, then disarms.
 * A one-shot: it must not leak the header onto later or unrelated requests.
 */
import { describe, expect, test, beforeEach } from "bun:test"
import {
  armRemoteCreate,
  disarmRemoteCreate,
  peekArmedOwner,
  attachOwnerHeaderIfArmed,
  isSessionCreate,
} from "./remote-create-arm"
import { OWNER_HEADER } from "./remote-create-header"

describe("#1643 isSessionCreate — recognizes the path-less create POST", () => {
  test("POST /session is a create", () => {
    expect(isSessionCreate("POST", "http://x/session")).toBe(true)
  })
  test("POST /api/session is a create (v2 vendored client)", () => {
    expect(isSessionCreate("POST", "http://x/api/session")).toBe(true)
  })
  test("POST /session/abc/message is NOT a create", () => {
    expect(isSessionCreate("POST", "http://x/session/abc/message")).toBe(false)
  })
  test("GET /session is NOT a create", () => {
    expect(isSessionCreate("GET", "http://x/session")).toBe(false)
  })
})

describe("#1643 arm/disarm store", () => {
  beforeEach(() => disarmRemoteCreate())

  test("peek is undefined by default", () => {
    expect(peekArmedOwner()).toBeUndefined()
  })
  test("arm then peek returns the owner", () => {
    armRemoteCreate("studio-001")
    expect(peekArmedOwner()).toBe("studio-001")
  })
  test("disarm clears it", () => {
    armRemoteCreate("studio-001")
    disarmRemoteCreate()
    expect(peekArmedOwner()).toBeUndefined()
  })
})

describe("#1643 attachOwnerHeaderIfArmed — one-shot header injection", () => {
  beforeEach(() => disarmRemoteCreate())

  test("armed + create POST → header attached AND store disarmed", () => {
    armRemoteCreate("studio-001")
    const headers = attachOwnerHeaderIfArmed("POST", "http://x/session", {})
    expect(headers[OWNER_HEADER]).toBe("studio-001")
    // one-shot: disarmed after use
    expect(peekArmedOwner()).toBeUndefined()
  })

  test("armed but NOT a create POST → no header, still armed", () => {
    armRemoteCreate("studio-001")
    const headers = attachOwnerHeaderIfArmed("POST", "http://x/session/abc/message", {})
    expect(headers[OWNER_HEADER]).toBeUndefined()
    expect(peekArmedOwner()).toBe("studio-001")
  })

  test("not armed + create POST → NO header (local create is byte-unchanged)", () => {
    const headers = attachOwnerHeaderIfArmed("POST", "http://x/session", {})
    expect(headers[OWNER_HEADER]).toBeUndefined()
  })

  test("preserves existing headers", () => {
    armRemoteCreate("studio-001")
    const headers = attachOwnerHeaderIfArmed("POST", "http://x/session", { "content-type": "application/json" })
    expect(headers["content-type"]).toBe("application/json")
    expect(headers[OWNER_HEADER]).toBe("studio-001")
  })
})

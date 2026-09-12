import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import {
  HARMONIQS_PROVIDER_ID,
  HARMONIQS_PROVIDER_NAME,
  CONNECT_HARMONIQS_PROVIDER_KIND,
  CONNECT_HARMONIQS_PROVIDER_ACK_KIND,
  shouldShowHarmoniqsEntry,
  requestHarmoniqsProviderConnect,
  isHarmoniqsProviderConnectAck,
} from "./dialog-connect-provider-harmoniqs"

// `inAmicode()` gates on `window.self !== window.top` — these tests fake an
// iframe by overriding `window.top` to a distinct object, and restore it
// afterward so other test files' `window` state is untouched.
function frame(): () => void {
  const realTop = window.top
  Object.defineProperty(window, "top", { value: {}, configurable: true })
  return () => Object.defineProperty(window, "top", { value: realTop, configurable: true })
}

describe("shouldShowHarmoniqsEntry", () => {
  test("hidden when unframed (no extension host to relay to)", () => {
    expect(shouldShowHarmoniqsEntry(new Set())).toBe(false)
  })

  test("shown when framed and the real provider hasn't landed in the catalog", () => {
    const unframe = frame()
    expect(shouldShowHarmoniqsEntry(new Set(["anthropic", "openai"]))).toBe(true)
    unframe()
  })

  test('hidden when a real "harmoniqs" catalog entry already exists — the stub never shadows it', () => {
    const unframe = frame()
    expect(shouldShowHarmoniqsEntry(new Set([HARMONIQS_PROVIDER_ID]))).toBe(false)
    unframe()
  })
})

describe("requestHarmoniqsProviderConnect", () => {
  let posted: unknown[] = []
  let unframe: () => void
  let restorePost: () => void

  beforeEach(() => {
    posted = []
    unframe = frame()
    const original = window.parent.postMessage.bind(window.parent)
    window.parent.postMessage = ((msg: unknown) => posted.push(msg)) as typeof window.parent.postMessage
    restorePost = () => {
      window.parent.postMessage = original
    }
  })

  afterEach(() => {
    restorePost()
    unframe()
  })

  test("posts the connect envelope, not a generic provider-connect message", () => {
    requestHarmoniqsProviderConnect()
    expect(posted).toEqual([{ source: "amicode", kind: CONNECT_HARMONIQS_PROVIDER_KIND }])
  })

  test("never carries a provider id/config payload the generic ProviderConnection flow would expect", () => {
    requestHarmoniqsProviderConnect()
    const msg = posted[0] as Record<string, unknown>
    expect(msg).not.toHaveProperty("provider")
    expect(msg).not.toHaveProperty("apiKey")
    expect(msg).not.toHaveProperty("baseURL")
  })
})

describe("isHarmoniqsProviderConnectAck", () => {
  test("recognizes the extension's ack envelope", () => {
    expect(isHarmoniqsProviderConnectAck({ source: "amicode", kind: CONNECT_HARMONIQS_PROVIDER_ACK_KIND })).toBe(true)
  })

  test("rejects foreign or malformed messages", () => {
    expect(isHarmoniqsProviderConnectAck(undefined)).toBe(false)
    expect(isHarmoniqsProviderConnectAck(null)).toBe(false)
    expect(isHarmoniqsProviderConnectAck("connect-harmoniqs-provider-ack")).toBe(false)
    expect(isHarmoniqsProviderConnectAck({ source: "amicode", kind: "dev-tools-status" })).toBe(false)
    expect(isHarmoniqsProviderConnectAck({ source: "other", kind: CONNECT_HARMONIQS_PROVIDER_ACK_KIND })).toBe(false)
  })
})

describe("constants", () => {
  test("HARMONIQS_PROVIDER_NAME is the branded display name", () => {
    expect(HARMONIQS_PROVIDER_NAME).toBe("Harmoniqs AI")
  })
})

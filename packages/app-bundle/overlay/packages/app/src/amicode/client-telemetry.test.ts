import { afterEach, describe, expect, test } from "bun:test"
import { getLastClientError, startClientTelemetry } from "./client-telemetry"

// #1745: client telemetry — the capture + heartbeat contract, at the module
// seam. The behaviors that died for six weeks (Sep 23 → Oct 10): captures must
// SHIP (to the serving origin's /__amicode_client_log), the heartbeat must beat
// while the panel is open, both fire-and-forget, no PII in the heartbeat.

type Recorded = { url: string; body: string }
let recorded: Recorded[] = []
let originalFetch: typeof fetch
let originalConsoleError: typeof console.error
let consoleErrorCalls: unknown[][] = []
let stop: (() => void) | undefined

const install = (opts?: { heartbeatMs?: number }) => {
  recorded = []
  consoleErrorCalls = []
  originalFetch = globalThis.fetch
  // eslint-disable-next-line require-await
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    recorded.push({ url: String(input), body: String(init?.body ?? "") })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  // a spy UNDER the telemetry wrapper: the wrapper must pass through to the
  // original console.error (the app still logs locally)
  originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args)
  }
  stop = startClientTelemetry(opts)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const heartbeats = () => recorded.filter((r) => /^\{"heartbeat":\d+\}$/.test(r.body))
const captures = (kind: string) => recorded.filter((r) => r.body.startsWith(`${kind} `))

afterEach(() => {
  stop?.()
  stop = undefined
  console.error = originalConsoleError
  globalThis.fetch = originalFetch
})

describe("client telemetry", () => {
  test("heartbeats immediately on mount, then on the interval, to the ingest route", async () => {
    install({ heartbeatMs: 60 })
    await sleep(10)
    expect(heartbeats().length).toBeGreaterThanOrEqual(1) // the immediate beat: an open panel is never "never heartbeated"
    await sleep(150)
    expect(heartbeats().length).toBeGreaterThanOrEqual(2)
    for (const beat of heartbeats()) {
      expect(beat.url).toBe("/__amicode_client_log")
    }
  })

  test("the heartbeat body is exactly a timestamp — no PII, no URL, no user agent", async () => {
    install({ heartbeatMs: 50 })
    await sleep(80)
    expect(heartbeats().length).toBeGreaterThanOrEqual(2)
    for (const beat of heartbeats()) {
      expect(beat.body).toMatch(/^\{"heartbeat":\d+}$/)
    }
  })

  test("console.error captures ship to the ingest route and still log locally", () => {
    install({ heartbeatMs: 60_000 })
    console.error("capture-test-boom", new Error("t is not a function"))
    const shipped = captures("C")
    expect(shipped.length).toBe(1)
    expect(shipped[0].url).toBe("/__amicode_client_log")
    // the capture contract (unchanged from the #1290 badge): the first Error
    // argument's message is the capture text, with its stack appended
    expect(shipped[0].body).toContain("t is not a function")
    expect(consoleErrorCalls.length).toBe(1) // passthrough to the original
    expect(getLastClientError()).toContain("t is not a function")
  })

  test("window error events ship as E captures", () => {
    install({ heartbeatMs: 60_000 })
    window.dispatchEvent(new ErrorEvent("error", { message: "exploded mid-render" }))
    const shipped = captures("E")
    expect(shipped.length).toBe(1)
    expect(shipped[0].body).toContain("exploded mid-render")
  })

  test("identical repeat captures dedupe to one ship", () => {
    install({ heartbeatMs: 60_000 })
    console.error(new Error("same teardown error"))
    console.error(new Error("same teardown error"))
    expect(captures("C").length).toBe(1)
  })

  test("stop() restores the previous console.error and ends the heartbeat", async () => {
    install({ heartbeatMs: 40 })
    const before = heartbeats().length
    stop?.()
    stop = undefined
    console.error(new Error("after stop"))
    await sleep(120)
    expect(heartbeats().length).toBe(before) // no beats after stop
    expect(captures("C").length).toBe(0) // capture uninstalled
    expect(consoleErrorCalls.length).toBe(1) // the pre-install console.error (the spy) is restored
  })
})

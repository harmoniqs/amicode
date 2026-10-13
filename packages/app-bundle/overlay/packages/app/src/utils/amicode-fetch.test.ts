import { afterEach, describe, expect, test } from "bun:test"
import { amicodeGetResponse } from "./amicode-fetch"

// amicode#1766 — the fleet read needs the HTTP status AND the JSON body of a
// non-2xx answer (the not-served 404 carries `reason: "no-fleet-peers"`), which
// amicodeGet discards. amicodeGetResponse is its sibling: same per-connection
// Basic credential, never throws on a non-2xx, honors an abort signal.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const conn = (password?: string) =>
  ({ http: { url: "http://127.0.0.1:4096", username: "opencode", ...(password ? { password } : {}) } }) as never

describe("#1766 — amicodeGetResponse", () => {
  test("attaches the same Basic credential as amicodeGet and returns status + parsed body of a non-2xx", async () => {
    let seen: { url: string; auth: string | null; signal?: AbortSignal | null } | undefined
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization"), signal: init?.signal }
      return new Response(JSON.stringify({ ok: false, reason: "no-fleet-peers" }), { status: 404 })
    }) as typeof fetch
    const ac = new AbortController()
    const res = await amicodeGetResponse(conn("pw"), "/amicode/fleet/session-status?ids=a%2Cb", { signal: ac.signal })
    expect(res).toEqual({ status: 404, body: { ok: false, reason: "no-fleet-peers" } })
    expect(seen?.url).toBe("http://127.0.0.1:4096/amicode/fleet/session-status?ids=a%2Cb")
    expect(seen?.auth).toBe(`Basic ${btoa("opencode:pw")}`)
    expect(seen?.signal).toBe(ac.signal)
  })

  test("a non-JSON body resolves with body undefined (the caller decides — never a throw)", async () => {
    globalThis.fetch = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as unknown as typeof fetch
    expect(await amicodeGetResponse(conn(), "/amicode/fleet/session-status")).toEqual({ status: 502, body: undefined })
  })

  test("no password → no Authorization header; no connection → rejects", async () => {
    let auth: string | null = "unset"
    globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization")
      return new Response("{}", { status: 200 })
    }) as typeof fetch
    expect(await amicodeGetResponse(conn(), "/x")).toEqual({ status: 200, body: {} })
    expect(auth).toBeNull()
    await expect(amicodeGetResponse(undefined, "/x")).rejects.toThrow("no active server")
  })
})

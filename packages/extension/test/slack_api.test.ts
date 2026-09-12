// slack_api.ts unit tests (#1039) — shared Slack HTTP layer, caches,
// target resolution, and message formatting. Injectable fetchImpl + readCredentialFn
// seams; no filesystem, no network.
import { describe, it, expect } from "vitest"

import {
  slackPreCheck,
  slackFetch,
  resolveTarget,
  formatMessages,
  resolveHandles,
  UserCache,
  ChannelCache,
  type FetchImpl,
  type SlackPreCheckResult,
  type SlackResult,
} from "../src/amicode_service/slack_api"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a mock fetchImpl that returns canned Slack-shaped responses keyed by
 *  the Slack API method name (the last path segment of the URL). */
function mockSlackFetch(
  routes: Record<string, { ok: boolean; [k: string]: unknown }>,
  opts?: { status?: number; headers?: Record<string, string> },
): FetchImpl {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url
    const method = u.split("/api/")[1]?.split("?")[0] ?? ""
    const body = routes[method] ?? { ok: false, error: "unknown_method" }
    const status = opts?.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(opts?.headers ?? {}),
      json: async () => body,
    } as Response
  }) as FetchImpl
}

// ===========================================================================
// AC 1 — slackPreCheck
// ===========================================================================

describe("slackPreCheck", () => {
  it("returns ok:true with the token when credential exists", () => {
    const result = slackPreCheck(() => ({ token: "xoxb-test-token" }))
    expect(result).toEqual({ ok: true, token: "xoxb-test-token" })
  })

  it("returns ok:false with not_connected when credential is missing", () => {
    const result = slackPreCheck(() => undefined)
    expect(result).toEqual({
      ok: false,
      reason: "not_connected",
      hint: "Connect Slack in Settings > Connections",
    })
  })
})

// ===========================================================================
// AC 2 — slackFetch
// ===========================================================================

describe("slackFetch", () => {
  it("sends POST with Bearer token and url-encoded body, returns Slack JSON", async () => {
    let capturedUrl = ""
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ ok: true, ts: "123.456" }),
      } as Response
    }) as FetchImpl

    const result = await slackFetch("xoxb-tok", "chat.postMessage", { channel: "C123", text: "hi" }, fetchImpl)
    expect(result.ok).toBe(true)
    expect(capturedUrl).toBe("https://slack.com/api/chat.postMessage")
    expect(capturedInit?.method).toBe("POST")
    expect((capturedInit?.headers as Record<string, string>)["authorization"]).toBe("Bearer xoxb-tok")
    expect((capturedInit?.headers as Record<string, string>)["content-type"]).toBe("application/x-www-form-urlencoded")
  })

  it("handles 429 rate_limited with retry_after", async () => {
    const fetchImpl: FetchImpl = (async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "42" }),
      json: async () => ({ ok: false, error: "rate_limited" }),
    })) as unknown as FetchImpl

    const result = await slackFetch("xoxb-tok", "conversations.list", {}, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("rate_limited")
      expect(result.retry_after).toBe(42)
    }
  })

  it("handles invalid_auth → token_revoked", async () => {
    const fetchImpl = mockSlackFetch({ "auth.test": { ok: false, error: "invalid_auth" } })
    const result = await slackFetch("xoxb-bad", "auth.test", {}, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("token_revoked")
  })

  it("handles missing_scope with the needed scope", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": { ok: false, error: "missing_scope", needed: "channels:read" },
    })
    const result = await slackFetch("xoxb-tok", "conversations.list", {}, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("missing_scope")
      expect(result.scope).toBe("channels:read")
    }
  })

  it("handles network failure gracefully", async () => {
    const fetchImpl: FetchImpl = (async () => { throw new Error("ECONNREFUSED") }) as unknown as FetchImpl
    const result = await slackFetch("xoxb-tok", "chat.postMessage", {}, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("network_error")
  })
})

// ===========================================================================
// AC 3 — resolveTarget
// ===========================================================================

describe("resolveTarget", () => {
  const TOK = "xoxb-test"

  function makeCaches(fetchImpl: FetchImpl) {
    return {
      users: new UserCache(TOK, fetchImpl),
      channels: new ChannelCache(TOK, fetchImpl),
    }
  }

  it("resolves #channel by name via ChannelCache", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "C001", name: "general" },
          { id: "C002", name: "random" },
        ],
      },
    })
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "#random", caches, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.channel_id).toBe("C002")
  })

  it("returns error for unknown #channel", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
    })
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "#nonexistent", caches, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("channel_not_found")
  })

  it("resolves @user → opens DM", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": {
        ok: true,
        members: [{ id: "U001", name: "alice", real_name: "Alice A", profile: { display_name: "alice" } }],
      },
      "conversations.open": { ok: true, channel: { id: "D999" } },
    })
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "@alice", caches, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.channel_id).toBe("D999")
  })

  it("returns error for unknown @user", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": { ok: true, members: [] },
    })
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "@nobody", caches, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("user_not_found")
  })

  it("lists DM channels for 'dms'", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "D001", name: "dm-alice", user: "U001", is_im: true },
          { id: "D002", name: "dm-bob", user: "U002", is_im: true },
        ],
      },
    })
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "dms", caches, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.channels).toHaveLength(2)
      expect(result.channels![0].id).toBe("D001")
    }
  })

  it("passes through raw channel IDs", async () => {
    const fetchImpl = mockSlackFetch({})
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "C12345ABC", caches, fetchImpl)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.channel_id).toBe("C12345ABC")
  })

  it("rejects invalid target strings", async () => {
    const fetchImpl = mockSlackFetch({})
    const caches = makeCaches(fetchImpl)
    const result = await resolveTarget(TOK, "some random thing", caches, fetchImpl)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("invalid_target")
  })
})

// ===========================================================================
// AC 4 — UserCache
// ===========================================================================

describe("UserCache", () => {
  it("resolves a user ID via users.info and caches the result", async () => {
    let callCount = 0
    const fetchImpl = mockSlackFetch({
      "users.info": {
        ok: true,
        user: { id: "U123", name: "jj", real_name: "JJ Lee", profile: { display_name: "JJ" } },
      },
    })
    // Wrap to count calls
    const countingFetch: FetchImpl = (async (...args: Parameters<FetchImpl>) => {
      callCount++
      return fetchImpl(...args)
    }) as FetchImpl

    const cache = new UserCache("xoxb-tok", countingFetch)
    const name1 = await cache.resolve("U123")
    expect(name1).toBe("JJ") // display_name preferred
    const name2 = await cache.resolve("U123")
    expect(name2).toBe("JJ")
    expect(callCount).toBe(1) // only one fetch — cached
  })

  it("falls back to real_name when display_name is empty", async () => {
    const fetchImpl = mockSlackFetch({
      "users.info": {
        ok: true,
        user: { id: "U456", name: "bob", real_name: "Bob B", profile: { display_name: "" } },
      },
    })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    expect(await cache.resolve("U456")).toBe("Bob B")
  })

  it("falls back to user ID when API fails", async () => {
    const fetchImpl = mockSlackFetch({ "users.info": { ok: false, error: "user_not_found" } })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    expect(await cache.resolve("UGONE")).toBe("UGONE")
  })

  it("seed() pre-populates the cache", async () => {
    let called = false
    const fetchImpl: FetchImpl = (async () => { called = true; return new Response() }) as unknown as FetchImpl
    const cache = new UserCache("xoxb-tok", fetchImpl)
    cache.seed([{ id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Ali" } }])
    expect(await cache.resolve("U001")).toBe("Ali")
    expect(called).toBe(false) // no network hit
  })
})

// ===========================================================================
// AC 5 — ChannelCache
// ===========================================================================

describe("ChannelCache", () => {
  it("resolves a channel name to its ID via conversations.list", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "C001", name: "general" },
          { id: "C002", name: "dev" },
        ],
      },
    })
    const cache = new ChannelCache("xoxb-tok", fetchImpl)
    expect(await cache.resolve("dev")).toBe("C002")
  })

  it("loads only once (lazy cache)", async () => {
    let callCount = 0
    const baseFetch = mockSlackFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
    })
    const countingFetch: FetchImpl = (async (...args: Parameters<FetchImpl>) => {
      callCount++
      return baseFetch(...args)
    }) as FetchImpl

    const cache = new ChannelCache("xoxb-tok", countingFetch)
    await cache.resolve("general")
    await cache.resolve("general")
    await cache.resolve("nonexistent")
    expect(callCount).toBe(1)
  })

  it("returns undefined for unknown channels", async () => {
    const fetchImpl = mockSlackFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
    })
    const cache = new ChannelCache("xoxb-tok", fetchImpl)
    expect(await cache.resolve("unknown")).toBeUndefined()
  })

  it("invalidate() forces reload on next resolve", async () => {
    let callCount = 0
    const baseFetch = mockSlackFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
    })
    const countingFetch: FetchImpl = (async (...args: Parameters<FetchImpl>) => {
      callCount++
      return baseFetch(...args)
    }) as FetchImpl

    const cache = new ChannelCache("xoxb-tok", countingFetch)
    await cache.resolve("general")
    expect(callCount).toBe(1)
    cache.invalidate()
    await cache.resolve("general")
    expect(callCount).toBe(2)
  })
})

// ===========================================================================
// AC 6 — formatMessages
// ===========================================================================

describe("formatMessages", () => {
  function seededCache(fetchImpl: FetchImpl): UserCache {
    const cache = new UserCache("xoxb-tok", fetchImpl)
    cache.seed([
      { id: "U001", name: "alice", real_name: "Alice A", profile: { display_name: "Alice" } },
      { id: "U002", name: "bob", real_name: "Bob B", profile: { display_name: "Bob" } },
    ])
    return cache
  }

  it("formats messages as [YYYY-MM-DD HH:MM] sender: text", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    // 1700000000 = 2023-11-14 22:13 UTC
    const out = await formatMessages(
      [{ ts: "1700000000.000000", user: "U001", text: "hello world" }],
      cache,
    )
    // Check format pattern: [YYYY-MM-DD HH:MM] Alice: hello world
    expect(out).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Alice: hello world$/)
  })

  it("resolves <@UXXXXXX> user mentions inline", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{ ts: "1700000000.000000", user: "U001", text: "Hey <@U002> check this" }],
      cache,
    )
    expect(out).toContain("Hey @Bob check this")
  })

  it("shows thread reply count", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{ ts: "1700000000.000000", user: "U001", text: "thread starter", reply_count: 3 }],
      cache,
    )
    expect(out).toContain("(3 replies)")
  })

  it("shows singular reply for count=1", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{ ts: "1700000000.000000", user: "U001", text: "thread", reply_count: 1 }],
      cache,
    )
    expect(out).toContain("(1 reply)")
  })

  it("handles files (images labeled as [image:])", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{
        ts: "1700000000.000000",
        user: "U001",
        text: "see attached",
        files: [{ name: "screenshot.png", mimetype: "image/png" }],
      }],
      cache,
    )
    expect(out).toContain("[image: screenshot.png]")
  })

  it("handles non-image files as [file:]", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{
        ts: "1700000000.000000",
        user: "U001",
        text: "here",
        files: [{ name: "data.csv", mimetype: "text/csv" }],
      }],
      cache,
    )
    expect(out).toContain("[file: data.csv]")
  })

  it("handles attachments", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [{
        ts: "1700000000.000000",
        user: "U001",
        text: "link",
        attachments: [{ text: "A linked article about quantum gates" }],
      }],
      cache,
    )
    expect(out).toContain("attachment: A linked article about quantum gates")
  })

  it("formats multiple messages separated by newlines", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = seededCache(fetchImpl)
    const out = await formatMessages(
      [
        { ts: "1700000000.000000", user: "U001", text: "first" },
        { ts: "1700000060.000000", user: "U002", text: "second" },
      ],
      cache,
    )
    const lines = out.split("\n")
    expect(lines.length).toBeGreaterThanOrEqual(2)
    expect(lines[0]).toContain("Alice: first")
    expect(lines[1]).toContain("Bob: second")
  })
})

// ===========================================================================
// AC 7 — resolveHandles
// ===========================================================================

describe("resolveHandles", () => {
  it("replaces @handle with <@UID> when user is found", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": {
        ok: true,
        members: [
          { id: "U001", name: "alice", real_name: "Alice A", profile: { display_name: "Alice" } },
        ],
      },
    })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    const result = await resolveHandles("Hey @alice, check this out", cache, fetchImpl)
    expect(result).toBe("Hey <@U001>, check this out")
  })

  it("leaves unknown handles as literal text", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": { ok: true, members: [] },
    })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    const result = await resolveHandles("Hi @nobody", cache, fetchImpl)
    expect(result).toBe("Hi @nobody")
  })

  it("does not re-encode already-encoded <@UID> mentions", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": { ok: true, members: [] },
    })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    const result = await resolveHandles("Cc <@U001>", cache, fetchImpl)
    expect(result).toBe("Cc <@U001>")
  })

  it("handles multiple handles in one string", async () => {
    const fetchImpl = mockSlackFetch({
      "users.list": {
        ok: true,
        members: [
          { id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Alice" } },
          { id: "U002", name: "bob", real_name: "Bob", profile: { display_name: "Bob" } },
        ],
      },
    })
    const cache = new UserCache("xoxb-tok", fetchImpl)
    const result = await resolveHandles("@alice and @bob", cache, fetchImpl)
    expect(result).toBe("<@U001> and <@U002>")
  })

  it("returns text unchanged when there are no handles", async () => {
    const fetchImpl = mockSlackFetch({})
    const cache = new UserCache("xoxb-tok", fetchImpl)
    const result = await resolveHandles("no handles here", cache, fetchImpl)
    expect(result).toBe("no handles here")
  })
})

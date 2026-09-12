// amicode_slack_tools.test.ts — behavioral tests for the three Slack MCP tools (#1040).
//
// Credential gating: AMICO_SLACK_FILE points at a temp file; tests write/delete it.
// Slack API: globalThis.fetch is mocked per-test (the slack_api.ts functions use it
// as their default fetchImpl — evaluated at call time, so a mock set before execute()
// flows through slackFetch / UserCache / ChannelCache automatically).
import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolation: temp dirs set BEFORE the dynamic import (same pattern as
// amicode_tools_core.test.ts — the problems module's migration guard skips
// when the env override is set).
const tmpBase = mkdtempSync(join(tmpdir(), "amicode-slack-tools-"))
process.env.AMICODE_PROBLEMS_DIR = mkdtempSync(join(tmpBase, "problems-"))
const slackCredFile = join(tmpBase, "slack.json")
process.env.AMICO_SLACK_FILE = slackCredFile

import type { AmicodeToolDef } from "../src/amicode_tools_core"
const CORE = await import("../src/amicode_tools_core")

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function setConnected(token = "xoxb-test-token") {
  writeFileSync(slackCredFile, JSON.stringify({ token }))
}

function setDisconnected() {
  if (existsSync(slackCredFile)) rmSync(slackCredFile)
}

type Routes = Record<string, { ok: boolean; [k: string]: unknown }>

/** Replace globalThis.fetch with a canned Slack-API responder; returns a teardown. */
function mockFetch(routes: Routes): () => void {
  const saved = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url
    const method = u.split("/api/")[1]?.split("?")[0] ?? ""
    const data = routes[method] ?? { ok: false, error: "unknown_method" }
    return { ok: true, status: 200, headers: new Headers(), json: async () => data } as Response
  }) as typeof globalThis.fetch
  return () => { globalThis.fetch = saved }
}

const def = (name: string) => CORE.AMICODE_TOOLS[name] as AmicodeToolDef
const ctx = { carrier: "test" }

// ===========================================================================
// amicode_slack_list
// ===========================================================================

describe("amicode_slack_list (#1040)", () => {
  afterEach(setDisconnected)

  it("returns not_connected when Slack credential is absent", async () => {
    setDisconnected()
    const out = await def("amicode_slack_list").execute({ kind: "channels", query: null }, ctx)
    const r = JSON.parse(out)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("not_connected")
  })

  it("lists channels with name, topic, and member count", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "C001", name: "general", topic: { value: "Company-wide" }, num_members: 42 },
          { id: "C002", name: "random", topic: { value: "" }, num_members: 10 },
        ],
      },
    })
    try {
      const out = await def("amicode_slack_list").execute({ kind: "channels", query: null }, ctx)
      expect(out).toContain("#general")
      expect(out).toContain("Company-wide")
      expect(out).toContain("42")
      expect(out).toContain("#random")
    } finally { restore() }
  })

  it("lists users with handle, display name, and status", async () => {
    setConnected()
    const restore = mockFetch({
      "users.list": {
        ok: true,
        members: [
          { id: "U001", name: "alice", real_name: "Alice A", deleted: false, is_bot: false,
            profile: { display_name: "Ali", status_text: "Focusing" } },
          { id: "U002", name: "bob", real_name: "Bob B", deleted: false, is_bot: false,
            profile: { display_name: "Bob", status_text: "" } },
        ],
      },
    })
    try {
      const out = await def("amicode_slack_list").execute({ kind: "users", query: null }, ctx)
      expect(out).toContain("@alice")
      expect(out).toContain("Ali")
      expect(out).toContain("Focusing")
      expect(out).toContain("@bob")
    } finally { restore() }
  })

  it("filters results by query (case-insensitive)", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "C001", name: "general", topic: { value: "" }, num_members: 10 },
          { id: "C002", name: "dev-ops", topic: { value: "" }, num_members: 5 },
        ],
      },
    })
    try {
      const out = await def("amicode_slack_list").execute({ kind: "channels", query: "DEV" }, ctx)
      expect(out).toContain("dev-ops")
      expect(out).not.toContain("general")
    } finally { restore() }
  })

  it("notes truncation when next_cursor is present", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": {
        ok: true,
        channels: [{ id: "C001", name: "general", topic: { value: "" }, num_members: 10 }],
        response_metadata: { next_cursor: "abc123" },
      },
    })
    try {
      const out = await def("amicode_slack_list").execute({ kind: "channels", query: null }, ctx)
      expect(out.toLowerCase()).toContain("truncat")
    } finally { restore() }
  })

  it("rejects an invalid kind", async () => {
    setConnected()
    const out = await def("amicode_slack_list").execute({ kind: "bogus", query: null }, ctx)
    const r = JSON.parse(out)
    expect(r.ok).toBe(false)
  })
})

// ===========================================================================
// amicode_slack_read
// ===========================================================================

describe("amicode_slack_read (#1040)", () => {
  afterEach(setDisconnected)

  it("returns not_connected when Slack credential is absent", async () => {
    setDisconnected()
    const out = await def("amicode_slack_read").execute(
      { target: "#general", limit: null, thread_ts: null }, ctx,
    )
    const r = JSON.parse(out)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("not_connected")
  })

  it("reads channel history and formats messages", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
      "conversations.history": {
        ok: true,
        messages: [{ ts: "1700000000.000000", user: "U001", text: "hello world" }],
      },
      "users.info": {
        ok: true,
        user: { id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Alice" } },
      },
    })
    try {
      const out = await def("amicode_slack_read").execute(
        { target: "#general", limit: null, thread_ts: null }, ctx,
      )
      expect(out).toContain("Alice")
      expect(out).toContain("hello world")
    } finally { restore() }
  })

  it("reads thread replies when thread_ts is given", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1700000000.000000", user: "U001", text: "thread starter" },
          { ts: "1700000060.000000", user: "U001", text: "reply here" },
        ],
      },
      "users.info": {
        ok: true,
        user: { id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Alice" } },
      },
    })
    try {
      const out = await def("amicode_slack_read").execute(
        { target: "#general", limit: null, thread_ts: "1700000000.000000" }, ctx,
      )
      expect(out).toContain("thread starter")
      expect(out).toContain("reply here")
    } finally { restore() }
  })

  it("returns DM overview when target is 'dms'", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": {
        ok: true,
        channels: [
          { id: "D001", name: "dm-alice", user: "U001", is_im: true },
          { id: "D002", name: "dm-bob", user: "U002", is_im: true },
        ],
      },
      "users.info": {
        ok: true,
        user: { id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Alice" } },
      },
    })
    try {
      const out = await def("amicode_slack_read").execute(
        { target: "dms", limit: null, thread_ts: null }, ctx,
      )
      expect(out).toContain("DM with")
    } finally { restore() }
  })

  it("defaults target to 'dms' when null", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": {
        ok: true,
        channels: [{ id: "D001", name: "dm-alice", user: "U001", is_im: true }],
      },
      "users.info": {
        ok: true,
        user: { id: "U001", name: "alice", real_name: "Alice", profile: { display_name: "Alice" } },
      },
    })
    try {
      const out = await def("amicode_slack_read").execute(
        { target: null, limit: null, thread_ts: null }, ctx,
      )
      expect(out).toContain("DM with")
    } finally { restore() }
  })
})

// ===========================================================================
// amicode_slack_send
// ===========================================================================

describe("amicode_slack_send (#1040)", () => {
  afterEach(setDisconnected)

  it("returns not_connected when Slack credential is absent", async () => {
    setDisconnected()
    const out = await def("amicode_slack_send").execute(
      { target: "#general", text: "hello", thread_ts: null }, ctx,
    )
    const r = JSON.parse(out)
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("not_connected")
  })

  it("sends a message to a channel and returns { ok, ts }", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
      "chat.postMessage": { ok: true, ts: "1700000000.000000" },
    })
    try {
      const out = await def("amicode_slack_send").execute(
        { target: "#general", text: "hello", thread_ts: null }, ctx,
      )
      const r = JSON.parse(out)
      expect(r.ok).toBe(true)
      expect(r.ts).toBe("1700000000.000000")
    } finally { restore() }
  })

  it("includes thread_ts when replying in a thread", async () => {
    setConnected()
    let postedParams = ""
    const saved = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : (url as Request).url
      const method = u.split("/api/")[1]?.split("?")[0] ?? ""
      if (method === "chat.postMessage") {
        postedParams = typeof init?.body === "string" ? init.body : ""
      }
      const routes: Routes = {
        "conversations.list": { ok: true, channels: [{ id: "C001", name: "general" }] },
        "chat.postMessage": { ok: true, ts: "1700000099.000000" },
      }
      return {
        ok: true, status: 200, headers: new Headers(),
        json: async () => routes[method] ?? { ok: false },
      } as Response
    }) as typeof globalThis.fetch
    try {
      await def("amicode_slack_send").execute(
        { target: "#general", text: "reply", thread_ts: "1700000000.000000" }, ctx,
      )
      expect(postedParams).toContain("thread_ts")
      expect(postedParams).toContain("1700000000.000000")
    } finally { globalThis.fetch = saved }
  })

  it("returns a helpful hint on not_in_channel", async () => {
    setConnected()
    const restore = mockFetch({
      "conversations.list": { ok: true, channels: [{ id: "C001", name: "secret" }] },
      "chat.postMessage": { ok: false, error: "not_in_channel" },
    })
    try {
      const out = await def("amicode_slack_send").execute(
        { target: "#secret", text: "hi", thread_ts: null }, ctx,
      )
      const r = JSON.parse(out)
      expect(r.ok).toBe(false)
      expect(r.reason).toBe("not_in_channel")
      expect(r.hint).toMatch(/[Ii]nvite/)
    } finally { restore() }
  })

  it("sends to @user by opening a DM", async () => {
    setConnected()
    const restore = mockFetch({
      "users.list": {
        ok: true,
        members: [{ id: "U001", name: "alice", real_name: "Alice",
          profile: { display_name: "Alice" } }],
      },
      "conversations.open": { ok: true, channel: { id: "D001" } },
      "chat.postMessage": { ok: true, ts: "1700000000.000000" },
    })
    try {
      const out = await def("amicode_slack_send").execute(
        { target: "@alice", text: "hey!", thread_ts: null }, ctx,
      )
      const r = JSON.parse(out)
      expect(r.ok).toBe(true)
    } finally { restore() }
  })
})

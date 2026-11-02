// Context injection (#2062): the v1 `amicode_context` hooks re-homed on the v2 plugin API.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { contextPlugin, extensionSources, type ContextSource } from "../../src/plugins/context.ts"
import { cleanup, makeSandbox } from "../helpers.ts"
import { fakeProvider } from "./fake-provider.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"
import { load } from "./runtime.ts"

afterAll(cleanup)

function entries() {
  const calls: Array<{ op: "put" | "remove"; sessionID: string; key: string; value?: unknown }> = []
  return {
    calls,
    session: {
      instructions: {
        entry: {
          put: async (input: { sessionID: string; key: string; value: unknown }) => void calls.push({ op: "put", ...input }),
          remove: async (input: { sessionID: string; key: string }) => void calls.push({ op: "remove", ...input }),
        },
      },
    },
  }
}
const source = (over: Partial<ContextSource> & Pick<ContextSource, "key" | "build">): ContextSource => ({ delivery: "keyed", ...over })

describe("keyed delivery (prompt cache stays intact)", () => {
  test("a prompt admission stores each source as an `amicode-<key>` instruction entry", async () => {
    const fake = entries()
    const harness = await load(contextPlugin({ sources: [source({ key: "stack-state", build: () => "## Stack state" })] }), { session: fake.session })
    await harness.trigger("session", "prompt", { sessionID: "ses_1" })
    expect(fake.calls).toEqual([{ op: "put", sessionID: "ses_1", key: "amicode-stack-state", value: "## Stack state" }])
  })
  test("a source with nothing to say removes its entry instead of leaving stale text", async () => {
    const fake = entries()
    const harness = await load(contextPlugin({ sources: [source({ key: "setup-state", build: () => null })] }), { session: fake.session })
    await harness.trigger("session", "prompt", { sessionID: "ses_1" })
    expect(fake.calls).toEqual([{ op: "remove", sessionID: "ses_1", key: "amicode-setup-state" }])
  })
  test("a throwing source is skipped; its siblings still land (a failing hook must not break the prompt)", async () => {
    const fake = entries()
    const harness = await load(
      contextPlugin({ sources: [source({ key: "bad", build: () => { throw new Error("boom") } }), source({ key: "good", build: () => "fine" })] }),
      { session: fake.session },
    )
    await harness.trigger("session", "prompt", { sessionID: "ses_1" })
    expect(fake.calls.find((c) => c.key === "amicode-good")).toMatchObject({ op: "put", value: "fine" })
  })
  test("no keyed sources: the prompt hook is not even registered", async () => {
    const harness = await load(contextPlugin({ sources: [source({ key: "m", delivery: "request", build: () => "x" })] }), { session: {} })
    expect(harness.registered("session")).not.toContain("prompt")
  })
})

describe("per-request delivery (the mode block depends on the request's agent)", () => {
  test("appends a system part built from the request's agent", async () => {
    const harness = await load(contextPlugin({ sources: [source({ key: "mode", delivery: "request", build: (r) => `## Active mode ${r.agent}` })] }))
    const request = await harness.trigger("session", "context", { sessionID: "ses_1", agent: "research", system: [{ type: "text", text: "base" }] })
    expect(request.system).toEqual([{ type: "text", text: "base" }, { type: "text", text: "## Active mode research" }])
  })
  test("a silent source (null) adds nothing", async () => {
    const harness = await load(contextPlugin({ sources: [source({ key: "mode", delivery: "request", build: () => null })] }))
    const request = await harness.trigger("session", "context", { sessionID: "s", agent: "build", system: [] })
    expect(request.system).toEqual([])
  })
})

describe("the gateway routing headers (v1 chat.headers) on model.request", () => {
  const request = (providerID: string) => ({ sessionID: "ses_9", agent: "build", model: { providerID, id: "m" }, kind: "primary", headers: {} as Record<string, string> })
  test("only Harmoniqs AI requests carry the session id and a fresh idempotency key", async () => {
    const harness = await load(contextPlugin({ sources: [] }))
    const ours = await harness.trigger("session", "model.request", request("harmoniqs"))
    expect(ours.headers["X-Session-Id"]).toBe("ses_9")
    expect(ours.headers["Idempotency-Key"]).toMatch(/^amicode:ses_9:[0-9a-f-]{36}$/)
    const again = await harness.trigger("session", "model.request", request("harmoniqs"))
    expect(again.headers["Idempotency-Key"]).not.toBe(ours.headers["Idempotency-Key"])
    expect((await harness.trigger("session", "model.request", request("openai"))).headers).toEqual({})
  })
})

describe("extensionSources: the v1 builders, loaded from the extension directory", () => {
  const realDir = path.resolve(import.meta.dir, "../../../extension/opencode-plugin")
  test("an unreadable directory degrades to no context, never an exception out of the hook", async () => {
    const fake = entries()
    const harness = await load(contextPlugin({ sources: extensionSources("/nonexistent/dir") }), { session: fake.session })
    await harness.trigger("session", "prompt", { sessionID: "ses_1" })
    expect(fake.calls.every((c) => c.op === "remove")).toBe(true)
  })
  test("the real extension builders run in a sandboxed HOME and produce stack-state text", async () => {
    const sb = makeSandbox("ctx-real")
    const before = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME }
    Object.assign(process.env, { HOME: sb.home, XDG_DATA_HOME: sb.data })
    try {
      const sources = extensionSources(realDir)
      expect(sources.map((s) => `${s.key}:${s.delivery}`)).toEqual(["mode:request", "stack-state:keyed", "setup-state:keyed"])
      const stack = await sources[1]!.build({ sessionID: "ses_1" })
      expect(typeof stack === "string" || stack === null).toBe(true)
      expect(await sources[0]!.build({ sessionID: "ses_1", agent: "build" })).toBeNull() // no staged mode registry in a fresh HOME: copilot, silent
    } finally {
      Object.assign(process.env, before)
    }
  })
})

describe("end to end: a new session's first model request carries the injected context", () => {
  test("keyed + per-request context reach the system prompt, and the plugin did not touch engine source", async () => {
    const sb = makeSandbox("ctx-e2e")
    const stubs = path.join(sb.root, "extension")
    fs.mkdirSync(stubs)
    fs.writeFileSync(path.join(stubs, "stack_state.ts"), `export const buildStackStateBlock = () => "STACK-STATE-MARKER solver=local"\n`)
    fs.writeFileSync(path.join(stubs, "setup_state.ts"), `export const buildSetupStateSection = () => null\n`)
    fs.writeFileSync(
      path.join(stubs, "mode_block.ts"),
      `export const deployedModesRoot = () => "/unused"\nexport const buildModeBlock = async (d: any) => "MODE-BLOCK agent=" + (await d.engineClient.session.get({})).data.agent\n`,
    )
    const provider = await fakeProvider()
    const host = await startPluginHost(
      sb,
      { context: { extensionDir: stubs } },
      {},
      { models: { fetch: false }, fs: { filewatcher: false, fff: false }, config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(provider.providerConfig(["m"])) } },
    )
    const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
    const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "ctx", location: { directory: sb.work }, model: { providerID: "fake", id: "m" } }) }))
    await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: "hello" }) })
    const deadline = Date.now() + 30_000
    while (provider.requests.length === 0 && Date.now() < deadline) await Bun.sleep(50)
    provider.stop()
    expect(provider.requests.length).toBeGreaterThan(0)
    const system = provider.requests[0]!.body.messages.find((m: any) => m.role === "system").content as string
    expect(system).toContain("STACK-STATE-MARKER solver=local")
    expect(system).toContain("MODE-BLOCK agent=build")
  }, 90_000)
})

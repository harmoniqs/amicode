// Provider behaviour (#2062): what the v1 overlay patched into provider/transform.ts, provider.ts and the llm
// protocol, re-homed on the v2 hooks. `model.request` carries only a base URL and headers, so it cannot carry any of
// this; the pieces used are the `context` hook (messages + request options), the `http.request` hook (the wire
// body) and `model.transform` (the default model).
import { afterAll, describe, expect, test } from "bun:test"
import { providerPlugin, repairBedrockMessages, repairConverseBody } from "../../src/plugins/provider.ts"
import { cleanup, makeSandbox, waitFor } from "../helpers.ts"
import { fakeProvider, type Reply } from "./fake-provider.ts"
import { load } from "./runtime.ts"
import { dirHeader, json, startPluginHost } from "./support.ts"

afterAll(cleanup)

const request = (model: { providerID: string; id: string }, options: Record<string, unknown> = {}) => ({
  sessionID: "ses_1",
  agent: "build",
  model,
  system: [] as unknown[],
  messages: [] as any[],
  tools: {},
  options,
})
const defaults = { qwen: { temperature: 0.55, topP: 1 }, bedrock: true, defaultModelGuard: true }

describe("Qwen sampling defaults (context hook options)", () => {
  test("a qwen model with no explicit sampling gets temperature 0.55 and topP 1", async () => {
    const harness = await load(providerPlugin(defaults))
    const input = await harness.trigger("session", "context", request({ providerID: "dashscope", id: "Qwen3-Coder-480B" }))
    expect(input.options).toMatchObject({ temperature: 0.55, topP: 1 })
  })
  test("never overrides a value already on the request", async () => {
    const harness = await load(providerPlugin(defaults))
    const input = await harness.trigger("session", "context", request({ providerID: "x", id: "qwen-max" }, { temperature: 0.1 }))
    expect(input.options).toMatchObject({ temperature: 0.1, topP: 1 })
  })
  test("other models are untouched", async () => {
    const harness = await load(providerPlugin(defaults))
    const input = await harness.trigger("session", "context", request({ providerID: "anthropic", id: "claude-sonnet-5" }, { maxTokens: 10 }))
    expect(input.options).toEqual({ maxTokens: 10 })
  })
  test("`qwen: false` switches the defaults off", async () => {
    const harness = await load(providerPlugin({ ...defaults, qwen: false }))
    const input = await harness.trigger("session", "context", request({ providerID: "x", id: "qwen-max" }))
    expect(input.options).toEqual({})
  })
})

const reasoning = (text: string, metadata?: Record<string, Record<string, unknown>>, encrypted?: string) => ({ type: "reasoning", text, ...(metadata ? { providerMetadata: metadata } : {}), ...(encrypted ? { encrypted } : {}) })
const assistant = (...content: unknown[]) => ({ role: "assistant", content })

describe("Bedrock reasoning fallback (context hook messages)", () => {
  test("signature-less reasoning that has text becomes a text part: the thinking survives instead of emptying the message", () => {
    const messages = [assistant(reasoning("thought about it"))]
    repairBedrockMessages(messages as any)
    expect(messages).toEqual([assistant({ type: "text", text: "thought about it" })])
  })
  test("signed, redacted and `encrypted` reasoning is left alone (Bedrock can replay it)", () => {
    const keep = [reasoning("a", { bedrock: { signature: "sig" } }), reasoning("", { bedrock: { redactedData: "AAAA" } }), reasoning("b", undefined, "enc")]
    const messages = [assistant(...keep)]
    repairBedrockMessages(messages as any)
    expect(messages).toEqual([assistant(...keep)])
  })
  test("a blank signature does not count as signed (the protocol trims it)", () => {
    const messages = [assistant(reasoning("x", { bedrock: { signature: "  " } }))]
    repairBedrockMessages(messages as any)
    expect(messages[0]!.content[0]).toEqual({ type: "text", text: "x" })
  })
  test("empty unsigned reasoning is dropped, and a message left with no content is removed (no `content: []` reaches the API)", () => {
    const messages = [assistant(reasoning("   ")), { role: "user", content: [{ type: "text", text: "hi" }] }]
    repairBedrockMessages(messages as any)
    expect(messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })
  test("user and tool messages are not reasoning-converted", () => {
    const messages = [{ role: "user", content: [reasoning("odd")] }]
    repairBedrockMessages(messages as any)
    expect(messages[0]!.content[0]).toMatchObject({ type: "reasoning" })
  })
  test("the hook only acts on Bedrock models", async () => {
    const harness = await load(providerPlugin(defaults))
    const bedrock = request({ providerID: "amazon-bedrock", id: "anthropic.claude" })
    bedrock.messages = [assistant(reasoning("t"))]
    expect((await harness.trigger("session", "context", bedrock)).messages).toEqual([assistant({ type: "text", text: "t" })])
    const other = request({ providerID: "anthropic", id: "claude" })
    other.messages = [assistant(reasoning("t"))]
    expect((await harness.trigger("session", "context", other)).messages).toEqual([assistant(reasoning("t"))])
  })
  test("`bedrock: false` switches it off", async () => {
    const harness = await load(providerPlugin({ ...defaults, bedrock: false }))
    const bedrock = request({ providerID: "amazon-bedrock", id: "m" })
    bedrock.messages = [assistant(reasoning("t"))]
    expect((await harness.trigger("session", "context", bedrock)).messages).toEqual([assistant(reasoning("t"))])
  })
})

const cachePoint = { cachePoint: { type: "default" } }
const text = (t: string) => ({ text: t })
const reasoningBlock = { reasoningContent: { reasoningText: { text: "r", signature: "s" } } }
const converse = (...messages: Array<{ role: string; content: Array<Record<string, unknown>> }>) => ({ modelId: "m", messages })

describe("Bedrock cache points (the wire body)", () => {
  test("a cachePoint right after a reasoning block is re-anchored on the last non-reasoning block before it", () => {
    const body = converse({ role: "assistant", content: [text("a"), reasoningBlock, cachePoint] })
    expect(repairConverseBody(body)).toBe(true)
    expect(body.messages).toEqual([{ role: "assistant", content: [text("a"), cachePoint, reasoningBlock] }])
  })
  test("a reasoning-only message just loses the cachePoint", () => {
    const body = converse({ role: "assistant", content: [reasoningBlock, cachePoint] })
    expect(repairConverseBody(body)).toBe(true)
    expect(body.messages).toEqual([{ role: "assistant", content: [reasoningBlock] }])
  })
  test("an existing cachePoint after the anchor is not doubled", () => {
    const body = converse({ role: "assistant", content: [text("a"), cachePoint, reasoningBlock, cachePoint] })
    repairConverseBody(body)
    expect(body.messages[0]).toEqual({ role: "assistant", content: [text("a"), cachePoint, reasoningBlock] })
  })
  test("a valid body is reported unchanged", () => {
    const body = converse({ role: "assistant", content: [reasoningBlock, text("a"), cachePoint] }, { role: "user", content: [text("q"), cachePoint] })
    const before = JSON.stringify(body)
    expect(repairConverseBody(body)).toBe(false)
    expect(JSON.stringify(body)).toBe(before)
  })
  test("a message with empty content is dropped", () => {
    const body = converse({ role: "assistant", content: [] }, { role: "user", content: [text("q")] })
    expect(repairConverseBody(body)).toBe(true)
    expect(body.messages).toEqual([{ role: "user", content: [text("q")] }])
  })
})

describe("http.request hook: the request body actually changes", () => {
  const url = "https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude/converse-stream"
  const post = (body: unknown, target = url) => new Request(target, { method: "POST", headers: { "content-type": "application/json", authorization: "AWS4 x" }, body: JSON.stringify(body) })
  const scope = { sessionID: "s", agent: "build", model: { providerID: "amazon-bedrock", id: "m" }, kind: "primary" }

  test("a Converse request with a cachePoint after reasoning is rewritten on the wire", async () => {
    const harness = await load(providerPlugin(defaults))
    const bad = converse({ role: "assistant", content: [text("a"), reasoningBlock, cachePoint] })
    const event = await harness.trigger("session", "http.request", { ...scope, request: post(bad) })
    const sent = await event.request.json()
    expect(sent).toEqual({ modelId: "m", messages: [{ role: "assistant", content: [text("a"), cachePoint, reasoningBlock] }] })
    expect(event.request.url).toBe(url)
    expect(event.request.headers.get("authorization")).toBe("AWS4 x")
    expect(event.request.headers.get("content-length")).toBeNull() // the stale length of the old body must not survive
  })
  test("a valid request is passed through as the very same Request object (no body copy)", async () => {
    const harness = await load(providerPlugin(defaults))
    const original = post(converse({ role: "user", content: [text("q")] }))
    const event = await harness.trigger("session", "http.request", { ...scope, request: original })
    expect(event.request).toBe(original)
  })
  test("only Converse endpoints are touched", async () => {
    const harness = await load(providerPlugin(defaults))
    const original = post(converse({ role: "assistant", content: [reasoningBlock, cachePoint] }), "https://api.openai.com/v1/chat/completions")
    expect((await harness.trigger("session", "http.request", { ...scope, request: original })).request).toBe(original)
  })
  test("an unparsable body is left for the provider to reject", async () => {
    const harness = await load(providerPlugin(defaults))
    const original = new Request(url, { method: "POST", body: "{not json" })
    expect((await harness.trigger("session", "http.request", { ...scope, request: original })).request).toBe(original)
  })
})

describe("default-model guard (model.transform)", () => {
  const editor = (available: string[], current?: { providerID: string; modelID: string }) => {
    let selected = current
    return {
      list: () => available.map((key) => ({ providerID: key.split("/")[0]!, id: key.split("/")[1]! })),
      get: (providerID: string, modelID: string) => (available.includes(`${providerID}/${modelID}`) ? {} : undefined),
      default: { get: () => selected, set: (providerID: string, modelID: string) => void (selected = { providerID, modelID }) },
      selected: () => selected,
    }
  }
  const run = async (e: ReturnType<typeof editor>) => {
    const harness = await load(providerPlugin(defaults), { model: { transform: async (callback: (e: unknown) => void) => (callback(e), { dispose: async () => {} }) } })
    await harness.cleanup()
  }
  test("a configured default whose provider is not available falls back to the first available model instead of failing every new session", async () => {
    const e = editor(["openai/gpt-x", "anthropic/claude-y"], { providerID: "disconnected", modelID: "gone" })
    await run(e)
    expect(e.selected()).toEqual({ providerID: "openai", modelID: "gpt-x" })
  })
  test("an available default is left alone", async () => {
    const e = editor(["openai/gpt-x"], { providerID: "openai", modelID: "gpt-x" })
    await run(e)
    expect(e.selected()).toEqual({ providerID: "openai", modelID: "gpt-x" })
  })
  test("no default configured: nothing is invented", async () => {
    const e = editor(["openai/gpt-x"])
    await run(e)
    expect(e.selected()).toBeUndefined()
  })
})

// ── end to end: real host process, loopback provider, assertions on the bytes the model would have received ──

async function turn(plugins: Record<string, unknown>, model: { provider: string; id: string }, script?: (n: number) => Reply, prompts = ["hello"]) {
  const sb = makeSandbox("prov-e2e")
  const provider = await fakeProvider((_r, n) => script?.(n) ?? { text: "ok" })
  const config = provider.providerConfig([model.id])
  const content = { providers: { [model.provider]: config.providers.fake } }
  const host = await startPluginHost(sb, { context: { extensionDir: null }, ...plugins }, {}, {
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
    config: { directory: sb.serverConfig, project: false, claude: false, content: JSON.stringify(content) },
  })
  const headers = { ...host.auth, ...dirHeader(sb), "content-type": "application/json" }
  const created = await json(await fetch(host.url + "/api/session", { method: "POST", headers, body: JSON.stringify({ title: "p", location: { directory: sb.work }, model: { providerID: model.provider, id: model.id } }) }))
  for (const [index, prompt] of prompts.entries()) {
    await fetch(`${host.url}/api/session/${created.data.id}/prompt`, { method: "POST", headers, body: JSON.stringify({ text: prompt }) })
    await waitFor(() => provider.requests.length > index, { what: `provider request ${index + 1}`, timeoutMs: 30_000 })
    await Bun.sleep(1500) // let the turn finish and the reply be stored before the next prompt
  }
  provider.stop()
  return provider.requests
}

describe("end to end (real host process, loopback provider)", () => {
  test("a qwen model's request body carries the plugin's sampling defaults; with the default off it does not", async () => {
    const [on] = await turn({}, { provider: "fake", id: "qwen-test" })
    expect(on!.body).toMatchObject({ temperature: 0.55, top_p: 1 })
    const [off] = await turn({ provider: { qwen: false } }, { provider: "fake", id: "qwen-test" })
    expect(off!.body.temperature).toBeUndefined()
    expect(off!.body.top_p).toBeUndefined()
  }, 120_000)

  test("signature-less reasoning from an earlier turn reaches a Bedrock-named provider as plain text; with the fallback off it is not text", async () => {
    // the loopback speaks OpenAI chat but is registered under a bedrock provider id, which is what selects the fallback
    const reasoningThenText: Reply = { reasoning: "PRIVATE-THINKING-MARKER", text: "answer" }
    const run = async (plugins: Record<string, unknown>) => {
      const requests = await turn(plugins, { provider: "fake-bedrock", id: "m" }, (n) => (n === 0 ? reasoningThenText : { text: "ok" }), ["first", "second"])
      return JSON.stringify(requests[1]!.body.messages.filter((m: any) => m.role === "assistant"))
    }
    expect(await run({})).toMatch(/"content":"[^"]*PRIVATE-THINKING-MARKER/)
    const without = await run({ provider: { bedrock: false } })
    expect(without).not.toMatch(/"content":"[^"]*PRIVATE-THINKING-MARKER/)
  }, 180_000)
})

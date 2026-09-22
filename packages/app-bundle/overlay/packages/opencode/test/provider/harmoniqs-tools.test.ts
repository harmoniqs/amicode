import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { jsonSchema } from "ai"
import { LLMRequestPrep, isNoToolsProvider } from "@/session/llm/request"

// Harmoniqs AI is an OpenAI-compatible custom provider. Its backend
// (app-harmoniqs-ai) used to hard-reject any request carrying a `tools`
// field with a 400 unsupported_feature error, so LLMRequestPrep.prepare
// stripped resolved tools for this provider. The gateway now translates
// `tools` into a Bedrock Converse toolConfig (app-harmoniqs-ai PR #78), so
// the provider was removed from NO_TOOLS_PROVIDERS and tools flow through
// normally — see packages/opencode/src/session/llm/request.ts.

describe("isNoToolsProvider", () => {
  test("no longer flags the harmoniqs provider", () => {
    expect(isNoToolsProvider("harmoniqs")).toBe(false)
  })

  test("leaves other providers untouched", () => {
    expect(isNoToolsProvider("anthropic")).toBe(false)
    expect(isNoToolsProvider("openai")).toBe(false)
    expect(isNoToolsProvider("")).toBe(false)
  })
})

describe("LLMRequestPrep.prepare - harmoniqs tool calling", () => {
  const sessionID = "test-session-harmoniqs"

  const harmoniqsModel = {
    id: "harmoniqs/harmoniqs-auto",
    providerID: "harmoniqs",
    api: {
      id: "harmoniqs-auto",
      url: "https://app.harmoniqs.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Harmoniqs Auto",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
    limit: { context: 200_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const lookupTool = {
    description: "Look up a value",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
  }

  function baseInput(model: any) {
    return {
      user: {
        id: "msg_user-test",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: model.providerID, modelID: model.api.id },
      } as any,
      sessionID,
      model,
      agent: {
        name: "test",
        mode: "primary",
        options: {},
        permission: [],
      } as any,
      system: [],
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: { lookup: lookupTool },
      provider: { id: model.providerID, options: {} } as any,
      auth: undefined,
      plugin: {
        trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      } as any,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }
  }

  test("no longer strips resolved tools for the harmoniqs provider", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(harmoniqsModel)))
    expect(Object.keys(result.tools)).toContain("lookup")
  })

  test("leaves tools intact for other providers", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(anthropicModel)))
    expect(Object.keys(result.tools)).toContain("lookup")
  })
})

// The app.harmoniqs.ai gateway requires an Idempotency-Key header on every
// tool-capable request for deduplication and billing. The engine injects it at
// the transport level so it works in the TUI, extension, and embedded hosts
// alike — no plugin dependency.

describe("LLMRequestPrep.prepare - harmoniqs idempotency headers", () => {
  const sessionID = "test-session-harmoniqs"

  const harmoniqsModel = {
    id: "harmoniqs/harmoniqs-auto",
    providerID: "harmoniqs",
    api: {
      id: "harmoniqs-auto",
      url: "https://app.harmoniqs.ai/v1",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Harmoniqs Auto",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 128_000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
    limit: { context: 200_000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const lookupTool = {
    description: "Look up a value",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
  }

  function baseInput(model: any) {
    return {
      user: {
        id: "msg_user-test",
        sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "test",
        model: { providerID: model.providerID, modelID: model.api.id },
      } as any,
      sessionID,
      model,
      agent: {
        name: "test",
        mode: "primary",
        options: {},
        permission: [],
      } as any,
      system: [],
      messages: [{ role: "user" as const, content: "Hello" }],
      tools: { lookup: lookupTool },
      provider: { id: model.providerID, options: {} } as any,
      auth: undefined,
      plugin: {
        trigger: (_name: string, _input: unknown, output: unknown) => Effect.succeed(output),
        list: () => Effect.succeed([]),
        init: () => Effect.void,
      } as any,
      flags: { outputTokenMax: 32_000, client: "test" } as any,
      isWorkflow: false,
    }
  }

  test("sends Idempotency-Key header for harmoniqs provider", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(harmoniqsModel)))
    const h = result.headers as Record<string, string | undefined>
    expect(h["Idempotency-Key"]).toBeDefined()
    expect(h["Idempotency-Key"]).toMatch(/^amicode:/)
  })

  test("sends X-Session-Id header for harmoniqs provider", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(harmoniqsModel)))
    const h = result.headers as Record<string, string | undefined>
    expect(h["X-Session-Id"]).toBe(sessionID)
  })

  test("does not send Idempotency-Key for non-harmoniqs providers", async () => {
    const result = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(anthropicModel)))
    const h = result.headers as Record<string, string | undefined>
    expect(h["Idempotency-Key"]).toBeUndefined()
  })

  test("generates unique Idempotency-Key per request", async () => {
    const a = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(harmoniqsModel)))
    const b = await Effect.runPromise(LLMRequestPrep.prepare(baseInput(harmoniqsModel)))
    const ha = a.headers as Record<string, string | undefined>
    const hb = b.headers as Record<string, string | undefined>
    expect(ha["Idempotency-Key"]).not.toBe(hb["Idempotency-Key"])
  })
})

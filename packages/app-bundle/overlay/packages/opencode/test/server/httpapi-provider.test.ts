import { afterAll, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import path from "path"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { markPluginDependenciesReady } from "../fixture/plugin"
import { testEffect } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffect(Layer.mergeAll(testStateLayer, LayerNode.compile(FSUtil.node), httpApiLayer))
const projectOptions = { config: { formatter: false, lsp: false } }
const providerID = "test-oauth-parity"
const oauthURL = "https://example.com/oauth"
const oauthInstructions = "Finish OAuth"

function providerListHasFetch(list: unknown) {
  if (!Array.isArray(list)) return false
  return list.some((item: unknown) => {
    if (typeof item !== "object" || item === null || !("id" in item) || !("options" in item)) return false
    if (item.id !== "google") return false
    if (typeof item.options !== "object" || item.options === null) return false
    return "fetch" in item.options
  })
}

function hasProviderWithFetch(input: unknown, key: "all" | "providers") {
  if (typeof input !== "object" || input === null) return false
  if (key === "all") return "all" in input && providerListHasFetch(input.all)
  return "providers" in input && providerListHasFetch(input.providers)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function providerList(input: unknown, key: "all" | "providers") {
  if (!isRecord(input)) return []
  if (!Array.isArray(input[key])) return []
  return input[key]
}

function providerByID(input: unknown, key: "all" | "providers", id: string) {
  return providerList(input, key).find((provider) => isRecord(provider) && provider.id === id)
}

function hasNonZeroModelCost(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider) || !isRecord(provider.models)) return false
  return Object.values(provider.models).some((model) => {
    if (!isRecord(model) || !isRecord(model.cost) || !isRecord(model.cost.cache)) return false
    return [model.cost.input, model.cost.output, model.cost.cache.read, model.cost.cache.write].some(
      (cost) => typeof cost === "number" && cost > 0,
    )
  })
}

function hasProviderMutationMarker(input: unknown, key: "all" | "providers", id: string) {
  const provider = providerByID(input, key, id)
  if (!isRecord(provider)) return false
  if (provider.name === "mutated-provider") return true
  return isRecord(provider.options) && provider.options.mutatedByPlugin === true
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function writeProviderAuthPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-oauth-parity.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-parity",',
        "  server: async () => ({",
        "    auth: {",
        `      provider: "${providerID}",`,
        "      methods: [",
        '        { type: "api", label: "API key" },',
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderAuthValidationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-oauth-validation.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-validation",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "test-oauth-validation",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          prompts: [",
        "            {",
        '              type: "text",',
        '              key: "token",',
        '              message: "Token",',
        "              validate: (value) => value === 'ok' ? undefined : 'Token must be ok',",
        "            },",
        "          ],",
        "          authorize: async () => ({",
        `            url: "${oauthURL}",`,
        '            method: "code",',
        `            instructions: "${oauthInstructions}",`,
        "            callback: async () => ({ type: 'success', key: 'token' }),",
        "          }),",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderAuthFailurePlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-oauth-failure.ts"),
      [
        "export default {",
        '  id: "test.provider-oauth-failure",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "test-oauth-failure",',
        "      methods: [",
        "        {",
        '          type: "oauth",',
        '          label: "OAuth",',
        "          authorize: async () => {",
        '            throw new Error("Another OpenCode window is already waiting for an OpenAI sign-in. Finish or close the other sign-in, then try again.")',
        "          },",
        "        },",
        "      ],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeFunctionOptionsPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-function-options.ts"),
      [
        "export default {",
        '  id: "test.provider-function-options",',
        "  server: async () => ({",
        "    auth: {",
        '      provider: "google",',
        "      loader: async (_getAuth, provider) => {",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return {",
        '        apiKey: "",',
        "        fetch: async (input, init) => fetch(input, init),",
        "        }",
        "      },",
        "      methods: [{ type: 'api', label: 'API key' }],",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function writeProviderModelsMutationPlugin(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* Effect.promise(() => markPluginDependenciesReady(path.join(dir, ".opencode")))

    yield* fs.writeWithDirs(
      path.join(dir, ".opencode", "plugin", "provider-models-mutation.ts"),
      [
        "export default {",
        '  id: "test.provider-models-mutation",',
        "  server: async () => ({",
        "    provider: {",
        '      id: "google",',
        "      models: async (provider) => {",
        "        const models = Object.fromEntries(",
        "          Object.entries(provider.models ?? {}).map(([id, model]) => [id, { ...model }]),",
        "        )",
        '        provider.name = "mutated-provider"',
        "        provider.options = { ...provider.options, mutatedByPlugin: true }",
        "        for (const model of Object.values(provider.models ?? {})) {",
        "          model.cost = { input: 0, output: 0 }",
        "        }",
        "        return models",
        "      },",
        "    },",
        "  }),",
        "}",
        "",
      ].join("\n"),
    )
  })
}

function setEnvScoped(key: string, value: string) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env[key]
      process.env[key] = value
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }),
  )
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-opencode-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  it.instance(
    "serves OAuth authorize response shapes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const headers = { "x-opencode-directory": directory, "content-type": "application/json" }
      const api = yield* requestAuthorize({
        providerID,
        method: 0,
        headers,
      })
      // method 0 (api-key style) — authorize() resolves with no further
      // redirect; #26474 changed the wire format to JSON `null` so clients
      // can `.json()` parse uniformly instead of getting an empty body
      // that throws.
      expect(api).toEqual({ status: 200, body: "null" })

      const oauth = yield* requestAuthorize({
        providerID,
        method: 1,
        headers,
      })
      expect(JSON.parse(oauth.body)).toEqual({
        url: oauthURL,
        method: "code",
        instructions: oauthInstructions,
      })
    }),
    { ...projectOptions, init: writeProviderAuthPlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth validation errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-validation",
        method: 0,
        inputs: { token: "nope" },
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthValidationFailed",
        data: { field: "token", message: "Token must be ok" },
      })
    }),
    { ...projectOptions, init: writeProviderAuthValidationPlugin },
    30000,
  )

  it.instance(
    "returns OAuth authorization failures to the client",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID: "test-oauth-failure",
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthAuthorizationFailed",
        data: {
          message: "Another OpenCode window is already waiting for an OpenAI sign-in. Finish or close the other sign-in, then try again.",
        },
      })
    }),
    { ...projectOptions, init: writeProviderAuthFailurePlugin },
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "serves provider lists when auth loaders add runtime fetch options",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      yield* setEnvScoped(
        "OPENCODE_AUTH_CONTENT",
        JSON.stringify({
          google: { type: "oauth", refresh: "dummy", access: "dummy", expires: 9999999999999 },
        }),
      )
      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderWithFetch(providerBody, "all")).toBe(false)
      expect(hasProviderWithFetch(configBody, "providers")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
      expect(hasNonZeroModelCost(configBody, "providers", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeFunctionOptionsPlugin },
  )

  it.instance(
    "keeps provider.models hook input mutations out of provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-opencode-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      const providerBody = yield* providerResponse.json
      const configBody = yield* configResponse.json
      expect(hasProviderMutationMarker(providerBody, "all", "google")).toBe(false)
      expect(hasProviderMutationMarker(configBody, "providers", "google")).toBe(false)
      expect(hasNonZeroModelCost(providerBody, "all", "google")).toBe(true)
    }),
    { ...projectOptions, init: writeProviderModelsMutationPlugin },
  )
})

// #1984 — POST /provider/probe: one-token reachability probe with named
// statuses. A fake OpenAI-compatible upstream answers per model id with the
// error shapes Bedrock returns (AccessDenied, Marketplace "not available for
// this account", ValidationException on a profile-only id, throttling), so the
// engine's classifier is exercised end-to-end through Provider.getLanguage.
const PROBE_SECRET = "sk-probe-SECRET-0123456789abcdef"
const probeSeen: { model?: string; authorization?: string | null; maxTokens?: unknown }[] = []

function openAiError(status: number, message: string, type: string, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { message, type, code: type } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

function tokenFloorMessage(floor: number, got: number) {
  return `Invalid 'max_output_tokens': integer below minimum value. Expected a value >= ${floor}, but got ${got} instead.`
}

function probeOk(model: string) {
  return Response.json({
    id: "chatcmpl-probe",
    object: "chat.completion",
    created: 1,
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "p" }, finish_reason: "length" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

const probeUpstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const model = typeof body.model === "string" ? body.model : undefined
    probeSeen.push({
      model,
      authorization: req.headers.get("authorization"),
      maxTokens: body.max_tokens ?? body.max_completion_tokens,
    })
    switch (model) {
      case "probe-ok":
        return Response.json({
          id: "chatcmpl-probe",
          object: "chat.completion",
          created: 1,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: "p" }, finish_reason: "length" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      case "probe-denied":
        return openAiError(
          403,
          `User: arn:aws:iam::123456789012:user/probe is not authorized to perform: bedrock:InvokeModel (key ${PROBE_SECRET})`,
          "AccessDeniedException",
          { "x-amzn-errortype": "AccessDeniedException" },
        )
      case "probe-unavailable":
        return openAiError(403, "This model version is not available for this account.", "AccessDeniedException")
      case "probe-invalid":
        return openAiError(
          400,
          "Invocation of model ID probe-invalid with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.",
          "ValidationException",
        )
      case "probe-throttled":
        return openAiError(429, "Too many requests, please wait before trying again.", "ThrottlingException")
      // #1994: OpenAI-style models on Bedrock enforce a max_output_tokens floor
      // (typically 16); the shapes below are the live messages from 2026-10-28.
      case "probe-floor": {
        const max = Number(body.max_tokens ?? body.max_completion_tokens)
        if (max >= 16) return probeOk(model)
        return openAiError(400, tokenFloorMessage(16, max), "invalid_request_error")
      }
      case "probe-floor-wrapped": {
        const max = Number(body.max_tokens ?? body.max_completion_tokens)
        if (max >= 16) return probeOk(model)
        return openAiError(
          400,
          `The model returned the following errors: ${tokenFloorMessage(16, max)}`,
          "ValidationException",
        )
      }
      case "probe-floor-throttled": {
        const max = Number(body.max_tokens ?? body.max_completion_tokens)
        if (max >= 32) return openAiError(429, "Too many requests, please wait before trying again.", "ThrottlingException")
        return openAiError(400, tokenFloorMessage(32, max), "invalid_request_error")
      }
      case "probe-floor-stuck": {
        // a floor above the probe's cap: the retry (at the cap) is rejected too
        const max = Number(body.max_tokens ?? body.max_completion_tokens)
        return openAiError(
          400,
          `The model returned the following errors: ${tokenFloorMessage(100, max)}`,
          "ValidationException",
        )
      }
      // #1996: live hub messages (2026-10-28), verbatim.
      case "probe-floor-meta": {
        const max = Number(body.max_tokens ?? body.max_completion_tokens)
        if (max >= 16) return probeOk(model)
        return openAiError(400, "`max_output_tokens` The number must be `>= 16`.", "invalid_request_error")
      }
      case "probe-payment":
        return openAiError(402, "Payment Required: please check your current payment status.", "payment_required")
      case "probe-quota-billing":
        return openAiError(
          429,
          "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
          "RESOURCE_EXHAUSTED",
        )
      case "probe-rate-limit":
        return openAiError(429, "Rate limit exceeded", "rate_limit_exceeded")
      case "probe-high-demand":
        return openAiError(
          503,
          "This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.",
          "UNAVAILABLE",
        )
      default:
        return openAiError(500, "unexpected", "InternalServerException")
    }
  },
})
afterAll(() => probeUpstream.stop(true))

function probeModel(id: string) {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    temperature: false,
    tool_call: true,
    release_date: "2025-01-01",
    limit: { context: 100_000, output: 10_000 },
    cost: { input: 0, output: 0 },
    options: {},
  }
}

const probeOptions = {
  config: () => ({
    formatter: false as const,
    lsp: false as const,
    provider: {
      "probe-fake": {
        name: "Probe Fake",
        id: "probe-fake",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: Object.fromEntries(
          [
            "probe-ok",
            "probe-denied",
            "probe-unavailable",
            "probe-invalid",
            "probe-throttled",
            "probe-floor",
            "probe-floor-wrapped",
            "probe-floor-throttled",
            "probe-floor-stuck",
            "probe-floor-meta",
            "probe-payment",
            "probe-quota-billing",
            "probe-rate-limit",
            "probe-high-demand",
          ].map((id) => [
            id,
            probeModel(id),
          ]),
        ),
        options: { apiKey: PROBE_SECRET, baseURL: probeUpstream.url.href.replace(/\/$/, "") },
      },
    },
  }),
}

describe("provider probe HttpApi (#1984)", () => {
  it.instance(
    "classifies ok, denied, unavailable, invalid and rate-limited models with no secret material",
    Effect.gen(function* () {
      probeSeen.length = 0
      const directory = (yield* TestInstance).directory
      const response = yield* request("/provider/probe", {
        method: "POST",
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
        body: JSON.stringify({
          providerID: "probe-fake",
          modelIDs: ["probe-ok", "probe-denied", "probe-unavailable", "probe-invalid", "probe-throttled", "nope"],
        }),
      })
      const text = yield* response.text
      expect(response.status).toBe(200)
      const body = JSON.parse(text)
      expect(body.providerID).toBe("probe-fake")
      type ProbeRow = {
        model: string
        status: string
        latency_ms: number
        reason: string | null
        credential_fp: string | null
      }
      const byModel: Record<string, ProbeRow> = Object.fromEntries(
        (body.results as ProbeRow[]).map((r) => [r.model, r]),
      )
      expect(byModel["probe-ok"].status).toBe("ok")
      expect(byModel["probe-ok"].reason).toBeNull()
      expect(byModel["probe-denied"].status).toBe("denied")
      expect(byModel["probe-unavailable"].status).toBe("unavailable")
      expect(byModel["probe-invalid"].status).toBe("invalid")
      expect(byModel["probe-throttled"].status).toBe("rate-limited")
      // a model id the provider does not list never reaches the network
      expect(byModel["nope"].status).toBe("invalid")
      for (const result of Object.values(byModel)) {
        expect(typeof result.latency_ms).toBe("number")
        expect(result.credential_fp).toMatch(/^[0-9a-f]{16}$/)
      }
      // one stable fingerprint per credential
      expect(new Set(Object.values(byModel).map((r) => r.credential_fp)).size).toBe(1)

      // the probe really went through the configured credential...
      expect(probeSeen.length).toBe(5)
      expect(probeSeen.every((seen) => seen.authorization === `Bearer ${PROBE_SECRET}`)).toBe(true)
      // ...asked for a single output token...
      expect(probeSeen.every((seen) => seen.maxTokens === 1)).toBe(true)
      // ...and no secret material comes back, even when the upstream echoes it
      expect(text).not.toContain(PROBE_SECRET)
      expect(text).not.toContain("SECRET")
      expect(text).not.toContain("Bearer")
    }),
    probeOptions,
    30000,
  )

  it.instance(
    "retries once at a max_output_tokens floor instead of misclassifying the model (#1994)",
    Effect.gen(function* () {
      probeSeen.length = 0
      const directory = (yield* TestInstance).directory
      const response = yield* request("/provider/probe", {
        method: "POST",
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
        body: JSON.stringify({
          providerID: "probe-fake",
          modelIDs: ["probe-floor", "probe-floor-wrapped", "probe-floor-throttled", "probe-floor-stuck"],
        }),
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text)
      type ProbeRow = { model: string; status: string; reason: string | null }
      const byModel: Record<string, ProbeRow> = Object.fromEntries(
        (body.results as ProbeRow[]).map((r) => [r.model, r]),
      )
      const sent = (model: string) => probeSeen.filter((seen) => seen.model === model).map((seen) => seen.maxTokens)

      // rejects 1 with the minimum error, accepts 16 → ok after exactly one retry at the parsed floor
      expect(byModel["probe-floor"]).toMatchObject({ status: "ok", reason: null })
      expect(sent("probe-floor")).toEqual([1, 16])

      // the Bedrock "model returned the following errors" wrapper triggers the same retry
      expect(byModel["probe-floor-wrapped"]).toMatchObject({ status: "ok", reason: null })
      expect(sent("probe-floor-wrapped")).toEqual([1, 16])

      // both attempts rejected → the second attempt's classification
      expect(byModel["probe-floor-throttled"].status).toBe("rate-limited")
      expect(sent("probe-floor-throttled")).toEqual([1, 32])

      // floor above the cap: one retry at the cap (64); the floor error is never `invalid`
      expect(sent("probe-floor-stuck")).toEqual([1, 64])
      expect(byModel["probe-floor-stuck"].status).toBe("error")
      expect(byModel["probe-floor-stuck"].reason).toMatch(/max_output_tokens/)
      expect(byModel["probe-floor-stuck"].reason).toMatch(/64/)
    }),
    probeOptions,
    30000,
  )

  it.instance(
    "Meta's max_output_tokens floor retries at 16; billing is unavailable; a plain 429 stays rate-limited (#1996)",
    Effect.gen(function* () {
      probeSeen.length = 0
      const directory = (yield* TestInstance).directory
      const response = yield* request("/provider/probe", {
        method: "POST",
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
        body: JSON.stringify({
          providerID: "probe-fake",
          modelIDs: ["probe-floor-meta", "probe-payment", "probe-quota-billing", "probe-rate-limit", "probe-high-demand"],
        }),
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text)
      type ProbeRow = { model: string; status: string; reason: string | null }
      const byModel: Record<string, ProbeRow> = Object.fromEntries(
        (body.results as ProbeRow[]).map((r) => [r.model, r]),
      )
      const sent = (model: string) => probeSeen.filter((seen) => seen.model === model).map((seen) => seen.maxTokens)

      // meta: "`max_output_tokens` The number must be `>= 16`." → one retry at 16 → ok
      expect(sent("probe-floor-meta")).toEqual([1, 16])
      expect(byModel["probe-floor-meta"]).toMatchObject({ status: "ok", reason: null })

      // baseten: HTTP 402 Payment Required → unavailable, billing reason; never retried
      expect(byModel["probe-payment"].status).toBe("unavailable")
      expect(byModel["probe-payment"].reason).toMatch(/^billing: payment required/)
      expect(sent("probe-payment")).toEqual([1])

      // google: "exceeded your current quota … billing" (429) is billing, not a transient rate limit
      expect(byModel["probe-quota-billing"].status).toBe("unavailable")
      expect(byModel["probe-quota-billing"].reason).toMatch(/^billing:/)

      // a plain 429 stays rate-limited
      expect(byModel["probe-rate-limit"].status).toBe("rate-limited")

      // google 503 high demand: transient, stays error
      expect(byModel["probe-high-demand"].status).toBe("error")
    }),
    probeOptions,
    30000,
  )

  it.instance(
    "keeps the credential fingerprint stable across probes",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const probe = () =>
        Effect.gen(function* () {
          const response = yield* request("/provider/probe", {
            method: "POST",
            headers: { "x-opencode-directory": directory, "content-type": "application/json" },
            body: JSON.stringify({ providerID: "probe-fake", modelIDs: ["probe-ok"] }),
          })
          return JSON.parse(yield* response.text).results[0].credential_fp as string
        })
      const first = yield* probe()
      const second = yield* probe()
      expect(first).toBe(second)
      expect(first).not.toContain(PROBE_SECRET.slice(0, 8))
    }),
    probeOptions,
    30000,
  )

  it.instance(
    "reports models of an unconnected provider as errors without probing",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/provider/probe", {
        method: "POST",
        headers: { "x-opencode-directory": directory, "content-type": "application/json" },
        body: JSON.stringify({ providerID: "not-connected", modelIDs: ["x"] }),
      })
      expect(response.status).toBe(200)
      const body = JSON.parse(yield* response.text)
      expect(body.results).toHaveLength(1)
      expect(body.results[0]).toMatchObject({ model: "x", status: "error", credential_fp: null })
    }),
    projectOptions,
    30000,
  )
})

// Provider behaviour, on the v2 plugin hooks (#2062, ADR 0039). The v1 overlay patched these into engine source
// (`provider/transform.ts`, `provider/provider.ts`, `llm/cache-policy.ts`, `llm/protocols/bedrock-converse.ts`).
//
// Why not `model.request`: it carries only a base URL and headers, so it can carry none of this. What is used:
//  - `context` hook — the request's messages and `options` (generation settings, then provider options):
//      * Qwen sampling defaults (temperature 0.55, topP 1) when the request sets none;
//      * Bedrock reasoning fallback: reasoning with text but no signature becomes a text part (the Converse API
//        cannot replay it, and the protocol drops it, which can leave an assistant message empty);
//  - `http.request` hook — the wire body: Bedrock rejects a cache point that directly follows a reasoning block
//    ("Cache point cannot be inserted after reasoning block"); the body is repaired by re-anchoring it on the last
//    non-reasoning block. A body that needs no repair is passed through untouched (same Request object), so it stays
//    valid under a SigV4 signature that was computed before the hook ran;
//  - `model.transform` — the default-model guard: a configured default whose provider is not available is replaced
//    by an available model instead of failing every new session.
// Not portable by a plugin: v1's context-overflow/throttling error classification (it lives in the engine's
// `provider-error` and the `retry` hook only sees an already-classified error) and the #1984 reachability probe.
import type { Plugin } from "@opencode/plugin"

export interface ProviderConfig {
  readonly qwen: { readonly temperature: number; readonly topP: number } | false
  readonly bedrock: boolean
  readonly defaultModelGuard: boolean
}

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = { qwen: { temperature: 0.55, topP: 1 }, bedrock: true, defaultModelGuard: true }

const isBedrock = (providerID: string) => providerID.includes("bedrock")

export function providerPlugin(config: ProviderConfig): Plugin.Plugin {
  return {
    id: "amicode.provider",
    setup: async (context) => {
      const registrations: Array<{ dispose: () => Promise<void> }> = []
      registrations.push(
        await context.session.hook("context", (request) => {
          if (config.qwen && request.model.id.toLowerCase().includes("qwen")) {
            request.options.temperature ??= config.qwen.temperature
            request.options.topP ??= config.qwen.topP
          }
          if (config.bedrock && isBedrock(request.model.providerID)) repairBedrockMessages(request.messages)
        }),
      )
      if (config.bedrock)
        registrations.push(
          await context.session.hook("http.request", async (event) => {
            const repaired = await repairedConverseRequest(event.request)
            if (repaired) event.request = repaired
          }),
        )
      if (config.defaultModelGuard)
        registrations.push(
          await context.model.transform((models) => {
            const selected = models.default.get()
            if (!selected || models.get(selected.providerID, selected.modelID)) return
            const fallback = models.list().find((model) => model.providerID !== selected.providerID)
            if (fallback) models.default.set(fallback.providerID, fallback.id)
          }),
        )
      return async () => void (await Promise.all(registrations.map((registration) => registration.dispose())))
    },
  }
}

interface ReasoningLike {
  type: string
  text?: string
  encrypted?: string
  providerMetadata?: Record<string, Record<string, unknown> | undefined>
}
interface MessageLike {
  role: string
  content: unknown[]
}

const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

// What the Bedrock protocol can replay: an encrypted payload, a non-blank signature, or redacted data.
const replayable = (part: ReasoningLike) =>
  nonBlank(part.encrypted) ||
  Object.values(part.providerMetadata ?? {}).some((metadata) => nonBlank(metadata?.signature) || typeof metadata?.redactedData === "string")

/** Mutates `messages` in place: signature-less reasoning with text becomes text, empty reasoning is dropped, and a message left with no content is removed. */
export function repairBedrockMessages(messages: Array<{ role: string; content: unknown }>) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as MessageLike
    if (!Array.isArray(message.content)) continue
    if (message.role === "assistant")
      message.content = message.content.flatMap((part) => {
        const reasoning = part as ReasoningLike
        if (reasoning.type !== "reasoning" || replayable(reasoning)) return [part]
        return nonBlank(reasoning.text) ? [{ type: "text", text: reasoning.text }] : []
      })
    // No provider accepts `content: []`.
    if (message.content.length === 0) messages.splice(index, 1)
  }
}

interface ConverseBody {
  messages?: Array<{ role?: string; content?: Array<Record<string, unknown>> }>
}
const isReasoning = (block: Record<string, unknown>) => "reasoningContent" in block
const isCachePoint = (block: Record<string, unknown>) => "cachePoint" in block

/** Mutates a Converse request body in place; true when something had to be repaired. */
export function repairConverseBody(body: ConverseBody) {
  if (!Array.isArray(body.messages)) return false
  let changed = false
  for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    const out: Array<Record<string, unknown>> = []
    for (const block of message.content) {
      const last = out.at(-1)
      if (!isCachePoint(block) || !last || !isReasoning(last)) {
        out.push(block)
        continue
      }
      changed = true
      const anchor = out.map((candidate) => !isReasoning(candidate) && !isCachePoint(candidate)).lastIndexOf(true)
      const next = out[anchor + 1]
      if (anchor >= 0 && next && !isCachePoint(next)) out.splice(anchor + 1, 0, block)
    }
    message.content = out
  }
  const kept = body.messages.filter((message) => !Array.isArray(message.content) || message.content.length > 0)
  if (kept.length !== body.messages.length) {
    body.messages = kept
    changed = true
  }
  return changed
}

async function repairedConverseRequest(request: Request) {
  if (request.method !== "POST" || !/\/model\/[^/]+\/converse(-stream)?$/.test(new URL(request.url).pathname)) return
  const body = (await request
    .clone()
    .json()
    .catch(() => undefined)) as ConverseBody | undefined
  if (!body || !repairConverseBody(body)) return
  const headers = new Headers(request.headers)
  headers.delete("content-length")
  return new Request(request.url, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal })
}

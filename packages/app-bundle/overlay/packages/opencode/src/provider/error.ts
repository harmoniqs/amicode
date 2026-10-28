import { APICallError } from "ai"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import type { ProviderV2 } from "@opencode-ai/core/provider"
import { isContextOverflow } from "@opencode-ai/llm"

export class HeaderTimeoutError extends Error {
  public override readonly name = "ProviderHeaderTimeoutError"

  constructor(public readonly ms: number) {
    super(`Provider response headers timed out after ${ms}ms`)
  }
}

export class ResponseStreamError extends Error {
  public override readonly name = "ProviderResponseStreamError"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function isOpenAiErrorRetryable(e: APICallError) {
  const status = e.statusCode
  if (!status) return e.isRetryable
  // openai sometimes returns 404 for models that are actually available
  return status === 404 || e.isRetryable
}

// Providers not reliably handled in this function:
// - z.ai: can accept overflow silently (needs token-count/context-window checks)
function message(providerID: ProviderV2.ID, e: APICallError) {
  return iife(() => {
    const msg = e.message
    // Some SDK adapters (e.g. @ai-sdk/amazon-bedrock) coerce a JS `undefined`
    // into the string "undefined" in the Error constructor — treat it the same
    // as an empty message so the real error text from the response body is
    // surfaced instead of "undefined: <actual error>".
    if (msg === "" || msg === "undefined") {
      if (e.responseBody) {
        try {
          const body = JSON.parse(e.responseBody)
          const errMsg = body.message || body.error || body.error?.message
          if (errMsg && typeof errMsg === "string") return errMsg
        } catch {}
        return e.responseBody
      }
      if (e.statusCode) {
        const err = STATUS_CODES[e.statusCode]
        if (err) return err
      }
      return "Unknown error"
    }

    if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
      return msg
    }

    try {
      const body = JSON.parse(e.responseBody)
      // try to extract common error message fields
      const errMsg = body.message || body.error || body.error?.message
      if (errMsg && typeof errMsg === "string") {
        return `${msg}: ${errMsg}`
      }
    } catch {}

    // If responseBody is HTML (e.g. from a gateway or proxy error page),
    // provide a human-readable message instead of dumping raw markup
    if (/^\s*<!doctype|^\s*<html/i.test(e.responseBody)) {
      if (e.statusCode === 401) {
        return "Unauthorized: request was blocked by a gateway or proxy. Your authentication token may be missing or expired — try running `opencode auth login <your provider URL>` to re-authenticate."
      }
      if (e.statusCode === 403) {
        return "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource — check your account and provider settings."
      }
      return msg
    }

    return `${msg}: ${e.responseBody}`
  }).trim()
}

function json(input: unknown) {
  if (typeof input === "string") {
    try {
      const result = JSON.parse(input)
      if (result && typeof result === "object") return result
      return undefined
    } catch {
      return undefined
    }
  }
  if (typeof input === "object" && input !== null) {
    return input
  }
  return undefined
}

export type ParsedStreamError =
  | {
      type: "context_overflow"
      message: string
      responseBody: string
    }
  | {
      type: "api_error"
      message: string
      isRetryable: boolean
      responseBody: string
    }

export function parseStreamError(input: unknown): ParsedStreamError | undefined {
  const raw = json(input)
  const body = typeof raw?.message === "string" ? (json(raw.message) ?? raw) : raw
  if (!body) return

  const responseBody = JSON.stringify(body)
  if (body.type !== "error") return

  switch (body?.error?.code) {
    case "context_length_exceeded":
      return {
        type: "context_overflow",
        message: "Input exceeds context window of this model",
        responseBody,
      }
    case "insufficient_quota":
      return {
        type: "api_error",
        message: "Quota exceeded. Check your plan and billing details.",
        isRetryable: false,
        responseBody,
      }
    case "usage_not_included":
      return {
        type: "api_error",
        message: "To use Codex with your ChatGPT plan, upgrade to Plus: https://chatgpt.com/explore/plus.",
        isRetryable: false,
        responseBody,
      }
    case "invalid_prompt":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Invalid prompt.",
        isRetryable: false,
        responseBody,
      }
    case "server_is_overloaded":
    case "server_error":
      return {
        type: "api_error",
        message: typeof body?.error?.message === "string" ? body?.error?.message : "Server error.",
        isRetryable: true,
        responseBody,
      }
  }
}

export type ParsedAPICallError =
  | {
      type: "context_overflow"
      message: string
      responseBody?: string
    }
  | {
      type: "api_error"
      message: string
      statusCode?: number
      isRetryable: boolean
      responseHeaders?: Record<string, string>
      responseBody?: string
      metadata?: Record<string, string>
    }

export function parseAPICallError(input: { providerID: ProviderV2.ID; error: APICallError }): ParsedAPICallError {
  const m = message(input.providerID, input.error)
  const body = json(input.error.responseBody)
  // Status-code guard: 429 (rate limit) and 5xx (server error) are never
  // context overflow, even when the error message text happens to match the
  // heuristic patterns (e.g. Bedrock ThrottlingException "token throughput
  // limit exceeded" matches /token limit exceeded/i but is a rate limit).
  // The `undefined` status case (stream errors without HTTP metadata) still
  // runs the heuristic — only known non-overflow statuses are excluded.
  const status = input.error.statusCode
  const overflowEligible = status === undefined || (status >= 400 && status < 500 && status !== 429)
  if (overflowEligible && (isContextOverflow(m) || status === 413 || body?.error?.code === "context_length_exceeded")) {
    return {
      type: "context_overflow",
      message: m,
      responseBody: input.error.responseBody,
    }
  }

  const metadata = input.error.url ? { url: input.error.url } : undefined
  return {
    type: "api_error",
    message: m,
    statusCode: input.error.statusCode,
    isRetryable: input.providerID.startsWith("openai") ? isOpenAiErrorRetryable(input.error) : input.error.isRetryable,
    responseHeaders: input.error.responseHeaders,
    responseBody: input.error.responseBody,
    metadata,
  }
}

// #1984: reachability-probe classifier. A one-token probe against a catalog
// model fails in a handful of recognisable ways; each maps to a named status so
// the picker can hide dead models with a reason instead of failing mid-turn.
// Shapes are the ones observed on Bedrock (2026-10-28), but the patterns are
// provider-neutral where possible.
export type ProbeStatus = "ok" | "denied" | "unavailable" | "invalid" | "rate-limited" | "error"

export type ProbeClassification = {
  status: Exclude<ProbeStatus, "ok">
  message: string
}

const UNAVAILABLE =
  /not available for this account|aws[- ]marketplace|marketplace (subscription|agreement)|model access is denied|access to (this|the) model is not|not subscribed/i
const RATE_LIMITED = /throttl|too many requests|rate[- ]?limit|quota exceeded|tokens per (minute|day)/i
const INVALID =
  /validationexception|inference profile|on-demand throughput|invalid model|model identifier is invalid|model[_ ]not[_ ]found|unknown model|no such model|does not exist|is not supported|resourcenotfoundexception/i
const DENIED = /accessdenied|access denied|not authorized|unauthorized|unrecognizedclient|forbidden|permission denied|invalid api key|invalid_api_key|security token/i

function headerValue(headers: Record<string, string> | undefined, name: string) {
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? headers[key] : undefined
}

export function classifyProbeError(input: { providerID: ProviderV2.ID; error: unknown }): ProbeClassification {
  const error = input.error
  if (APICallError.isInstance(error)) {
    const parsed = parseAPICallError({ providerID: input.providerID, error })
    const status = error.statusCode
    const errorType = headerValue(error.responseHeaders, "x-amzn-errortype") ?? ""
    const haystack = [parsed.message, errorType, error.responseBody ?? ""].join("\n")
    if (UNAVAILABLE.test(haystack)) return { status: "unavailable", message: parsed.message }
    if (status === 429 || RATE_LIMITED.test(haystack)) return { status: "rate-limited", message: parsed.message }
    if (status === 404 || INVALID.test(haystack)) return { status: "invalid", message: parsed.message }
    if (status === 401 || status === 403 || DENIED.test(haystack)) return { status: "denied", message: parsed.message }
    return { status: "error", message: parsed.message }
  }
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof HeaderTimeoutError)
      return { status: "error", message: `probe timed out: ${error.message}` }
    if (error.name === "AI_NoSuchModelError" || error.name === "ProviderModelNotFoundError")
      return { status: "invalid", message: error.message }
    const text = `${error.name}: ${error.message}`
    if (UNAVAILABLE.test(text)) return { status: "unavailable", message: error.message }
    if (RATE_LIMITED.test(text)) return { status: "rate-limited", message: error.message }
    if (DENIED.test(text)) return { status: "denied", message: error.message }
    return { status: "error", message: error.message }
  }
  return { status: "error", message: String(error) }
}

export * as ProviderError from "./error"

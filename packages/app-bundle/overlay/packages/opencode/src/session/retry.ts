import type { NamedError } from "@opencode-ai/core/util/error"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Clock, Duration, Effect, Schedule } from "effect"
import { MessageV2 } from "./message-v2"
import { iife } from "@/util/iife"
import { isRecord } from "@/util/record"

export type Err = ReturnType<NamedError["toObject"]>

export const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go"
export const GO_UPSELL_URL = "https://opencode.ai/go"
export type RetryReason = "free_tier_limit" | "account_rate_limit" | (string & {})

export type Retryable = {
  message: string
  action?: {
    reason: RetryReason
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
}

export const RETRY_INITIAL_DELAY = 2000
export const RETRY_BACKOFF_FACTOR = 2
export const RETRY_JITTER_FACTOR = 0.25
export const RETRY_MAX_DELAY_NO_HEADERS = 30_000 // 30 seconds
export const RETRY_MAX_DELAY = 2_147_483_647 // max 32-bit signed integer for setTimeout
export const RETRY_MAX_RETRIES = 5
// #1849: rate limits are a shared-quota condition, not a broken request. A
// provider answering `429, retry-after: 1` to every session at once used to
// get five 1-second retries (~6s) and then killed the turn — and with it any
// subagent. Rate-limited turns instead back off exponentially (the header is
// a floor, never the whole wait) and keep retrying for a time budget.
export const RETRY_RATE_LIMIT_BUDGET = 10 * 60_000 // 10 minutes
export const RETRY_RATE_LIMIT_MAX_DELAY = 60_000 // 1 minute between attempts

const RATE_LIMIT_PATTERN = /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests|too_many_requests/i

const RETRYABLE_MESSAGE_PATTERNS = [
  /429|500|502|503|504|524/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|getaddrinfo|enotfound|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]

function cap(ms: number) {
  return Math.min(ms, RETRY_MAX_DELAY)
}

/** The provider's retry hint in ms (retry-after-ms, retry-after seconds or
 *  HTTP date), or undefined when absent/unparseable/past. */
export function hint(error?: SessionV1.APIError) {
  const headers = error?.data.responseHeaders
  if (!headers) return undefined
  const retryAfterMs = headers["retry-after-ms"]
  if (retryAfterMs) {
    const parsedMs = Number.parseFloat(retryAfterMs)
    if (!Number.isNaN(parsedMs)) return cap(parsedMs)
  }
  const retryAfter = headers["retry-after"]
  if (retryAfter) {
    const parsedSeconds = Number.parseFloat(retryAfter)
    if (!Number.isNaN(parsedSeconds)) return cap(Math.ceil(parsedSeconds * 1000))
    const parsed = Date.parse(retryAfter) - Date.now()
    if (!Number.isNaN(parsed) && parsed > 0) return cap(Math.ceil(parsed))
  }
  return undefined
}

export function delay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  const hinted = hint(error)
  if (hinted !== undefined) return hinted
  if (error?.data.responseHeaders) return cap(exponential(attempt, random))
  return cap(Math.min(exponential(attempt, random), RETRY_MAX_DELAY_NO_HEADERS))
}

function exponential(attempt: number, random: number) {
  const base = RETRY_INITIAL_DELAY * Math.pow(RETRY_BACKOFF_FACTOR, attempt - 1)
  return Math.ceil(base + base * RETRY_JITTER_FACTOR * random)
}

/** True for rate-limit failures (HTTP 429 or a rate-limit message/body). */
export function isRateLimit(error: Err) {
  if (SessionV1.APIError.isInstance(error)) {
    if (error.data.statusCode === 429) return true
    return RATE_LIMIT_PATTERN.test(error.data.message) || RATE_LIMIT_PATTERN.test(error.data.responseBody ?? "")
  }
  const message = isRecord(error.data) ? error.data.message : undefined
  return typeof message === "string" && RATE_LIMIT_PATTERN.test(message)
}

/** The wait before a rate-limited retry: exponential with jitter (capped at
 *  RETRY_RATE_LIMIT_MAX_DELAY), never shorter than the provider's hint. */
export function rateLimitDelay(attempt: number, error?: SessionV1.APIError, random = Math.random()) {
  const backoff = Math.min(exponential(attempt, random), RETRY_RATE_LIMIT_MAX_DELAY)
  return cap(Math.max(backoff, hint(error) ?? 0))
}

export function retryable(error: Err, provider: string) {
  // context overflow errors should not be retried
  if (SessionV1.ContextOverflowError.isInstance(error)) return undefined
  if (SessionV1.APIError.isInstance(error)) {
    const status = error.data.statusCode
    // 5xx errors are transient server failures and should always be retried,
    // even when the provider SDK doesn't explicitly mark them as retryable.
    if (
      !error.data.isRetryable &&
      !(status !== undefined && status >= 500) &&
      !matchesRetryableMessage(error.data.message) &&
      !matchesRetryableMessage(error.data.responseBody)
    )
      return undefined
    if (error.data.responseBody?.includes("FreeUsageLimitError")) {
      return {
        message: GO_UPSELL_MESSAGE,
        action: {
          reason: "free_tier_limit",
          provider,
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      }
    }
    if (error.data.responseBody?.includes("GoUsageLimitError")) {
      const body = parseJSON(error.data.responseBody)
      const workspace = str(body?.metadata?.workspace)
      const limitName = str(body?.metadata?.limitName)
      const retryAfter = num(error.data.responseHeaders?.["retry-after"])
      const resetIn = iife(() => {
        if (retryAfter === undefined) return ""
        const seconds = Math.max(0, Math.ceil(retryAfter))
        const days = Math.floor(seconds / 86_400)
        const hours = Math.floor((seconds % 86_400) / 3_600)
        const minutes = Math.ceil((seconds % 3_600) / 60)
        const unit = (value: number, name: string) => `${value} ${name}${value === 1 ? "" : "s"}`

        if (days > 0) return hours > 0 ? `${unit(days, "day")} ${unit(hours, "hour")}` : unit(days, "day")
        if (hours > 0) return minutes > 0 ? `${unit(hours, "hour")} ${unit(minutes, "minute")}` : unit(hours, "hour")
        return minutes > 0 ? unit(minutes, "minute") : "less than a minute"
      })

      const message = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached. It will reset in ${resetIn}. To continue using this model now, enable usage from your available balance`

      const link = `https://opencode.ai/workspace/${workspace}/go`
      return {
        message: `${message} - ${link}`,
        action: {
          reason: "account_rate_limit",
          provider,
          title: "Go limit reached",
          message,
          label: "open settings",
          link,
        },
      }
    }
    return { message: error.data.message.includes("Overloaded") ? "Provider is overloaded" : error.data.message }
  }

  const message = isRecord(error.data) ? error.data.message : undefined
  if (typeof message !== "string") return undefined
  const lower = message.toLowerCase()
  if (lower.includes("too_many_requests")) return { message: "Too Many Requests" }
  if (lower.includes("exhausted") || lower.includes("unavailable")) return { message: "Provider is overloaded" }
  if (matchesRetryableMessage(message)) return { message }
  return undefined
}

function matchesRetryableMessage(value: unknown) {
  return typeof value === "string" && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value))
}

function str(value: unknown) {
  if (value === undefined || value === null) return ""
  return String(value)
}

function num(value: unknown) {
  const parsed = Number.parseFloat(str(value))
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function parseJSON(value: unknown) {
  return iife(() => {
    try {
      if (typeof value !== "string") return undefined
      return JSON.parse(value)
    } catch {
      return undefined
    }
  })
}

export function policy(opts: {
  provider: string
  parse: (error: unknown) => Err
  set: (input: { attempt: number; message: string; action?: Retryable["action"]; next: number }) => Effect.Effect<void>
}) {
  return Schedule.fromStepWithMetadata(
    Effect.succeed((meta: Schedule.InputMetadata<unknown>) => {
      const error = opts.parse(meta.input)
      const retry = retryable(error, opts.provider)
      if (!retry) return Cause.done(meta.attempt)
      const api = SessionV1.APIError.isInstance(error) ? error : undefined
      // usage-limit upsells (free tier / Go) reset on hours-scale clocks; they
      // keep the attempt cap. Plain rate limits get the time budget.
      const rateLimited = !retry.action && isRateLimit(error)
      const wait = rateLimited ? rateLimitDelay(meta.attempt, api) : delay(meta.attempt, api)
      if (rateLimited) {
        if (meta.elapsed >= RETRY_RATE_LIMIT_BUDGET) return Cause.done(meta.attempt)
      } else if (meta.attempt > RETRY_MAX_RETRIES) return Cause.done(meta.attempt)
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        yield* opts.set({
          attempt: meta.attempt,
          message: retry.message,
          action: retry.action,
          next: now + wait,
        })
        return [meta.attempt, Duration.millis(wait)] as [number, Duration.Duration]
      })
    }),
  )
}

export * as SessionRetry from "./retry"

import { describe, expect, test } from "bun:test"
import { isContextOverflow } from "../src"

describe("provider error classification", () => {
  test("classifies provider token limit messages as context overflow", () => {
    const messages = [
      "tokens in request more than max tokens allowed",
      '{"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}',
      "Requested token count exceeds the model's maximum context length of 131072 tokens.",
      "Input length (265330) exceeds model's maximum context length (262144).",
      "Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
      "The input (516368 tokens) is longer than the model's context length (262144 tokens).",
      "Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
      "Too many tokens",
      "Token limit exceeded",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })

  test("does not classify rate limits as context overflow", () => {
    const messages = [
      "Throttling error: Too many tokens, please wait before trying again.",
      "Rate limit exceeded, please retry after 30 seconds.",
      "Too many requests. Please slow down.",
      "Monthly token limit exceeded",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })

  test("does not classify Bedrock throttling/quota messages as context overflow", () => {
    const messages = [
      // ThrottlingException messages that match broad patterns (too many tokens,
      // token limit exceeded, exceeds the limit) but are throughput limits.
      "Token throughput limit exceeded",
      "Too many tokens per minute for model anthropic.claude-opus-4-8-20250808-v1:0",
      "You have exceeded the model invocation throughput limit of 100000 tokens per minute",
      "Model invocation throughput limit exceeded",
      "Insufficient quota for this request",
      "Request quota exceeded, please try again later",
      "Token throughput quota exceeded: too many tokens per second",
    ]

    expect(messages.some(isContextOverflow)).toBe(false)
  })

  test("still classifies real Bedrock context overflow as context overflow", () => {
    const messages = [
      "Input is too long for requested model. Max input token count: 200000, actual token count: 250000",
      "Input is too long for requested model",
      "Input length 265330 exceeds the context window of 200000 tokens",
    ]

    expect(messages.every(isContextOverflow)).toBe(true)
  })
})

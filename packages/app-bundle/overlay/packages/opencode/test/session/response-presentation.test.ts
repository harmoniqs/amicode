import { describe, it, expect } from "bun:test"
import { Schema } from "effect"
import { ResponsePresentation } from "@opencode-ai/schema"
import { SessionPrompt } from "../../src/session/prompt"

// #1331 (part of #1330): the typed response_presentation contract and its
// presence on every v1 session request path. Provider interpretation, v2
// wire/persistence, and SDK generation are covered by their own slices.
const decode = Schema.decodeUnknownSync(ResponsePresentation)

describe("ResponsePresentation contract (#1331)", () => {
  it("accepts exactly concise, standard, detailed", () => {
    for (const v of ["concise", "standard", "detailed"]) {
      expect(decode(v)).toBe(v)
    }
  })

  it("rejects unknown or empty values", () => {
    expect(() => decode("verbose")).toThrow()
    expect(() => decode("Concise")).toThrow()
    expect(() => decode("")).toThrow()
    expect(() => decode(undefined)).toThrow()
    expect(() => decode(null)).toThrow()
  })

  it("is carried (optionally) on the v1 request contracts", () => {
    expect(SessionPrompt.PromptInput.fields.response_presentation).toBeDefined()
    expect(SessionPrompt.ShellInput.fields.response_presentation).toBeDefined()
    expect(SessionPrompt.CommandInput.fields.response_presentation).toBeDefined()
  })
})

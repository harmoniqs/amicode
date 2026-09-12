import { describe, expect, test } from "bun:test"
import { formatModelValue, parseModelValue } from "./amicode-default-model-value"

describe("amicode default-model value round-trip", () => {
  test("format then parse is identity, incl. model ids with dots/dashes", () => {
    const key = { providerID: "anthropic", modelID: "claude-sonnet-5" }
    expect(formatModelValue(key)).toBe("anthropic/claude-sonnet-5")
    expect(parseModelValue(formatModelValue(key))).toEqual(key)
    expect(parseModelValue("opencode/deepseek-v4-flash-free")).toEqual({
      providerID: "opencode",
      modelID: "deepseek-v4-flash-free",
    })
  })

  test("splits on the FIRST slash so a model id may itself contain slashes", () => {
    expect(parseModelValue("openrouter/meta-llama/llama-3.3")).toEqual({
      providerID: "openrouter",
      modelID: "meta-llama/llama-3.3",
    })
  })

  test("rejects malformed / empty values (→ null, no selection)", () => {
    expect(parseModelValue("")).toBeNull()
    expect(parseModelValue("noslash")).toBeNull()
    expect(parseModelValue("/leading")).toBeNull()
    expect(parseModelValue("trailing/")).toBeNull()
  })
})

import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Prompt, ResponsePresentation } from "../src/prompt"
import { PromptInput } from "../src/prompt-input"

test("response presentation is closed and defaults legacy prompts to standard", () => {
  const decode = Schema.decodeUnknownSync(Prompt)

  expect(decode({ text: "Explain the result", response_presentation: "concise" })).toEqual({
    text: "Explain the result",
    response_presentation: "concise",
  })
  expect(decode({ text: "Explain the result" })).toEqual({
    text: "Explain the result",
    response_presentation: "standard",
  })
  expect(Schema.decodeUnknownSync(ResponsePresentation)("detailed")).toBe("detailed")
  expect(() => decode({ text: "Explain the result", response_presentation: "brief" })).toThrow()
  expect(() => Schema.decodeUnknownSync(PromptInput.Prompt)({ text: "Explain the result", response_presentation: "brief" })).toThrow()
})

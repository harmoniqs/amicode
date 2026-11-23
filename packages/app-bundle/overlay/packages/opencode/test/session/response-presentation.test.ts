import { expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Schema } from "effect"
import { CommandInput, PromptInput } from "../../src/session/prompt"

test("legacy prompt and command inputs preserve response presentation", () => {
  const prompt = Schema.decodeUnknownSync(PromptInput)
  const command = Schema.decodeUnknownSync(CommandInput)

  expect(
    prompt({
      sessionID: "ses_response_presentation",
      parts: [{ type: "text", text: "Explain the result" }],
      response_presentation: "concise",
    }),
  ).toMatchObject({ response_presentation: "concise" })
  expect(
    command({
      sessionID: "ses_response_presentation",
      command: "review",
      arguments: "",
      response_presentation: "detailed",
    }),
  ).toMatchObject({ response_presentation: "detailed" })
  expect(() =>
    prompt({
      sessionID: "ses_response_presentation",
      parts: [{ type: "text", text: "Explain the result" }],
      response_presentation: "brief",
    }),
  ).toThrow()
})

test("legacy user messages decode without a response presentation", () => {
  const user = Schema.decodeUnknownSync(SessionV1.User)({
    id: "msg_response_presentation",
    sessionID: "ses_response_presentation",
    role: "user",
    time: { created: 1 },
    agent: "build",
    model: { providerID: "test", modelID: "test-model" },
  })

  expect(user.response_presentation).toBe("standard")
})

import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Question } from "../src/question"
import { QuestionV1 } from "../src/question-v1"

// Coverage for the question `kind` field (amicode#245): a Free-form Question
// carries kind: "text" and renders as a text card; a Choice Question omits it
// or carries kind: "choice". Back-compat: a payload WITHOUT kind decodes as a
// choice question; an UNKNOWN kind fails decoding loudly rather than silently
// degrading to choice.

const choicePayload = {
  question: "Which environment?",
  header: "Env",
  options: [
    { label: "Dev", description: "Development" },
    { label: "Prod", description: "Production" },
  ],
}

const textPayload = {
  question: "What should we call you?",
  header: "Name",
  options: [],
  kind: "text",
}

const shapes: { name: string; schema: Schema.Decoder<unknown> }[] = [
  { name: "v1 Info (server)", schema: QuestionV1.Info },
  { name: "v1 Prompt (agent-facing)", schema: QuestionV1.Prompt },
  { name: "v2 Info (server)", schema: Question.Info },
  { name: "v2 Prompt (agent-facing)", schema: Question.Prompt },
]

describe.each(shapes)("question kind — $name", ({ schema }) => {
  const decode = Schema.decodeUnknownSync(schema)
  const kindOf = (input: unknown) => (decode(input) as { kind?: string }).kind

  test("a payload without kind decodes (back-compat: a choice question)", () => {
    expect(kindOf(choicePayload)).toBeUndefined()
  })

  test("an explicit choice kind decodes", () => {
    expect(kindOf({ ...choicePayload, kind: "choice" })).toBe("choice")
  })

  test("a text kind decodes", () => {
    expect(kindOf(textPayload)).toBe("text")
  })

  test("an unknown kind fails decoding loudly", () => {
    expect(() => decode({ ...choicePayload, kind: "essay" })).toThrow()
  })
})

import { describe, expect, test } from "bun:test"
import { hasUserReplyAfter, parseAskInput } from "./ask"

describe("parseAskInput", () => {
  test("parses a well-formed ask input", () => {
    expect(parseAskInput({ question: "Which platform?", options: ["transmon", "rydberg"] })).toEqual({
      question: "Which platform?",
      options: ["transmon", "rydberg"],
    })
  })

  test("trims and drops empty/non-string options", () => {
    expect(parseAskInput({ question: "  Pick one  ", options: [" a ", "", 3, null, "b"] })).toEqual({
      question: "Pick one",
      options: ["a", "b"],
    })
  })

  test("malformed input falls back to undefined (collapsed chip)", () => {
    expect(parseAskInput(undefined)).toBeUndefined()
    expect(parseAskInput(null)).toBeUndefined()
    expect(parseAskInput("question")).toBeUndefined()
    expect(parseAskInput({})).toBeUndefined()
    expect(parseAskInput({ question: "", options: ["a"] })).toBeUndefined()
    expect(parseAskInput({ question: "q" })).toBeUndefined()
    expect(parseAskInput({ question: "q", options: [] })).toBeUndefined()
    expect(parseAskInput({ question: "q", options: [1, "", "  "] })).toBeUndefined()
  })

  test("accepts valid details aligned with options", () => {
    expect(
      parseAskInput({
        question: "Which integrator?",
        options: ["Bilinear", "Spline"],
        details: ["PWC exponential — robust default", "Piccolissimo — lower initial violation"],
      }),
    ).toEqual({
      question: "Which integrator?",
      options: ["Bilinear", "Spline"],
      details: ["PWC exponential — robust default", "Piccolissimo — lower initial violation"],
    })
  })

  test("details length mismatch is treated as absent, card still parses", () => {
    expect(parseAskInput({ question: "q", options: ["a", "b"], details: ["only one"] })).toEqual({
      question: "q",
      options: ["a", "b"],
    })
  })

  test("non-string details are treated as absent, card still parses", () => {
    expect(parseAskInput({ question: "q", options: ["a", "b"], details: ["ok", 7] })).toEqual({
      question: "q",
      options: ["a", "b"],
    })
    expect(parseAskInput({ question: "q", options: ["a"], details: "not-an-array" })).toEqual({
      question: "q",
      options: ["a"],
    })
  })

  test("details stay aligned with their option through invalid-option filtering", () => {
    expect(parseAskInput({ question: "q", options: ["a", "", "b"], details: ["da", "dropped", "db"] })).toEqual({
      question: "q",
      options: ["a", "b"],
      details: ["da", "db"],
    })
  })
})

describe("hasUserReplyAfter", () => {
  test("assistant messages after the ask do NOT lock the card", () => {
    expect(
      hasUserReplyAfter(
        [
          { id: "msg_b", role: "assistant" }, // the card's message
          { id: "msg_c", role: "assistant" }, // streamed text after the ask
          { id: "msg_d", role: "assistant" },
        ],
        "msg_b",
      ),
    ).toBe(false)
  })

  test("a user message later in ULID order locks the card", () => {
    expect(
      hasUserReplyAfter(
        [
          { id: "msg_b", role: "assistant" },
          { id: "msg_c", role: "user" },
        ],
        "msg_b",
      ),
    ).toBe(true)
  })

  test("user messages earlier than the card do not lock it", () => {
    expect(
      hasUserReplyAfter(
        [
          { id: "msg_a", role: "user" }, // the prompt that triggered the ask
          { id: "msg_b", role: "assistant" },
        ],
        "msg_b",
      ),
    ).toBe(false)
  })

  test("malformed ids and empty inputs are safe", () => {
    expect(hasUserReplyAfter([], "msg_b")).toBe(false)
    expect(hasUserReplyAfter([{ id: "", role: "user" }], "msg_b")).toBe(false)
    expect(hasUserReplyAfter([{ id: "msg_z", role: "user" }], "")).toBe(false)
  })
})

import { answeredOption } from "./ask"

describe("answeredOption — persisted-pick rehydration (reopen)", () => {
  const parts = (map: Record<string, { type?: string; text?: string }[]>) => (id: string) => map[id] ?? []
  const OPTS = ["transmon", "fluxonium"]
  test("returns the first later user reply when it matches an option", () => {
    const msgs = [
      { id: "m1", role: "assistant" },
      { id: "m2", role: "user" },
      { id: "m3", role: "user" },
    ]
    expect(
      answeredOption(
        msgs,
        parts({ m2: [{ type: "text", text: " transmon " }], m3: [{ type: "text", text: "fluxonium" }] }),
        "m1",
        OPTS,
      ),
    ).toBe("transmon")
  })
  test("a later non-option reply means answered-otherwise → undefined (card static, no highlight)", () => {
    const msgs = [
      { id: "m1", role: "assistant" },
      { id: "m2", role: "user" },
    ]
    expect(
      answeredOption(msgs, parts({ m2: [{ type: "text", text: "actually let's do bosonic" }] }), "m1", OPTS),
    ).toBeUndefined()
  })
  test("no later user reply → undefined (card stays interactive)", () => {
    const msgs = [
      { id: "m1", role: "assistant" },
      { id: "m0", role: "user" },
    ]
    expect(answeredOption(msgs, parts({}), "m1", OPTS)).toBeUndefined()
  })
})

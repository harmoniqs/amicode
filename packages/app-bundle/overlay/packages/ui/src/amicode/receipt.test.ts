import { describe, expect, test } from "bun:test"
import { parseDiffSentinel, receiptText, stripSentinel } from "./receipt"

const LINE =
  'AMICODE_DIFF {"problem":"x-gate","entity":"system","action":"updated","seq":7,"diff":{"levels":{"from":3,"to":4},"params.omega":{"from":null,"to":4.8}}}'

describe("parseDiffSentinel", () => {
  test("parses the LAST line when it is a sentinel", () => {
    const parsed = parseDiffSentinel(`System updated.\nNext step…\n${LINE}`)
    expect(parsed).toMatchObject({ problem: "x-gate", entity: "system", action: "updated", seq: 7 })
    expect(parsed!.diff["levels"]).toEqual({ from: 3, to: 4 })
  })
  test("non-string / no sentinel / sentinel not last / malformed JSON → undefined", () => {
    expect(parseDiffSentinel(undefined)).toBeUndefined()
    expect(parseDiffSentinel("plain prose")).toBeUndefined()
    expect(parseDiffSentinel(`${LINE}\ntrailing prose`)).toBeUndefined()
    expect(parseDiffSentinel("AMICODE_DIFF {nope")).toBeUndefined()
    expect(parseDiffSentinel('AMICODE_DIFF "just-a-string"')).toBeUndefined()
  })
})

describe("receiptText", () => {
  test("one line, pretty entity name, dotted keys rendered bare, from→to", () => {
    const parsed = parseDiffSentinel(LINE)!
    expect(receiptText(parsed)).toBe("System · levels 3→4 · omega 4.8")
  })
  test("create renders bare values (from null), truncation marker key renders as ellipsis", () => {
    const created = parseDiffSentinel(
      'AMICODE_DIFF {"problem":"p","entity":"formulation","action":"created","seq":2,"diff":{"problem_type":{"from":null,"to":"gate_synthesis"},"…":{"from":null,"to":null}}}',
    )!
    expect(receiptText(created)).toBe("Formulation · problem_type gate_synthesis · …")
  })
  test("empty diff falls back to the action", () => {
    const archived = parseDiffSentinel(
      'AMICODE_DIFF {"problem":"p","entity":"problem","action":"archived","seq":9,"diff":{}}',
    )!
    expect(receiptText(archived)).toBe("Problem · archived")
  })
})

describe("stripSentinel", () => {
  test("removes a trailing sentinel line, leaves other text intact", () => {
    expect(stripSentinel(`prose\n${LINE}`)).toBe("prose")
    expect(stripSentinel("prose only")).toBe("prose only")
    expect(stripSentinel(undefined)).toBe("")
  })
})

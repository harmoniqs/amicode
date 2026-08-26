import { describe, expect, test } from "bun:test"
import {
  classifyPresence,
  transitionFor,
  railVisible,
  showsWorkingPresence,
  type StablePresence,
} from "./amico-presence"

describe("classifyPresence", () => {
  test("never engaged, off-domain -> dormant", () => {
    expect(classifyPresence({ everEngaged: false, inDomainTurn: false, working: false })).toBe("dormant")
    expect(classifyPresence({ everEngaged: false, inDomainTurn: false, working: true })).toBe("dormant")
  })

  test("in-domain and working -> on (regardless of prior engagement)", () => {
    expect(classifyPresence({ everEngaged: false, inDomainTurn: true, working: true })).toBe("on")
    expect(classifyPresence({ everEngaged: true, inDomainTurn: true, working: true })).toBe("on")
  })

  test("engaged earlier, now off-domain -> idle (NOT dormant — rail persists)", () => {
    expect(classifyPresence({ everEngaged: true, inDomainTurn: false, working: false })).toBe("idle")
  })

  test("resolved in-domain turn (in-domain, not working) -> idle -> drives settling", () => {
    // once a solve finishes, working flips false; the turn is engaged => idle
    expect(classifyPresence({ everEngaged: true, inDomainTurn: true, working: false })).toBe("idle")
  })
})

describe("transitionFor", () => {
  const cases: Array<[StablePresence, StablePresence, "stepping_in" | "settling" | null]> = [
    ["dormant", "on", "stepping_in"],
    ["idle", "on", "stepping_in"],
    ["on", "idle", "settling"],
    ["on", "dormant", "settling"],
    ["dormant", "idle", null],
    ["idle", "dormant", null],
    ["on", "on", null],
    ["idle", "idle", null],
  ]
  for (const [prev, next, want] of cases) {
    test(`${prev} -> ${next} => ${want}`, () => {
      expect(transitionFor(prev, next)).toBe(want)
    })
  }
})

describe("railVisible", () => {
  test("absent only in dormant", () => {
    expect(railVisible("dormant")).toBe(false)
    for (const s of ["stepping_in", "on", "settling", "idle"] as const) {
      expect(railVisible(s)).toBe(true)
    }
  })
})

describe("showsWorkingPresence", () => {
  test("only on / stepping_in", () => {
    expect(showsWorkingPresence("on")).toBe(true)
    expect(showsWorkingPresence("stepping_in")).toBe(true)
    expect(showsWorkingPresence("settling")).toBe(false)
    expect(showsWorkingPresence("idle")).toBe(false)
    expect(showsWorkingPresence("dormant")).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { parseHarnessState, harnessDegraded, type HarnessViewState } from "./harness"

// amicode#1549 — the composer's harness state is whatever the engine's
// GET /amicode/harness answers, parsed tolerantly: a response without a
// published registry view means "no control" (stock-opencode behavior,
// unchanged); a view with a non-opencode current means the serving harness's
// contract dims agent/model/variant.

const READY_MENU = {
  ok: true,
  harness: "opencode",
  status: "ready",
  options: [
    { id: "opencode", displayName: "opencode (default)", state: "ready", detail: "The default harness.", disabled: false },
    {
      id: "telaio",
      displayName: "telaio (subscription)",
      state: "ready",
      detail: "Serves the Harness Contract v1 API.",
      disabled: false,
    },
  ],
}

describe("parseHarnessState — tolerant, hide-when-unpublished", () => {
  test("a published view parses fully", () => {
    const parsed = parseHarnessState(READY_MENU)
    expect(parsed?.harness).toBe("opencode")
    expect(parsed?.status).toBe("ready")
    expect(parsed?.options).toHaveLength(2)
    expect(parsed?.options[1]?.id).toBe("telaio")
  })

  test("no options (or an empty/invalid list) → undefined: the control stays hidden", () => {
    expect(parseHarnessState({ ok: true, harness: "opencode", status: "ready" })).toBeUndefined()
    expect(parseHarnessState({ ok: true, harness: "opencode", status: "ready", options: [] })).toBeUndefined()
    expect(parseHarnessState({ ok: true, harness: "opencode", options: ["junk"] })).toBeUndefined()
  })

  test("off-shape responses collapse to undefined, never a throw", () => {
    expect(parseHarnessState(undefined)).toBeUndefined()
    expect(parseHarnessState("nope")).toBeUndefined()
    expect(parseHarnessState({ ok: false, harness: "opencode", options: READY_MENU.options })).toBeUndefined()
    expect(parseHarnessState({ ok: true, options: READY_MENU.options })).toBeUndefined()
  })

  test("option entries missing required fields are dropped, not repaired", () => {
    const parsed = parseHarnessState({
      ok: true,
      harness: "telaio",
      status: "ready",
      options: [{ id: "telaio" }, READY_MENU.options[1]],
    })
    expect(parsed?.options.map((o) => o.id)).toEqual(["telaio"])
  })

  test("a reason rides the option when present", () => {
    const parsed = parseHarnessState({
      ok: true,
      harness: "opencode",
      status: "ready",
      options: [{ ...READY_MENU.options[1], disabled: true, reason: "Requires the `harness.telaio` entitlement." }],
    })
    expect(parsed?.options[0]?.reason).toContain("harness.telaio")
  })
})

describe("harnessDegraded — the honest dim under a non-opencode harness", () => {
  test("opencode (or no state) never degrades — today's behavior, unchanged", () => {
    expect(harnessDegraded(undefined)).toBe(false)
    expect(harnessDegraded(parseHarnessState(READY_MENU))).toBe(false)
  })

  test("a telaio current degrades the agent/model/variant slots", () => {
    const state = parseHarnessState({ ...READY_MENU, harness: "telaio" }) as HarnessViewState
    expect(harnessDegraded(state)).toBe(true)
  })
})

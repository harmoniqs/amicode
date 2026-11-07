import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#1203 AC3 — a send during the gap refuses with an honest reason: the
// connection dropped, the message was NOT sent, the draft is still in the
// composer. Never a fake success, never a silent loss.
//
// These are SOURCE assertions (amicode#1203): createPromptSubmit pulls ten
// contexts (router, tabs, sync, permission, …) that have no provider harness in
// this package — the same gap prompt-input-clipboard-structure.test.ts documents
// for its render contract. The gap STATE itself is pinned by
// context/stream-gap.test.ts; this file pins where and how the render layer
// acts on it.

const source = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")

describe("send-during-gap honest refusal (#1203)", () => {
  test("handleSubmit consults the gap before it commits anything", () => {
    const guard = source.indexOf("input.streamGap?.()")
    expect(guard).toBeGreaterThan(-1)
    // the refusal fires before the draft is pushed to history or the input is
    // cleared — on refusal nothing may have happened to the composer state
    const history = source.indexOf("input.addToHistory")
    const clear = source.indexOf("clearInput()")
    expect(history).toBeGreaterThan(guard)
    expect(clear).toBeGreaterThan(guard)
  })

  test("the refusal shows the honest connection-dropped notice (never a fake success)", () => {
    expect(source).toContain("prompt.toast.connectionDropped.title")
    expect(source).toContain("prompt.toast.connectionDropped.description")
  })

  test("the gap is INJECTED, so submission stays testable without the provider tree", () => {
    expect(source).not.toContain("useServerSDK")
    expect(source).toContain("streamGap?: Accessor<boolean>")
  })

  test("both composers derive the gap from the same #638 machine the veil reads", () => {
    for (const composer of ["../prompt-input.tsx", "../prompt-input-v2.tsx"]) {
      const wiring = readFileSync(join(import.meta.dir, composer), "utf8")
      expect(wiring).toContain("createStreamGap")
      expect(wiring).toContain("serverSDK().event.status()")
      expect(wiring).toContain("streamGap,")
    }
  })
})

// #1608 AC6: a send attempted while the engine is OFF is refused with an
// engine-specific message that takes PRECEDENCE over the generic
// connection-dropped (stream-gap) refusal — the specific reason wins.
describe("send-while-engine-off honest refusal (#1608 AC6)", () => {
  test("the engine-off refusal is ordered BEFORE the stream-gap refusal", () => {
    const engineOff = source.indexOf("input.engineOff?.()")
    const streamGap = source.indexOf("input.streamGap?.()")
    expect(engineOff).toBeGreaterThan(-1)
    expect(streamGap).toBeGreaterThan(-1)
    // the specific reason wins: engine-off is consulted first
    expect(engineOff).toBeLessThan(streamGap)
  })

  test("both refusals fire before anything is committed to the composer", () => {
    const engineOff = source.indexOf("input.engineOff?.()")
    const history = source.indexOf("input.addToHistory")
    const clear = source.indexOf("clearInput()")
    expect(history).toBeGreaterThan(engineOff)
    expect(clear).toBeGreaterThan(engineOff)
  })

  test("the engine-off refusal shows an engine-specific notice (not the generic drop)", () => {
    expect(source).toContain("prompt.toast.engineOff.title")
    expect(source).toContain("prompt.toast.engineOff.description")
  })

  test("the engine-off state is INJECTED, so submission stays testable without the provider tree", () => {
    expect(source).toContain("engineOff?: Accessor<boolean>")
  })

  test("both composers wire the engine-off accessor from the global engine signal", () => {
    for (const composer of ["../prompt-input.tsx", "../prompt-input-v2.tsx"]) {
      const wiring = readFileSync(join(import.meta.dir, composer), "utf8")
      expect(wiring).toContain("effectiveEngineState")
      expect(wiring).toContain("engineOff,")
    }
  })
})

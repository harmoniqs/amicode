import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { whenTransitionStarted } from "./transition-started"

// #2158: a new chat's first message waited on `await startTransition(...)`.
// Solid's startTransition promise resolves only when the transition SETTLES —
// every resource the new session page reads under it (messages, diffs, ...).
// On a busy engine each of those reads takes seconds, and Solid keeps ONE
// global transition, so concurrent new chats all waited on the same settle:
// five sessions created over 21 s all sent their first message at the same
// instant. The send only needs the transition callback to have RUN (route
// promoted, prompt retargeted); it does not need the page to finish loading.

// Mirrors solid-js 1.9 startTransition: the callback runs on a microtask, and
// the returned promise is the transition's `done`, which resolves only when
// `settle` is called (a resource still loading on a busy engine).
const solidLikeStart = () => {
  let settle!: () => void
  const done = new Promise<void>((resolve) => (settle = resolve))
  const start = (fn: () => void) =>
    Promise.resolve().then(() => {
      fn()
      return done
    })
  return { start, settle }
}

describe("whenTransitionStarted", () => {
  test("resolves once the callback has run, without waiting for the transition to settle", async () => {
    const { start } = solidLikeStart()
    const order: string[] = []
    const started = whenTransitionStarted(() => void order.push("callback"), start)
    order.push("scheduled")
    await started
    order.push("after")
    expect(order).toEqual(["scheduled", "callback", "after"])
  })

  test("hands back the settle, so the caller can still tell when the page has switched", async () => {
    const { start, settle } = solidLikeStart()
    const { settled } = await whenTransitionStarted(() => {}, start)
    let done = false
    void settled.then(() => (done = true))
    await Promise.resolve()
    expect(done).toBe(false)
    settle()
    await settled
    expect(done).toBe(true)
  })

  test("rejects when the callback throws, so the submit fails loudly instead of hanging", async () => {
    const { start } = solidLikeStart()
    await expect(
      whenTransitionStarted(() => {
        throw new Error("promote failed")
      }, start),
    ).rejects.toThrow("promote failed")
  })
})

// Wiring pin: the new-chat path in submit.ts sends after the transition has
// started, not after it settles; the new-chat gate (and so the "starting"
// notice) is held until the page has switched.
describe("submit wiring", () => {
  const submit = readFileSync(join(import.meta.dir, "submit.ts"), "utf8")
  test("the first send does not await the navigation transition's settle", () => {
    expect(submit).not.toContain("await startTransition(")
    expect(submit).toContain("const { settled } = await whenTransitionStarted(() => {")
    expect(submit).toContain("onNavigation?.(settled)")
  })
  test("the gate is held until the navigation settles", () => {
    expect(submit).toContain("await submitPrompt(event, (settled) => (navigation = settled))")
    expect(submit).toContain("await navigation")
  })
})

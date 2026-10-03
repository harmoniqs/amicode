import { describe, expect, test } from "bun:test"
import { bindConcise, conciseKey, createConciseStore } from "./concise-mode"
import { ServerScope } from "@/utils/server-scope"

// amicode#1651 — the concise switch is per-SESSION state, not per-composer-
// instance state. These pin the store + the binding a composer controller uses,
// so a remount (new chat → session, Changes tab, session switch) cannot reset it.

const scope = ServerScope.local
const dir = "/repo"

describe("concise store (#1651)", () => {
  test("an unknown key reads as off", () => {
    const store = createConciseStore()
    expect(store.get(conciseKey.session(scope, dir, "s1"))).toBe(false)
  })

  test("returns what was set, keys are independent", () => {
    const store = createConciseStore()
    const a = conciseKey.session(scope, dir, "a")
    const b = conciseKey.session(scope, dir, "b")
    store.set(a, true)
    expect(store.get(a)).toBe(true)
    expect(store.get(b)).toBe(false)
    store.set(a, false)
    expect(store.get(a)).toBe(false)
  })

  test("promote carries the draft value to the session and clears the draft", () => {
    const store = createConciseStore()
    const draft = conciseKey.draft(scope, dir, "d1")
    const session = conciseKey.session(scope, dir, "s1")
    store.set(draft, true)
    store.promote(draft, session)
    expect(store.get(session)).toBe(true)
    expect(store.get(draft)).toBe(false)
  })

  test("promote from an unset draft leaves the session untouched", () => {
    const store = createConciseStore()
    const session = conciseKey.session(scope, dir, "s1")
    store.set(session, true)
    store.promote(conciseKey.draft(scope, dir, "d-none"), session)
    expect(store.get(session)).toBe(true)
  })

  test("draft and session keys never collide", () => {
    expect(conciseKey.draft(scope, dir, "x")).not.toBe(conciseKey.session(scope, dir, "x"))
    expect(conciseKey.draft(scope, dir, undefined)).toBe(conciseKey.draft(scope, dir, undefined))
  })
})

describe("concise binding — survives composer remount (#1651)", () => {
  test("a second binding on the same key (a remount) sees the value set by the first", () => {
    const store = createConciseStore()
    const key = conciseKey.session(scope, dir, "s1")
    const first = bindConcise(store, () => key)
    first.set(true)
    const remounted = bindConcise(store, () => key)
    expect(remounted.on()).toBe(true)
  })

  test("new chat → session: the session-page binding reads the promoted value", () => {
    const store = createConciseStore()
    const draft = conciseKey.draft(scope, dir, "d1")
    const session = conciseKey.session(scope, dir, "s1")
    bindConcise(store, () => draft).set(true)
    store.promote(draft, session)
    expect(bindConcise(store, () => session).on()).toBe(true)
  })

  test("session creation failed (no promote): the draft keeps its value for the retry", () => {
    const store = createConciseStore()
    const draft = conciseKey.draft(scope, dir, "d1")
    bindConcise(store, () => draft).set(true)
    expect(bindConcise(store, () => draft).on()).toBe(true)
  })

  test("the binding follows its key: switching sessions restores each value", () => {
    const store = createConciseStore()
    let current = conciseKey.session(scope, dir, "a")
    const binding = bindConcise(store, () => current)
    binding.set(true)
    current = conciseKey.session(scope, dir, "b")
    expect(binding.on()).toBe(false)
    current = conciseKey.session(scope, dir, "a")
    expect(binding.on()).toBe(true)
  })
})

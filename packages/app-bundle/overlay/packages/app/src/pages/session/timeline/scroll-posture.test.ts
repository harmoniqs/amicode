import { describe, expect, test } from "bun:test"
import { createScrollPostureStore, postureUpdate, restoreStep } from "./scroll-posture"

describe("postureUpdate", () => {
  test("saves scrollTop when the reader has left the bottom", () => {
    expect(postureUpdate({ anchoredToBottom: false, scrollTop: 480, scrollHeight: 3000, clientHeight: 600 })).toEqual({
      kind: "save",
      top: 480,
    })
  })

  test("clears when the timeline is following the bottom", () => {
    expect(postureUpdate({ anchoredToBottom: true, scrollTop: 100, scrollHeight: 3000, clientHeight: 600 })).toEqual({
      kind: "clear",
    })
  })

  test("clears when the reader is parked at the bottom even if not anchored", () => {
    expect(postureUpdate({ anchoredToBottom: false, scrollTop: 2395, scrollHeight: 3000, clientHeight: 600 })).toEqual({
      kind: "clear",
    })
  })

  test("clears when the content does not overflow", () => {
    expect(postureUpdate({ anchoredToBottom: false, scrollTop: 0, scrollHeight: 500, clientHeight: 600 })).toEqual({
      kind: "clear",
    })
  })
})

describe("createScrollPostureStore", () => {
  test("remembers a posture per session key", () => {
    const store = createScrollPostureStore()
    store.save("a", 120)
    store.save("b", 900)
    expect(store.get("a")).toBe(120)
    expect(store.get("b")).toBe(900)
    expect(store.get("c")).toBeUndefined()
  })

  test("clear forgets a session", () => {
    const store = createScrollPostureStore()
    store.save("a", 120)
    store.clear("a")
    expect(store.get("a")).toBeUndefined()
  })

  test("evicts the least recently saved session past the limit", () => {
    const store = createScrollPostureStore(2)
    store.save("a", 1)
    store.save("b", 2)
    store.save("a", 3) // refreshes a
    store.save("c", 4) // evicts b
    expect(store.get("a")).toBe(3)
    expect(store.get("b")).toBeUndefined()
    expect(store.get("c")).toBe(4)
  })

  test("get does not mutate or consume the entry", () => {
    const store = createScrollPostureStore()
    store.save("a", 7)
    store.get("a")
    expect(store.get("a")).toBe(7)
  })
})

describe("restoreStep", () => {
  test("applies on the first attempt when off target", () => {
    expect(restoreStep({ current: 0, target: 480, attempt: 0, gesture: false })).toBe("apply")
  })

  test("is done once within tolerance of the target", () => {
    expect(restoreStep({ current: 479, target: 480, attempt: 1, gesture: false })).toBe("done")
  })

  test("re-applies when late layout moved the scroll away", () => {
    expect(restoreStep({ current: 2400, target: 480, attempt: 2, gesture: false })).toBe("apply")
  })

  test("stops after the attempt budget so it never fights the layout forever", () => {
    expect(restoreStep({ current: 2400, target: 480, attempt: 4, gesture: false })).toBe("done")
  })

  test("a real user gesture always wins", () => {
    expect(restoreStep({ current: 0, target: 480, attempt: 0, gesture: true })).toBe("done")
  })
})

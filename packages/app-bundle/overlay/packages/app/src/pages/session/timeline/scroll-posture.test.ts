// harmoniqs/amicode#1251: the chat keeps each session's reading position across
// a session tab switch instead of jumping to the bottom.
import { describe, expect, test } from "bun:test"
import { createScrollPostureStore, restoreScrollPosture } from "./scroll-posture"

const view = (scrollTop: number, scrollHeight = 3000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight })

describe("scroll posture store", () => {
  test("remembers where a reader who scrolled up was, per session", () => {
    const store = createScrollPostureStore()
    store.record("a", view(480))
    store.record("b", view(1200))
    expect(store.get("a")).toBe(480)
    expect(store.get("b")).toBe(1200)
    expect(store.get("c")).toBeUndefined()
  })

  test("a reader at (or near) the bottom has no saved posture, so the session reopens following the bottom", () => {
    const store = createScrollPostureStore()
    store.record("a", view(480))
    store.record("a", view(2395)) // 5px from the bottom
    expect(store.get("a")).toBeUndefined()
  })

  test("content that does not overflow has no saved posture", () => {
    const store = createScrollPostureStore()
    store.record("a", view(0, 500, 600))
    expect(store.get("a")).toBeUndefined()
  })

  test("clear forgets a session", () => {
    const store = createScrollPostureStore()
    store.record("a", view(480))
    store.clear("a")
    expect(store.get("a")).toBeUndefined()
  })
})

// A fake frame clock: `frames` holds the callbacks queued for the next frame.
function clock() {
  let queue: (() => void)[] = []
  return {
    schedule: (fn: () => void) => {
      queue.push(fn)
      return () => (queue = queue.filter((f) => f !== fn))
    },
    tick() {
      const run = queue
      queue = []
      run.forEach((fn) => fn())
    },
    pending: () => queue.length,
  }
}

describe("restoreScrollPosture", () => {
  const setup = (opts: { interrupted?: () => boolean } = {}) => {
    const frames = clock()
    const el = { scrollTop: 0 }
    const applied: number[] = []
    let finished = 0
    const cancel = restoreScrollPosture({
      target: 480,
      read: () => el.scrollTop,
      apply: (top) => {
        applied.push(top)
        el.scrollTop = top
      },
      interrupted: opts.interrupted ?? (() => false),
      schedule: frames.schedule,
      done: () => finished++,
    })
    return { frames, el, applied, finished: () => finished, cancel }
  }

  test("applies the saved position immediately", () => {
    const { el } = setup()
    expect(el.scrollTop).toBe(480)
  })

  test("re-applies when late layout drags the chat back to the bottom", () => {
    const { frames, el } = setup()
    el.scrollTop = 2400 // a late bottom-pull (measure / resize anchor)
    frames.tick()
    expect(el.scrollTop).toBe(480)
  })

  test("ends after a bounded settle window and reports done exactly once", () => {
    const { frames, finished } = setup()
    for (let i = 0; i < 20; i++) frames.tick()
    expect(finished()).toBe(1)
    expect(frames.pending()).toBe(0)
  })

  test("a real user scroll ends the restore immediately and is never overridden", () => {
    let gesture = false
    const { frames, el, finished } = setup({ interrupted: () => gesture })
    gesture = true
    el.scrollTop = 100
    frames.tick()
    expect(el.scrollTop).toBe(100)
    expect(finished()).toBe(1)
    expect(frames.pending()).toBe(0)
  })

  test("cancel (timeline unmounted) stops without reporting done", () => {
    const { frames, finished, cancel } = setup()
    cancel()
    for (let i = 0; i < 20; i++) frames.tick()
    expect(finished()).toBe(0)
  })
})

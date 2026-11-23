// harmoniqs/amicode#1251: switching back to a session the reader left scrolled up
// must re-mark them as "away from the bottom" before the timeline remounts.
// pause() cannot do that (it needs a live, scrollable scroll element, which is
// detached during the switch), so the hook exposes holdUserScrolled().
import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createAutoScroll } from "@opencode-ai/ui/hooks"

const scrollable = () => {
  const el = document.createElement("div")
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => 3000 })
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 600 })
  el.scrollTop = 480
  return el
}

describe("createAutoScroll holdUserScrolled", () => {
  test("marks the reader as scrolled up even with no scroll element attached", () => {
    createRoot((dispose) => {
      const auto = createAutoScroll({ working: () => false })
      expect(auto.userScrolled()).toBe(false)
      auto.holdUserScrolled()
      expect(auto.userScrolled()).toBe(true)
      dispose()
    })
  })

  test("a held reader is not pulled to the bottom by streaming follow", () => {
    createRoot((dispose) => {
      const auto = createAutoScroll({ working: () => true })
      auto.holdUserScrolled()
      const el = scrollable()
      auto.scrollRef(el)
      auto.scrollToBottom()
      expect(el.scrollTop).toBe(480)
      dispose()
    })
  })
})

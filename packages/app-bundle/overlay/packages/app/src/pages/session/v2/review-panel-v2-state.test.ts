import { describe, expect, test } from "bun:test"
import { reviewSidebarOpened, reviewSidebarToggled } from "./review-panel-v2-state"

// amicode#105: the Work Column is SINGLE-PANE — the review panel's file-list
// sidebar never renders (it split the column into two panes and squished the
// chat). Diffs get the full column width; navigation is the changes dropdown.
describe("review panel v2 sidebar policy (single-pane column)", () => {
  test("the sidebar is closed by default", () => {
    expect(reviewSidebarOpened()).toBe(false)
  })

  test("the toggle can never open it — no split at any width", () => {
    expect(reviewSidebarToggled(true)).toBe(false)
    expect(reviewSidebarToggled(false)).toBe(false)
  })

  test("a persisted true from the split-pane era is ignored", () => {
    expect(reviewSidebarOpened(true)).toBe(false)
  })
})

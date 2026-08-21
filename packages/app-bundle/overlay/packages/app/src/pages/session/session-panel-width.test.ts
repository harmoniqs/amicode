import { describe, expect, test } from "bun:test"
import {
  clampSessionPanelWidth,
  clampWorkColumnWidth,
  REVIEW_PANE_WIDTH_MIN,
  REVIEW_PANE_WIDTH_MIN_SPLIT,
  SESSION_PANEL_WIDTH_MIN,
  sessionChatTakesRemainder,
  sessionPanelWidthMax,
  WORK_COLUMN_WIDTH_MIN,
  workColumnWidthMax,
} from "./session-panel-width"

describe("sessionPanelWidthMax", () => {
  test("reserves the unified review pane minimum", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
  })

  test("reserves a larger minimum for split diffs", () => {
    expect(sessionPanelWidthMax({ available: 1700, split: true })).toBe(1700 - REVIEW_PANE_WIDTH_MIN_SPLIT)
    expect(REVIEW_PANE_WIDTH_MIN_SPLIT).toBeGreaterThan(REVIEW_PANE_WIDTH_MIN)
  })

  test("lets the chat panel take everything beyond the review pane minimum", () => {
    // Regression: the old cap was 45% of the window, forcing the review pane
    // to at least 55% of the window regardless of content.
    const available = 3440
    expect(sessionPanelWidthMax({ available, split: false })).toBeGreaterThan(available * 0.45)
  })

  test("never drops below the chat panel minimum on small windows", () => {
    expect(sessionPanelWidthMax({ available: 600, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
    expect(sessionPanelWidthMax({ available: 0, split: false })).toBe(SESSION_PANEL_WIDTH_MIN)
  })
})

describe("clampSessionPanelWidth", () => {
  test("keeps widths already within the limit", () => {
    expect(clampSessionPanelWidth({ width: 800, available: 1700, split: false })).toBe(800)
  })

  test("forces the width down when the window shrinks", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: false })).toBe(1700 - REVIEW_PANE_WIDTH_MIN)
    expect(clampSessionPanelWidth({ width: 1600, available: 1700, split: true })).toBe(
      1700 - REVIEW_PANE_WIDTH_MIN_SPLIT,
    )
  })

  test("holds the chat panel minimum when there is no room for both", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: 700, split: true })).toBe(SESSION_PANEL_WIDTH_MIN)
  })

  test("skips clamping before the layout is measured", () => {
    expect(clampSessionPanelWidth({ width: 1600, available: undefined, split: false })).toBe(1600)
  })
})

describe("work column width (amicode#105 — the column is bounded, the CHAT is the remainder)", () => {
  // The pre-fix philosophy (this file's header): the review pane took whatever
  // the chat left behind — a wide monitor squished the chat into the margin.
  // The work column now owns a bounded width (default 320, user-resizable).
  test("workColumnWidthMax caps the column at 60% of the row", () => {
    expect(workColumnWidthMax(1000)).toBe(600)
  })

  test("workColumnWidthMax never drops below the floor", () => {
    expect(workColumnWidthMax(300)).toBe(WORK_COLUMN_WIDTH_MIN)
  })

  test("clampWorkColumnWidth caps and floors, passes through pre-measure", () => {
    expect(clampWorkColumnWidth({ width: 1500, available: 1000 })).toBe(600)
    expect(clampWorkColumnWidth({ width: 100, available: 1000 })).toBe(WORK_COLUMN_WIDTH_MIN)
    expect(clampWorkColumnWidth({ width: 1500, available: undefined })).toBe(1500)
  })

  test("the chat is the flex remainder only in v2 with the column visible", () => {
    expect(sessionChatTakesRemainder({ newDesign: true, columnVisible: true })).toBe(true)
    expect(sessionChatTakesRemainder({ newDesign: true, columnVisible: false })).toBe(false)
    expect(sessionChatTakesRemainder({ newDesign: false, columnVisible: true })).toBe(false)
  })
})

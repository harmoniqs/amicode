import { describe, expect, test } from "bun:test"
import { TOUR_HEADER_PREFIX, isTourRequest, tourTargetKeys } from "./session-tour"

// The overture score (amicode scores/overture, v3) emits Stage-7 beats as
// question cards with verbatim "Tour · <Surface>" headers; the spotlight keys
// on those strings. These tests pin the header contract from the app side.

const request = (header: string) => ({
  questions: [{ question: "Look here.", header, options: [] }],
})

describe("tourTargetKeys", () => {
  test("maps every scored beat to an always-present anchor", () => {
    // The Composer stop names the real input first, then its column.
    expect(tourTargetKeys(request("Tour · Composer"))).toEqual([
      '[data-component="prompt-input-v2"]',
      '[data-tour-target="composer"]',
    ])
    expect(tourTargetKeys(request("Tour · Tabs"))).toEqual(['[data-tour-target="tabs"]'])
    expect(tourTargetKeys(request("Tour · New chat"))).toEqual(['[data-tour-target="new-chat"]'])
    expect(tourTargetKeys(request("Tour · Sessions"))).toEqual(['[data-tour-target="sessions"]'])
    expect(tourTargetKeys(request("Tour · Context"))).toEqual(['[data-tour-target="context-ring"]'])
    expect(tourTargetKeys(request("Tour · Side panel"))).toEqual(['[data-tour-target="side-panel"]'])
    expect(tourTargetKeys(request("Tour · Status"))).toEqual(['[data-tour-target="status"]'])
    expect(tourTargetKeys(request("Tour · Profile"))).toEqual(['[data-tour-target="profile"]'])
    expect(tourTargetKeys(request("Tour · Settings"))).toEqual(['[data-tour-target="settings"]'])
  })

  // The Pulse Inspector, Preview and the file list all live behind the one
  // panel button, so the score sends a single stop for them.
  test("the panel is one stop, and its old sub-stops are gone", () => {
    expect(tourTargetKeys(request("Tour · Side panel"))).toEqual(['[data-tour-target="side-panel"]'])
    expect(tourTargetKeys(request("Tour · Pulse Inspector"))).toBeUndefined()
    expect(tourTargetKeys(request("Tour · Preview"))).toBeUndefined()
  })

  // Mirrors the 9 stops the score sends in its single tour card, in order.
  // That order is the READING ORDER of the window — the top bar left to right,
  // then the row beneath it, then the composer — so the highlight walks the
  // screen instead of hopping across it.
  const SCORED_STOPS = [
    "Tabs",
    "New chat",
    "Sessions",
    "Status",
    "Side panel",
    "Profile",
    "Settings",
    "Context",
    "Composer",
  ]

  test("every stop the score sends resolves to at least one candidate", () => {
    for (const beat of SCORED_STOPS) {
      const keys = tourTargetKeys(request(`${TOUR_HEADER_PREFIX}${beat}`))
      expect(keys && keys.length).toBeGreaterThan(0)
    }
  })

  // The whole tour rides in ONE card, so the spotlight has to track which
  // question inside it is showing — not just the first.
  test("follows the active question index within a multi-question card", () => {
    const wholeTour = { questions: SCORED_STOPS.map((b) => ({ question: b, header: `Tour · ${b}`, options: [] })) }
    expect(tourTargetKeys(wholeTour, 0)).toEqual(['[data-tour-target="tabs"]'])
    expect(tourTargetKeys(wholeTour, 2)).toEqual(['[data-tour-target="sessions"]'])
    expect(tourTargetKeys(wholeTour, 3)).toEqual(['[data-tour-target="status"]'])
    expect(tourTargetKeys(wholeTour, 7)).toEqual(['[data-tour-target="context-ring"]'])
    expect(tourTargetKeys(wholeTour, 8)?.[0]).toBe('[data-component="prompt-input-v2"]')
    expect(tourTargetKeys(wholeTour, 99)).toBeUndefined()
  })

  test("non-tour questions and unknown beats resolve to nothing", () => {
    expect(tourTargetKeys(request("Profile exists"))).toBeUndefined()
    expect(tourTargetKeys(request(`${TOUR_HEADER_PREFIX}Rail`))).toBeUndefined()
    expect(tourTargetKeys(request(""))).toBeUndefined()
    expect(tourTargetKeys({ questions: [] })).toBeUndefined()
    expect(tourTargetKeys(undefined)).toBeUndefined()
  })

  test("defaults to the first question when no index is given", () => {
    expect(
      tourTargetKeys({
        questions: [
          { question: "x", header: "Tour · Settings", options: [] },
          { question: "y", header: "Tour · Composer", options: [] },
        ],
      }),
    ).toEqual(['[data-tour-target="settings"]'])
  })
})


describe("isTourRequest", () => {
  test("is true for a tour card and false for a real question", () => {
    expect(isTourRequest(request("Tour · Composer"))).toBe(true)
    expect(isTourRequest(request("Your role"))).toBe(false)
    expect(isTourRequest(undefined)).toBe(false)
  })
})

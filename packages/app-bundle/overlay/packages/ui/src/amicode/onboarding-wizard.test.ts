import { describe, expect, test } from "bun:test"
import { shouldShowWizard } from "./onboarding-wizard"

// The wizard is session-zero UI: it must appear exactly once — for a fresh
// profile that was never dismissed — and never fight a filled-in profile.
describe("shouldShowWizard", () => {
  test("fresh profile, not dismissed → show", () => {
    expect(shouldShowWizard({}, false)).toBe(true)
    expect(shouldShowWizard({ affiliation: "", scholar: "", focus: "" }, false)).toBe(true)
  })
  test("any identity field set → never show (wizard or card already filled it)", () => {
    expect(shouldShowWizard({ affiliation: "NYU" }, false)).toBe(false)
    expect(shouldShowWizard({ scholar: "https://scholar.google.com/x" }, false)).toBe(false)
    expect(shouldShowWizard({ focus: "transmon gates" }, false)).toBe(false)
  })
  test("dismissed → never show, even fresh", () => {
    expect(shouldShowWizard({}, true)).toBe(false)
  })
  test("profile not loaded yet → never flash the wizard", () => {
    expect(shouldShowWizard(undefined, false)).toBe(false)
  })
})

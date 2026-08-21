import { describe, expect, test } from "bun:test"
import {
  approvalState,
  boundsText,
  isActionable,
  parseApprovalInput,
  railWarrantChip,
  warrantFor,
  type Warrant,
} from "./approval"

describe("parseApprovalInput", () => {
  test("reads plan_hash, bounds and rationale from the tool input", () => {
    expect(
      parseApprovalInput({
        plan_hash: " 9f2c ",
        bounds: { max_solves: 8, tier: "hpc", max_size_class: "MEDIUM", device: "ro" },
        rationale: "  CZ ladder sweep  ",
      }),
    ).toEqual({
      plan_hash: "9f2c",
      bounds: { max_solves: 8, tier: "hpc", max_size_class: "MEDIUM", device: "ro" },
      rationale: "CZ ladder sweep",
    })
  })

  test("no plan_hash → undefined (caller falls back to the chip)", () => {
    for (const bad of [undefined, null, "plain", {}, { plan_hash: "" }, { plan_hash: "  " }, { plan_hash: 4 }]) {
      expect(parseApprovalInput(bad), JSON.stringify(bad)).toBeUndefined()
    }
  })

  test("bounds are optional — a request with none still parses", () => {
    expect(parseApprovalInput({ plan_hash: "h" })).toEqual({ plan_hash: "h", bounds: {} })
  })

  // A bound the card shows but the gate does not enforce (or the reverse) is worse
  // than an absent one, so unusable values are DROPPED rather than coerced.
  test("unusable bound values are dropped, not guessed", () => {
    expect(
      parseApprovalInput({
        plan_hash: "h",
        bounds: { max_solves: 0, tier: "  ", max_size_class: "LARGE", device: "yes", nonesuch: 1 },
      }),
    ).toEqual({ plan_hash: "h", bounds: {} })
  })

  test("a fractional max_solves is dropped rather than floored", () => {
    expect(parseApprovalInput({ plan_hash: "h", bounds: { max_solves: 1.5 } })?.bounds).toEqual({})
  })

  test("non-object bounds are ignored without rejecting the request", () => {
    expect(parseApprovalInput({ plan_hash: "h", bounds: "lots" })).toEqual({ plan_hash: "h", bounds: {} })
  })
})

const NOW = Date.parse("2026-07-27T20:00:00Z")
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString()

const w = (over: Partial<Warrant> = {}): Warrant => ({
  plan_hash: "9f2c",
  bounds: { max_solves: 8, tier: "free" },
  expires_at: iso(30),
  issued_by: "user:ui",
  ...over,
})

const req = { plan_hash: "9f2c", bounds: { max_solves: 8, tier: "free" } }

describe("warrantFor", () => {
  test("ignores warrants for other plans", () => {
    expect(warrantFor("9f2c", [w({ plan_hash: "other" })], NOW)).toBeUndefined()
  })
  test("prefers the live warrant over a lapsed one", () => {
    const live = w({ expires_at: iso(10) })
    expect(warrantFor("9f2c", [w({ expires_at: iso(-60) }), live], NOW)).toBe(live)
  })
  test("among live warrants, takes the one expiring latest", () => {
    const later = w({ expires_at: iso(90) })
    expect(warrantFor("9f2c", [w({ expires_at: iso(10) }), later], NOW)).toBe(later)
  })
  test("falls back to the most recent lapsed warrant when none is live", () => {
    const recent = w({ expires_at: iso(-5) })
    expect(warrantFor("9f2c", [w({ expires_at: iso(-600) }), recent], NOW)).toBe(recent)
  })
})

describe("approvalState", () => {
  // The read-only interlock, inherited from ask-bridge by construction.
  test("no bridge → unavailable, even when a live warrant exists", () => {
    expect(approvalState(req, [w()], NOW, false)).toEqual({ kind: "unavailable" })
    expect(isActionable(approvalState(req, [w()], NOW, false))).toBe(false)
  })

  test("no warrant → pending, and actionable", () => {
    const s = approvalState(req, [], NOW, true)
    expect(s).toEqual({ kind: "pending" })
    expect(isActionable(s)).toBe(true)
  })

  test("live warrant → granted, and NOT actionable", () => {
    const s = approvalState(req, [w()], NOW, true)
    expect(s.kind).toBe("granted")
    expect(isActionable(s)).toBe(false)
  })

  test("lapsed warrant → expired, and actionable again", () => {
    const s = approvalState(req, [w({ expires_at: iso(-1) })], NOW, true)
    expect(s.kind).toBe("expired")
    expect(isActionable(s)).toBe(true)
  })

  test("expiry exactly at now counts as expired — a warrant must not outlive its instant", () => {
    expect(approvalState(req, [w({ expires_at: iso(0) })], NOW, true).kind).toBe("expired")
  })

  // Fail-closed, matching the gate's treatment of an unresolved estimate (§4.4).
  test("an unparseable expiry reads as expired, never as live", () => {
    expect(approvalState(req, [w({ expires_at: "not-a-date" })], NOW, true).kind).toBe("expired")
  })

  // The card must not pre-empt the gate's §5.1 rule 2 verdict.
  test("a NARROWER granted warrant is still 'granted' — coverage is the gate's call", () => {
    const narrow = w({ bounds: { max_solves: 2 } })
    const s = approvalState({ plan_hash: "9f2c", bounds: { max_solves: 8 } }, [narrow], NOW, true)
    expect(s.kind).toBe("granted")
    // and it reports what was ACTUALLY granted, not what was asked
    expect(s.kind === "granted" && s.warrant.bounds).toEqual({ max_solves: 2 })
  })
})

describe("boundsText", () => {
  test("renders only declared bounds", () => {
    expect(boundsText({ max_solves: 8, tier: "free" })).toBe("8 solves · tier free")
    expect(boundsText({ max_solves: 1 })).toBe("1 solve")
    expect(boundsText({ max_size_class: "MEDIUM", device: "ro" })).toBe("up to MEDIUM · device ro")
  })
  test("empty bounds say so rather than implying unlimited", () => {
    expect(boundsText({})).toBe("no bounds declared")
  })
})

describe("railWarrantChip", () => {
  const w2 = (over: Partial<Warrant> = {}): Warrant => ({
    plan_hash: "9f2c",
    bounds: { max_solves: 8, tier: "free", max_size_class: "MEDIUM" },
    expires_at: iso(30),
    issued_by: "user:ui",
    ...over,
  })

  test("shows consumption against the declared bounds", () => {
    expect(railWarrantChip([w2({ solves_used: 3 })], NOW)).toBe("3 of 8 solves · tier free · up to MEDIUM")
  })

  test("omits the count when the surface did not supply one, rather than guessing 0", () => {
    expect(railWarrantChip([w2()], NOW)).toBe("8 solves · tier free · up to MEDIUM")
  })

  test("no live warrant → no chip", () => {
    expect(railWarrantChip([], NOW)).toBeUndefined()
    expect(railWarrantChip([w2({ expires_at: iso(-1) })], NOW)).toBeUndefined()
  })

  // A chip saying "warranted" with nothing behind it would imply an authorization
  // the gate does not grant, since an omitted bound is a refusal not a default.
  test("a live warrant declaring NO bounds produces no chip", () => {
    expect(railWarrantChip([w2({ bounds: {} })], NOW)).toBeUndefined()
  })

  test("among live warrants, reports the one expiring latest (what the gate checks)", () => {
    const later = w2({ expires_at: iso(90), bounds: { max_solves: 2 }, solves_used: 1 })
    expect(railWarrantChip([w2({ solves_used: 7 }), later], NOW)).toBe("1 of 2 solves")
  })

  test("an unparseable expiry is not live", () => {
    expect(railWarrantChip([w2({ expires_at: "nope" })], NOW)).toBeUndefined()
  })
})

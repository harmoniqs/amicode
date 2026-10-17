// #1818: the stream self-heal edge predicates, extracted from problem.ts when
// the rail that used them to refetch retired. The transcript's own receipt
// rendering still consumes them (a resync must heal the view even though the
// rail that refetched is gone), so the predicates keep their exact semantics
// and their exact tests, moved verbatim from problem.test.ts.
import { describe, expect, test } from "bun:test"
import { shouldRefetchOnReconnect, shouldRefetchOnResync } from "./refetch-edge"

describe("shouldRefetchOnReconnect (the view self-heals on disconnect→connect edge)", () => {
  test("initial connect (undefined → true) does NOT refetch", () => {
    expect(shouldRefetchOnReconnect(undefined, true)).toBe(false)
  })
  test("reconnect (false → true) DOES refetch — the rising edge after a real disconnect", () => {
    expect(shouldRefetchOnReconnect(false, true)).toBe(true)
  })
  test("steadily connected (true → true) does NOT refetch", () => {
    expect(shouldRefetchOnReconnect(true, true)).toBe(false)
  })
  test("going down (true → false) does NOT refetch", () => {
    expect(shouldRefetchOnReconnect(true, false)).toBe(false)
  })
})

describe("#1617 — shouldRefetchOnResync (the view heals a WEDGE, which never produces a false→true edge)", () => {
  test("a resync token that advances DOES refetch (the gap-driven forced bootstrap)", () => {
    // A wedge keeps the socket nominally connected (no disconnect→connect edge),
    // so shouldRefetchOnReconnect never fires. The forced-resync signal — bumped
    // when a gap frame drives a forced bootstrap — is a monotonic token; any
    // advance heals the view.
    expect(shouldRefetchOnResync(0, 1)).toBe(true)
    expect(shouldRefetchOnResync(4, 5)).toBe(true)
  })
  test("first observation (undefined → n) does NOT refetch — nothing to heal yet", () => {
    expect(shouldRefetchOnResync(undefined, 0)).toBe(false)
    expect(shouldRefetchOnResync(undefined, 7)).toBe(false)
  })
  test("an unchanged token does NOT refetch (no feedback loop)", () => {
    expect(shouldRefetchOnResync(3, 3)).toBe(false)
    expect(shouldRefetchOnResync(0, 0)).toBe(false)
  })
})

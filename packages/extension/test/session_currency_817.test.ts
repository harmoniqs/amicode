// Issue #817 — D2/H4 (spec spec-20260905-045114-session-device-lifecycle),
// the REVISED placement: the list-currency token is derived by the CLIENT
// over the projection it fetches — (count, max time_updated, sum
// time_updated) over the rows the list returns, plus the server-reported
// version as the stamp. No server field exists to depend on; the property
// tests are the enforcement of "derived, never hand-bumped".
import { describe, expect, test } from "vitest"
import { deriveCurrencyToken, projectionOf } from "../../app-bundle/overlay/packages/app/src/context/global-sync/session-currency"

const session = (id: string, updated: number) => ({
  id,
  directory: "/home",
  projectID: "p1",
  slug: id,
  version: "test",
  title: `Session ${id}`,
  time: { created: updated, updated },
})

describe("session currency (client-derived over the fetched projection)", () => {
  test("the token is a pure function of the projection and the version stamp", () => {
    const rows = [session("a", 100), session("b", 200)]
    expect(deriveCurrencyToken(rows, "v1.18.29")).toBe(deriveCurrencyToken([...rows], "v1.18.29"))
    expect(deriveCurrencyToken(rows, "v1.18.29")).toBe(deriveCurrencyToken(rows.toReversed(), "v1.18.29"))
  })

  test("the projection is (count, max time_updated, sum time_updated)", () => {
    expect(projectionOf([session("a", 100), session("b", 200), session("c", 50)])).toEqual({
      count: 3,
      maxUpdated: 200,
      sumUpdated: 350,
    })
    expect(projectionOf([])).toEqual({ count: 0, maxUpdated: 0, sumUpdated: 0 })
  })

  test("H4: a same-tick write advances the token (two rows stamped identically)", () => {
    const before = [session("a", 100)]
    // A new session lands with the SAME time_updated as the existing row —
    // the count is what moves, so max/sum alone would not be enough.
    const after = [session("a", 100), session("b", 100)]
    expect(deriveCurrencyToken(after, "v1")).not.toBe(deriveCurrencyToken(before, "v1"))
  })

  test("H4: archive churn advances the token (a row leaves the rendered projection)", () => {
    const before = [session("a", 100), session("b", 200)]
    // b archived out-of-band: the default list renders only a.
    const after = [session("a", 100)]
    expect(deriveCurrencyToken(after, "v1")).not.toBe(deriveCurrencyToken(before, "v1"))
  })

  test("H4: a delete-then-touch pair advances the token", () => {
    const before = [session("a", 100), session("b", 200)]
    // b deleted, a touched forward — count and max both move.
    const after = [session("a", 300)]
    expect(deriveCurrencyToken(after, "v1")).not.toBe(deriveCurrencyToken(before, "v1"))
  })

  test("H4: an out-of-band write (direct SQL, migration) advances the token", () => {
    const before = [session("a", 100)]
    // A row's time_updated changed under the client; the projection moves.
    const after = [session("a", 150)]
    expect(deriveCurrencyToken(after, "v1")).not.toBe(deriveCurrencyToken(before, "v1"))
  })

  test("the server-reported version stamps the token — a hub build change flips it", () => {
    const rows = [session("a", 100)]
    expect(deriveCurrencyToken(rows, "v1.18.10-amicode.21")).not.toBe(deriveCurrencyToken(rows, "v1.18.29"))
    expect(deriveCurrencyToken(rows, "v1.18.29")).toContain("v1.18.29")
  })

  test("a hub whose version is unavailable still yields a usable token (fail-soft)", () => {
    const rows = [session("a", 100)]
    expect(deriveCurrencyToken(rows, undefined)).toBe(deriveCurrencyToken(rows, undefined))
    expect(deriveCurrencyToken(rows, undefined)).not.toBe(deriveCurrencyToken(rows, "v1.18.29"))
  })
})

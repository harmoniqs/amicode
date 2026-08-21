import { describe, expect, test } from "bun:test"
import { parseWidgetSentinel } from "./widget-preview"

describe("parseWidgetSentinel", () => {
  const line = (o: unknown) => `Authored "X" ✓.\nAMICODE_WIDGET ${JSON.stringify(o)}`

  test("parses a well-formed sentinel on the last line", () => {
    const p = parseWidgetSentinel(
      line({ id: "recent-runs", name: "Recent Runs", size: "hero", height: 220, hash: "abc123", warnings: [] }),
    )
    expect(p).toEqual({ id: "recent-runs", name: "Recent Runs", size: "hero", height: 220, hash: "abc123", warnings: [] })
  })

  test("preceding prose is ignored; only the last line matters", () => {
    const p = parseWidgetSentinel(
      "line one\nline two\n" + `AMICODE_WIDGET ${JSON.stringify({ id: "a", hash: "h" })}`,
    )
    expect(p?.id).toBe("a")
    expect(p?.size).toBe("tile") // default
    expect(p?.height).toBe(96) // default
    expect(p?.name).toBe("a") // falls back to id
  })

  test("carries warnings", () => {
    const p = parseWidgetSentinel(line({ id: "a", hash: "h", warnings: ["degraded", 3, "x"] }))
    expect(p?.warnings).toEqual(["degraded", "x"])
  })

  test("rejects missing id/hash, non-string output, truncation, and non-sentinel", () => {
    expect(parseWidgetSentinel(line({ id: "a" }))).toBeUndefined() // no hash
    expect(parseWidgetSentinel(line({ hash: "h" }))).toBeUndefined() // no id
    expect(parseWidgetSentinel(42)).toBeUndefined()
    expect(parseWidgetSentinel("AMICODE_WIDGET {truncated…")).toBeUndefined()
    expect(parseWidgetSentinel("no sentinel here")).toBeUndefined()
    expect(parseWidgetSentinel(`AMICODE_WIDGET {"id":"a","hash":"h"}\ntrailing line`)).toBeUndefined()
  })
})

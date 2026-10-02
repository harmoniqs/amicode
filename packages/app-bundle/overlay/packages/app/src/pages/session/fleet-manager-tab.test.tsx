import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// #1544 (slice 4): the Fleet Manager grant-management panel wiring. The pure
// decision logic (shapeGrantRows / grantAffordances / shapePendingRequests) is
// unit-tested in fleet-manager.test.ts; here we assert the tab BINDS it — reads
// the sanitized grants off GET /amicode/fleet/grants (never a token), renders
// per-state affordances, and carries the #1545 pending-requests stub.
const source = readFileSync(resolve(__dirname, "fleet-manager-tab.tsx"), "utf8")

describe("#1544 fleet-manager-tab grant panel wiring", () => {
  test("adds a Grants section to the tab", () => {
    expect(source).toContain('<SectionTab id="grants" label="Grants" />')
    expect(source).toContain('section() === "grants"')
  })

  test("reads the SANITIZED grants off the never-proxied GRANTS_ROUTE", () => {
    expect(source).toContain("amicodeGet(server.current, GRANTS_ROUTE)")
    expect(source).toContain("shapeGrantRows(")
    // never renders a token field
    expect(source).not.toContain(".token")
  })

  test("renders per-state grant affordances (enable/disable/revoke)", () => {
    expect(source).toContain("data-grant-action={affordance}")
    expect(source).toContain("g.affordances")
    expect(source).toContain("data-grant-state={g.state}")
  })

  test("carries the #1545 pending-requests stub (honest empty)", () => {
    expect(source).toContain("shapePendingRequests(")
    expect(source).toContain("PENDING_REQUESTS_BACKEND_ISSUE")
  })
})

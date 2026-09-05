// Issue #817 — D3 wiring: the boot parity assertion rides the app's
// ConnectionGate health check (the same probe that reports the server's
// version) and logs the three-outcome record. Source-pinned per the repo's
// overlay-wiring idiom; the outcome machine is behavior-tested in
// boot_parity_817.test.ts.
import { describe, expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const overlay = (...p: string[]) => join(__dirname, "../../app-bundle/overlay/packages/app/src", ...p)
const src = (p: string) => readFileSync(overlay(p), "utf8")

describe("boot parity wiring (D3: asserted at boot, fail-open, recorded)", () => {
  test("ConnectionGate records parity on a healthy health check", () => {
    const s = src("app.tsx")
    expect(s).toContain('from "./utils/boot-parity"')
    expect(s).toMatch(/recordBootParity\(\{ serverVersion: res\.version/)
  })

  test("the record is surfaced (logged), never thrown into the boot gate", () => {
    const s = src("utils/boot-parity.ts")
    // Fail-open: a channel error resolves to a channel-unreachable RECORD.
    expect(s).toMatch(/outcome: "channel-unreachable"/)
    // The log line names the outcome — an unreachable check is never rendered as ok.
    expect(s).toMatch(/parts\.join\(" "\)/)
  })
})

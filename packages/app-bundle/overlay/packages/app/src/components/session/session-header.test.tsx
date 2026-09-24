import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

// #1544 (slice 4): the session-surface control wiring. Following the repo's
// component-source-assertion pattern (vscode-explorer-file-icon.test.tsx): the
// DECISION logic is pure + unit-tested in session-fleet-peers.ts; here we assert
// the SolidJS wiring binds those pure functions to the session surface — the
// persistent driving banner's `data-` hook (so persistence is assertable), the
// native-modal confirm dispatch, the fail-closed reason chip, and the
// owner-routed remote-delete reusing the arm→confirm interaction.
const source = readFileSync(resolve(__dirname, "session-header.tsx"), "utf8")

describe("#1544 session-header control wiring", () => {
  test("the persistent driving banner is pinned with an ASSERTABLE data-driving-peer hook", () => {
    expect(source).toContain("data-driving-peer={peer.machineId}")
    expect(source).toContain('data-slot="amicode-driving-banner"')
    // sourced from the fleet projection (the state channel carrier), not ad hoc
    expect(source).toContain("drivingBannerFromProjection(controlProjection.latest")
  })

  test("Enable control dispatches the VS Code native-modal confirm (ADR 0034 D4)", () => {
    expect(source).toContain("postAmicode(ENABLE_CONTROL_COMMAND)")
    expect(source).toContain('data-action="session-enable-control"')
    // the affordance is derived from eligibility (enable vs request vs none)
    expect(source).toContain("controlAffordance(")
    expect(source).toContain("data-control-affordance={controlAffordanceState().kind}")
  })

  test("a not-held remote row shows a disabled reason chip (never a live erroring button)", () => {
    expect(source).toContain("failClosedChip(control())")
    expect(source).toContain('data-slot="session-control-chip"')
    expect(source).toContain("data-control-reason={c.reason}")
    // writes are gated on held control
    expect(source).toContain("writeAffordanceEnabled(control())")
  })

  test("the remote-delete affordance is owner-routed AND reuses the arm→confirm interaction", () => {
    // owner-routed: the action carries the owner and the write plane routes it
    expect(source).toContain("remoteDeleteAction(session)")
    expect(source).toContain("action.request.ownerMachineId")
    // reused arm→confirm interaction (no second modal), gated on held control
    expect(source).toContain('data-action="session-remote-delete"')
    expect(source).toContain('data-action="session-remote-delete-confirm"')
    expect(source).toContain("armRemoteDelete")
    expect(source).toContain("confirmRemoteDelete")
    // only shown when control is held
    expect(source).toContain("<Show when={canWrite()}>")
  })
})

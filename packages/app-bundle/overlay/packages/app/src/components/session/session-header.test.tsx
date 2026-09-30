import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  isComposerGated,
  findSessionControlInProjection,
  findSessionOwnerInProjection,
} from "./session-fleet-peers"

// #1544 (slice 4): the session-surface control wiring. Following the repo's
// component-source-assertion pattern (vscode-explorer-file-icon.test.tsx): the
// DECISION logic is pure + unit-tested in session-fleet-peers.ts; here we assert
// the SolidJS wiring binds those pure functions to the session surface — the
// fail-closed reason chip, the owner-routed archive on an active remote row, and
// the owner-routed delete that now lives on the Archived tab (remote matches
// local: an active row archives, the Archived row deletes).
//
// The "Driving <peer>" indicator moved from a fixed banner Portal in
// session-header.tsx to a monitor icon on the session tab in the titlebar
// (titlebar-tab-nav.tsx). The session header no longer renders any driving
// banner; the shared control projection was extracted to its own module.
const source = readFileSync(resolve(__dirname, "session-header.tsx"), "utf8")
const tabNavSource = readFileSync(resolve(__dirname, "../titlebar-tab-nav.tsx"), "utf8")
const tabStripSource = readFileSync(resolve(__dirname, "../titlebar-tab-strip.tsx"), "utf8")
const projectionSource = readFileSync(resolve(__dirname, "session-fleet-control-projection.ts"), "utf8")

describe("#1544 session-header control wiring", () => {
  test("the driving banner Portal is REMOVED from session-header (moved to the tab strip)", () => {
    // The fixed-position "Driving <peer>" banner no longer lives here —
    // the indicator is now a monitor icon on the session tab itself.
    expect(source).not.toContain('data-slot="amicode-driving-banner"')
    expect(source).not.toContain("data-driving-peer=")
    expect(source).not.toContain("drivingBannerFromProjection")
  })

  test("the driving indicator lives on the session tab in the titlebar", () => {
    // The tab strip derives the driving state from the shared projection
    expect(tabStripSource).toContain("drivingBannerFromProjection(controlProjection()")
    expect(tabStripSource).toContain("drivingMachineId")
    // The tab nav item renders a monitor icon with the driving machine tooltip
    expect(tabNavSource).toContain('data-slot="tab-driving-remote"')
    expect(tabNavSource).toContain("drivingMachineId")
    expect(tabNavSource).toContain('name="monitor"')
  })

  test("Enable control is re-homed onto the composer scrim, NOT a fixed top-right Portal (#1551 DEFECT 2)", () => {
    // The old placement (a Portal to document.body at top:8px/right:12px over
    // the titlebar) is REMOVED — no top-right affordance, no command-lane post.
    expect(source).not.toContain('data-action="session-enable-control"')
    expect(source).not.toContain('top: "8px"')
    expect(source).not.toContain("postAmicode(ENABLE_CONTROL_COMMAND)")
    expect(source).not.toContain("ENABLE_CONTROL_COMMAND")
  })

  test("the composer-anchored scrim gates the composer + centers the CTA when control is not held (#1551)", () => {
    // The affordance now lives on a composer-anchored scrim.
    expect(source).toContain("export function SessionComposerControlScrim")
    expect(source).toContain('data-slot="amicode-composer-control-scrim"')
    expect(source).toContain('data-action="composer-enable-control"')
    // the composer subtree is BLURRED + made non-editable (inert) while gated
    expect(source).toContain("blur(")
    expect(source).toContain("inert")
    // gating is derived from the SHARED pure gate (remote peer + control not
    // held) — one home for the ungate-on-interactive rule, never the titlebar
    expect(source).toContain("isComposerGated(")
    // the CTA names the peer the session lives on
    expect(source).toContain("This session lives on")
    // the CTA click posts DEFECT 1's payload envelope (not the retired command lane)
    expect(source).toContain("postAmicodeFleetEnableControl(")
  })

  test("a not-held remote row shows a disabled reason chip (never a live erroring button)", () => {
    expect(source).toContain("failClosedChip(control())")
    expect(source).toContain('data-slot="session-control-chip"')
    expect(source).toContain("data-control-reason={c.reason}")
    // writes are gated on held control
    expect(source).toContain("writeAffordanceEnabled(control())")
  })

  test("the active remote row is ARCHIVE-ONLY — remote delete moved to the Archived tab", () => {
    // A remote peer row on the ACTIVE list offers only the owner-routed archive,
    // gated on held control. Remote now matches local: no delete on an active
    // row — archive first, then delete from the Archived tab.
    expect(source).toContain('data-action="session-remote-archive"')
    expect(source).toContain("<Show when={canWrite()}>")
    // the active-row remote-delete + its arm→confirm interaction are GONE
    expect(source).not.toContain('data-action="session-remote-delete"')
    expect(source).not.toContain('data-action="session-remote-delete-confirm"')
    expect(source).not.toContain("armRemoteDelete")
    expect(source).not.toContain("confirmRemoteDelete")
    expect(source).not.toContain("remoteDeleteSession")
  })

  test("remote delete lives on the Archived row — owner-routed AND control-gated", () => {
    // deleteArchivedSession routes a remote delete to the owner (same SDK delete
    // surface, intercepted by the #1542 write plane) and is gated on held control
    // — a control-less remote archived row shows the fail-closed chip instead.
    expect(source).toContain("async function deleteArchivedSession")
    expect(source).toContain("remoteDeleteAction(dropdownSession).allowed")
    // the archived row renders the arm→confirm permanent delete
    expect(source).toContain('data-action="session-dropdown-delete"')
    expect(source).toContain('data-action="session-dropdown-delete-confirm"')
  })

  // #1646: the archive handler must force-sync the PER-SESSION store, not only
  // reload the list — the composer's archived read-only banner reads the
  // per-session store, so without this the banner lagged (seconds) behind an
  // owner-routed remote archive. Mirrors the unarchive path's force-sync.
  test("#1646 archive force-syncs the per-session store so the composer flips immediately", () => {
    // the archive handler still reloads the list…
    expect(source).toContain("project.loadSessions(session.directory")
    // …AND force-syncs the per-session store (the composer's `archived` source)
    expect(source).toContain("session.sync(session.id, { force: true })")
  })
})

// amicode#1652: the owner tag no longer simply vanishes on hover to reveal the
// action cluster — it TELEPORTS left, reappearing next to the archive/delete
// controls. The resting badge fades out (group-hover opacity) and a second copy
// inside the (fade-in) action cluster takes its place.
describe("#1652 owner-tag teleport on hover", () => {
  test("the active row renders a resting badge AND a teleported copy in the action cluster", () => {
    expect(source).toContain('data-slot="session-owner-badge-resting"')
    expect(source).toContain('data-slot="session-owner-badge-teleported"')
    // the resting badge still fades out on hover/focus…
    expect(source).toContain("group-hover/session:opacity-0")
    expect(source).toContain("group-focus-within/session:opacity-0")
  })

  test("the archived row also teleports its owner tag into the action cluster", () => {
    expect(source).toContain('data-slot="archived-session-owner-badge"')
    expect(source).toContain('data-slot="archived-session-owner-badge-teleported"')
    expect(source).toContain("group-hover/archived:opacity-0")
  })
})

// amicode#1652: the flyout list must not remount (and flash) tagged rows on the
// 3s fleet poll. The dropdown feeds <For> through stabilizeSessionIdentity with a
// component-scoped id-keyed cache, so unchanged rows keep their object reference.
describe("#1652 stable row identity across the fleet poll", () => {
  test("the dropdown stabilizes row identity before <For> (active + archived)", () => {
    expect(source).toContain("stabilizeSessionIdentity")
    expect(source).toContain("activeIdentityCache")
    expect(source).toContain("archivedIdentityCache")
  })
})

// #1562-followup (Slice A): the interactive flip must be OBSERVED. The shared
// control projection was extracted to session-fleet-control-projection.ts — the
// same ref-counted singleton the session header, the composer scrim, and now the
// titlebar tab strip all consume.
describe("Slice A — the control projection is polled + shared (the interactive flip is observed)", () => {
  test("the shared polled accessor lives in its own module and is consumed by session-header", () => {
    // session-header imports the shared accessor
    expect(source).toContain("useSharedControlProjection")
    // the projection module has the poll machinery
    expect(projectionSource).toContain("setInterval(")
    expect(projectionSource).toContain('addEventListener("focus"')
    expect(projectionSource).toContain("clearInterval(")
  })

  test("the tab strip also consumes the shared projection (for the driving indicator)", () => {
    expect(tabStripSource).toContain("useControlProjectionForConnection")
  })

  test("the duplicated one-shot createResource(() => server.current, …) is GONE from header + scrim", () => {
    // the bare `() => server.current` resource source appeared twice (header +
    // scrim); both are replaced by the shared polled accessor. (The dropdown's
    // `() => (open() ? server.current : undefined)` source is a different string
    // and is intentionally untouched.)
    expect(source).not.toContain("() => server.current,")
  })

  test("a projection reporting `interactive` ungates the composer scrim (gated === false)", () => {
    const interactive = {
      sessions: [
        {
          id: "ses_studio",
          amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false },
          amicode_control: { controlState: "interactive", reason: null, eligibility: "none" },
        },
      ],
    }
    const owner = findSessionOwnerInProjection(interactive, "ses_studio")
    const control = findSessionControlInProjection(interactive, "ses_studio")
    expect(isComposerGated(owner, control)).toBe(false)

    // and a read-only projection for the same remote session STILL gates it
    const readOnly = {
      sessions: [
        {
          id: "ses_studio",
          amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false },
          amicode_control: { controlState: "read-only", reason: "no-control-grant", eligibility: "enable-control" },
        },
      ],
    }
    expect(
      isComposerGated(
        findSessionOwnerInProjection(readOnly, "ses_studio"),
        findSessionControlInProjection(readOnly, "ses_studio"),
      ),
    ).toBe(true)

    // a LOCAL/unowned session is never gated regardless of control read
    expect(isComposerGated(undefined, control)).toBe(false)
  })
})

// #1568: the "Driven by {machine}" presence indicator — shows on the session tab
// when a remote machine holds an active control grant targeting this machine.
describe("#1568 driven-by presence indicator wiring", () => {
  test("the tab strip derives driven-by state from the shared fleet projection", () => {
    expect(tabStripSource).toContain("drivenByBannerFromProjection(controlProjection()")
    expect(tabStripSource).toContain("drivenByMachine")
  })

  test("the tab nav item renders an eye icon with the driven-by machine tooltip", () => {
    expect(tabNavSource).toContain('data-slot="tab-driven-by-remote"')
    expect(tabNavSource).toContain("drivenByMachine")
    expect(tabNavSource).toContain('name="eye"')
    expect(tabNavSource).toContain("Driven by")
  })
})

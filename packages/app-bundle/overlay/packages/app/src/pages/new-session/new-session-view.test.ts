import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// amicode#663 / #673 — the breadcrumb bar (project selector + workspace
// selector + git status) below the new-session composer. Originally gated on
// !inAmicode(), then un-gated (#663), then changed from selected() to empty()
// (#673) so the "Pick a project" placeholder is visible even when no project
// matches the draft directory.
const source = readFileSync(join(import.meta.dir, "new-session-view.tsx"), "utf8")

describe("project selector in new-session view (#663, #673)", () => {
  test("renders the selector when projects exist (not only when one is selected)", () => {
    // The guard must use !empty() (projects available), not selected() (one is matched)
    expect(source).toMatch(/props\.project\.empty\(\)/)
    expect(source).not.toMatch(/when=\{props\.project\.selected\(\)\}/)
  })
})

// ── #1453 (W4b): the machine picker is MOUNTED — live-importer chain ──────────
// AC2 is a structural guard: createMachinePickerState (#1442) must have a live
// (non-test) importer to retire its dead-module status. The chain is:
//   new-session-view.tsx  ──imports──▶  new-session-machine-picker-mount.tsx
//   new-session-machine-picker-mount.tsx  ──imports──▶  createMachinePickerState
// new-session-view.tsx itself is imported by the live new-session page, so the
// mount (and thus the picker) is in the live module graph, not an orphan.
describe("machine picker is mounted in the new-session view (#1453 AC2)", () => {
  const mountSource = readFileSync(join(import.meta.dir, "new-session-machine-picker-mount.tsx"), "utf8")

  test("new-session-view imports and renders the machine picker mount", () => {
    expect(source).toMatch(/from "\.\/new-session-machine-picker-mount"/)
    expect(source).toMatch(/<NewSessionMachinePicker\s*\/>/)
  })

  test("the mount is the live importer of createMachinePickerState (kills dead-module status)", () => {
    expect(mountSource).toMatch(/createMachinePickerState/)
    expect(mountSource).toMatch(/from "@\/components\/new-session-machine-picker"/)
  })

  test("the mount builds its list from the fleet-sessions projection, not a hand-rolled roster", () => {
    expect(mountSource).toMatch(/machineOptionsFromFleetSessions/)
    expect(mountSource).toMatch(/fleetSessionsFromResponse/)
  })
})

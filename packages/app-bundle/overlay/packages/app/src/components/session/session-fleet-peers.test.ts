import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  peerSessionsFromProjection,
  mergePeerSessions,
  deriveSessionBadge,
  isRemotePeerSession,
  resolveDropdownOpenAction,
  readSessionControl,
  isControlHeld,
  writeAffordanceEnabled,
  failClosedChip,
  controlAffordance,
  drivingBanner,
  drivingBannerFromProjection,
  remoteDeleteAction,
  findSessionControlInProjection,
  groupSessionsByOwner,
  CONTROL_CHIP_REASONS,
  type DropdownSession,
  type SessionControlProjection,
  type SessionGroup,
} from "./session-fleet-peers"

// #1525 B1 (read-only): merge PEER sessions from the fleet projection into the
// titlebar Sessions dropdown. These pure helpers are the data layer the
// component consumes; every reader is tolerant (never throws, [] on garbage).

const localTag = { owner_machine_id: "jjs-macbook-pro", owner_name: "MacBook Pro", is_local: true }
const studioTag = { owner_machine_id: "jjs-mac-studio", owner_name: "JJ's Mac Studio", device_type: "desktop", is_local: false }

function projection(sessions: unknown[]): unknown {
  return { sessions, sources: {} }
}

describe("#1525 peerSessionsFromProjection — keep only remote peer sessions", () => {
  test("keeps a remote (is_local:false) session, coerced with title/time/owner", () => {
    const raw = projection([
      { id: "ses_studio", title: "Free port 4096", directory: "/proj", time: { created: 3, updated: 7 }, amicode_owner: studioTag },
    ])
    const out = peerSessionsFromProjection(raw)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("ses_studio")
    expect(out[0].title).toBe("Free port 4096")
    expect(out[0].time).toEqual({ created: 3, updated: 7 })
    expect(out[0].amicode_owner).toMatchObject({ owner_machine_id: "jjs-mac-studio", is_local: false })
  })

  test("drops LOCAL-owned and UNOWNED entries (the local list already has those)", () => {
    const raw = projection([
      { id: "ses_local", title: "local", time: { created: 1 }, amicode_owner: localTag },
      { id: "ses_plain", title: "plain", time: { created: 2 } },
      { id: "ses_studio", title: "remote", time: { created: 3 }, amicode_owner: studioTag },
    ])
    const out = peerSessionsFromProjection(raw)
    expect(out.map((s) => s.id)).toEqual(["ses_studio"])
  })

  test("tolerant: undefined / {} / non-array sessions / malformed rows → []", () => {
    expect(peerSessionsFromProjection(undefined)).toEqual([])
    expect(peerSessionsFromProjection({})).toEqual([])
    expect(peerSessionsFromProjection({ sessions: "nope" })).toEqual([])
    expect(peerSessionsFromProjection(projection([{ no_id: true, amicode_owner: studioTag }]))).toEqual([])
    expect(peerSessionsFromProjection(projection([{ id: "x", amicode_owner: { owner_name: 1, is_local: false } }]))).toEqual([])
  })

  test("a remote entry missing time still coerces (created defaults to 0)", () => {
    const out = peerSessionsFromProjection(projection([{ id: "ses_studio", amicode_owner: studioTag }]))
    expect(out).toHaveLength(1)
    expect(out[0].time.created).toBe(0)
  })
})

describe("#1525 deriveSessionBadge / isRemotePeerSession", () => {
  test("remote session badges with the owner name", () => {
    expect(deriveSessionBadge({ amicode_owner: studioTag })).toBe("JJ's Mac Studio")
    expect(isRemotePeerSession({ amicode_owner: studioTag })).toBe(true)
  })
  test("local and unowned sessions are unbadged / not remote", () => {
    expect(deriveSessionBadge({ amicode_owner: localTag })).toBeUndefined()
    expect(deriveSessionBadge({})).toBeUndefined()
    expect(deriveSessionBadge(undefined)).toBeUndefined()
    expect(isRemotePeerSession({ amicode_owner: localTag })).toBe(false)
    expect(isRemotePeerSession(undefined)).toBe(false)
  })
})

describe("#1525 mergePeerSessions — dedupe (local wins) + sort by last activity", () => {
  const mk = (id: string, updated: number, owner?: DropdownSession["amicode_owner"]): DropdownSession =>
    ({ id, directory: "/d", time: { created: 0, updated }, ...(owner ? { amicode_owner: owner } : {}) }) as DropdownSession

  test("peers append to local, sorted by updated desc", () => {
    const local = [mk("a", 5), mk("b", 1)]
    const peers = [mk("c", 9, studioTag), mk("d", 3, studioTag)]
    expect(mergePeerSessions(local, peers).map((s) => s.id)).toEqual(["c", "a", "d", "b"])
  })

  test("id collision: the local row wins, the peer duplicate is dropped", () => {
    const local = [mk("dup", 5)]
    const peers = [mk("dup", 99, studioTag)]
    const out = mergePeerSessions(local, peers)
    expect(out).toHaveLength(1)
    expect(out[0].amicode_owner).toBeUndefined() // kept the LOCAL row
  })

  test("empty peers → local list unchanged (degrade path)", () => {
    const local = [mk("a", 5), mk("b", 9)]
    expect(mergePeerSessions(local, []).map((s) => s.id)).toEqual(["b", "a"])
  })

  // #1539 regression: when the SSE fan-in contaminated the directory store, a
  // remote session ended up in the local `activeSessions` array WITHOUT its
  // `amicode_owner` tag. On the next dropdown open, `mergePeerSessions` saw the
  // local (untagged) copy and the projection (tagged) copy — local wins, so the
  // badge-carrying projection copy was dropped. The fix gates the directory store
  // so remote events never insert there; this test guards the dedup behavior that
  // was being exploited by the contamination.
  test("#1539 regression: contaminated local copy (no amicode_owner) wins over badged projection copy", () => {
    // Simulate the contamination scenario: same session in local (no tag) and
    // projection (with tag). The local copy should win, which is correct behavior
    // — the fix prevents the contamination from happening in the first place.
    const contaminated = mk("ses_remote", 5) // no amicode_owner (the bug)
    const fromProjection = mk("ses_remote", 5, studioTag) // has the badge
    const out = mergePeerSessions([contaminated], [fromProjection])
    expect(out).toHaveLength(1)
    // Local wins → badge is lost. This is CORRECT dedup behavior — the fix is
    // to prevent `contaminated` from ever reaching the local store.
    expect(out[0].amicode_owner).toBeUndefined()
    expect(deriveSessionBadge(out[0])).toBeUndefined()
  })

  test("#1539 fixed: when directory store is clean, projection badge persists through dedup", () => {
    // After the fix: the remote session is ONLY in the projection (with badge),
    // never contaminated into the local store. The dropdown merges correctly.
    const localSessions = [mk("ses_local", 5)]
    const projectionPeers = [mk("ses_remote", 3, studioTag)]
    const out = mergePeerSessions(localSessions, projectionPeers)
    expect(out).toHaveLength(2)
    const remote = out.find((s) => s.id === "ses_remote")!
    expect(remote.amicode_owner).toBeDefined()
    expect(remote.amicode_owner!.is_local).toBe(false)
    expect(deriveSessionBadge(remote)).toBe("JJ's Mac Studio")
  })
})

// #1537 B2a (AC4): owner-routed OPEN. `resolveDropdownOpenAction` is the pure
// decision the dropdown's openSession() dispatches on. A REMOTE peer row must
// resolve to the owner-routed navigate (the multiplex routes reads by owner) —
// NOT the B1 "lives on <machine>" guard toast. A LOCAL row is byte-unchanged
// from B1: existing tab → select-tab; no tab → navigate. No branch produces a
// mutation/remote-write action — open is a read.
describe("#1537 resolveDropdownOpenAction — owner-routed open of a peer row", () => {
  const encodePath = (dir: string, id: string) => `/${btoa(dir)}/session/${id}`
  const studioTag = { owner_machine_id: "jjs-mac-studio", owner_name: "JJ's Mac Studio", is_local: false }

  const localRow: DropdownSession = { id: "ses_local", directory: "/proj", time: { created: 1 } } as DropdownSession
  const remoteRow: DropdownSession = {
    id: "ses_studio",
    directory: "/studio-proj",
    time: { created: 2 },
    amicode_owner: studioTag,
  } as DropdownSession

  test("REMOTE row → owner-routed navigate to its raw directory/id (never a toast)", () => {
    const action = resolveDropdownOpenAction(remoteRow, false, encodePath)
    expect(action.type).toBe("navigate")
    expect((action as { type: "navigate"; path: string }).path).toBe(`/${btoa("/studio-proj")}/session/ses_studio`)
  })

  test("REMOTE row with an already-open tab → select that tab (no re-navigate)", () => {
    const action = resolveDropdownOpenAction(remoteRow, true, encodePath)
    expect(action.type).toBe("select-tab")
    expect((action as { type: "select-tab"; sessionId: string }).sessionId).toBe("ses_studio")
  })

  test("LOCAL row without a tab → navigate (byte-unchanged from B1)", () => {
    const action = resolveDropdownOpenAction(localRow, false, encodePath)
    expect(action.type).toBe("navigate")
    expect((action as { type: "navigate"; path: string }).path).toBe(`/${btoa("/proj")}/session/ses_local`)
  })

  test("LOCAL row with an existing tab → select-tab (byte-unchanged from B1)", () => {
    const action = resolveDropdownOpenAction(localRow, true, encodePath)
    expect(action.type).toBe("select-tab")
    expect((action as { type: "select-tab"; sessionId: string }).sessionId).toBe("ses_local")
  })

  test("no branch yields a remote-write action — the union is only navigate | select-tab", () => {
    for (const row of [localRow, remoteRow]) {
      for (const hasTab of [true, false]) {
        expect(["navigate", "select-tab"]).toContain(resolveDropdownOpenAction(row, hasTab, encodePath).type)
      }
    }
  })
})

// ── #1544 (slice 4): the app-side control surface ─────────────────────────────
// The state channel `amicode_control` ({ controlState, reason, eligibility })
// rides the fleet projection beside `amicode_owner` (SoT: the extension's
// remote_session_state). These pure helpers are the data layer the session
// surface consumes: the fail-closed chip, the enable/request affordance, the
// persistent driving banner, and the owner-routed remote-delete gate. Every
// reader is tolerant (defaults to `local`/no-affordance on garbage).
const ctrl = (over: Partial<SessionControlProjection> = {}): SessionControlProjection => ({
  controlState: "read-only",
  reason: "no-control-grant",
  eligibility: "enable-control",
  ...over,
})
const remoteWith = (control: SessionControlProjection, machineId = "jjs-mac-studio"): DropdownSession =>
  ({
    id: "ses_studio",
    directory: "/studio-proj",
    time: { created: 1 },
    amicode_owner: { owner_machine_id: machineId, owner_name: "Studio", is_local: false },
    amicode_control: control,
  }) as unknown as DropdownSession

describe("#1544 readSessionControl — tolerant read of amicode_control", () => {
  test("absent / malformed → the local no-affordance default (never throws)", () => {
    expect(readSessionControl(undefined)).toEqual({ controlState: "local", reason: null, eligibility: "none" })
    expect(readSessionControl({} as DropdownSession)).toEqual({ controlState: "local", reason: null, eligibility: "none" })
    expect(readSessionControl({ amicode_control: { nope: 1 } } as unknown as DropdownSession).controlState).toBe("local")
  })
  test("a well-formed projection round-trips", () => {
    expect(readSessionControl(remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" })))).toEqual({
      controlState: "interactive",
      reason: null,
      eligibility: "none",
    })
  })
})

describe("#1544 write affordances gated on control held", () => {
  test("local + interactive → control held → writes enabled", () => {
    expect(isControlHeld(ctrl({ controlState: "local", reason: null, eligibility: "none" }))).toBe(true)
    expect(isControlHeld(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }))).toBe(true)
    expect(writeAffordanceEnabled(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }))).toBe(true)
  })
  test("read-only + suspended → control NOT held → writes disabled", () => {
    expect(isControlHeld(ctrl({ controlState: "read-only" }))).toBe(false)
    expect(isControlHeld(ctrl({ controlState: "suspended", reason: "transport-down" }))).toBe(false)
    expect(writeAffordanceEnabled(ctrl({ controlState: "read-only" }))).toBe(false)
  })
})

describe("#1544 failClosedChip — disabled-with-reason, derived from the SoT reason (never the collapsed gate reason)", () => {
  test("null (no chip) when control is held (local / interactive)", () => {
    expect(failClosedChip(ctrl({ controlState: "local", reason: null, eligibility: "none" }))).toBeNull()
    expect(failClosedChip(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }))).toBeNull()
  })
  test("EVERY one of the five SoT reasons yields a distinct, human chip label", () => {
    const labels = new Set<string>()
    for (const reason of CONTROL_CHIP_REASONS) {
      const controlState = reason === "transport-down" || reason === "revocation-pending" ? "suspended" : "read-only"
      const chip = failClosedChip(ctrl({ controlState, reason }))
      expect(chip, `reason ${reason} must produce a chip`).not.toBeNull()
      expect(chip!.reason).toBe(reason)
      expect(typeof chip!.label).toBe("string")
      expect(chip!.label.length).toBeGreaterThan(0)
      labels.add(chip!.label)
    }
    // revocation-pending and grant-revoked must NOT share a label (the SoT keeps
    // them distinct where the write gate collapses them).
    expect(failClosedChip(ctrl({ controlState: "suspended", reason: "revocation-pending" }))!.label).not.toBe(
      failClosedChip(ctrl({ controlState: "read-only", reason: "grant-revoked" }))!.label,
    )
    expect(labels.size).toBe(CONTROL_CHIP_REASONS.length)
  })
})

describe("#1544 controlAffordance — enable (self) / request (shared) / none", () => {
  test("eligibility enable-control → an Enable affordance, live (not inert)", () => {
    const a = controlAffordance(ctrl({ eligibility: "enable-control" }))
    expect(a.kind).toBe("enable-control")
    expect(a.inert).toBe(false)
    expect(a.label.length).toBeGreaterThan(0)
  })
  test("eligibility request-control → a Request affordance, INERT (backend is #1545)", () => {
    const a = controlAffordance(ctrl({ eligibility: "request-control" }))
    expect(a.kind).toBe("request-control")
    expect(a.inert).toBe(true)
  })
  test("eligibility none → no affordance", () => {
    expect(controlAffordance(ctrl({ controlState: "interactive", reason: null, eligibility: "none" })).kind).toBe("none")
  })
})

describe("#1544 drivingBanner — persistent, pinned to the peer being driven", () => {
  test("interactive (control held over a remote peer) → banner carries the peer machineId", () => {
    const session = remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }), "jjs-mac-studio")
    expect(drivingBanner(session)).toEqual({ machineId: "jjs-mac-studio" })
  })
  test("not interactive (read-only / local) → no banner", () => {
    expect(drivingBanner(remoteWith(ctrl({ controlState: "read-only" })))).toBeNull()
    const local = { id: "l", directory: "/d", time: { created: 1 } } as DropdownSession
    expect(drivingBanner(local)).toBeNull()
  })
})

describe("#1544 remoteDeleteAction — owner-routed delete, gated on control (arm→confirm reused, not this gate)", () => {
  test("control held → allowed + an OWNER-ROUTED request carrying the owner machineId", () => {
    const session = remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }), "jjs-mac-studio")
    const action = remoteDeleteAction(session)
    expect(action.allowed).toBe(true)
    expect(action.request).toEqual({ sessionID: "ses_studio", directory: "/studio-proj", ownerMachineId: "jjs-mac-studio" })
  })
  test("control NOT held → disallowed, no request, carries the fail-closed reason (never a live erroring button)", () => {
    const session = remoteWith(ctrl({ controlState: "read-only", reason: "no-control-grant" }))
    const action = remoteDeleteAction(session)
    expect(action.allowed).toBe(false)
    expect(action.request).toBeUndefined()
    expect(action.reason).toBe("no-control-grant")
  })
})

describe("#1544 findSessionControlInProjection — the current session's control off the fleet projection", () => {
  const raw = {
    sessions: [
      { id: "ses_local", time: { created: 1 }, amicode_owner: { owner_machine_id: "me", owner_name: "Me", is_local: true }, amicode_control: { controlState: "local", reason: null, eligibility: "none" } },
      { id: "ses_studio", time: { created: 2 }, amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false }, amicode_control: { controlState: "read-only", reason: "no-control-grant", eligibility: "enable-control" } },
    ],
  }
  test("finds a remote entry's control by id", () => {
    expect(findSessionControlInProjection(raw, "ses_studio")).toEqual({
      controlState: "read-only",
      reason: "no-control-grant",
      eligibility: "enable-control",
    })
  })
  test("unknown id / garbage → the local default (never throws)", () => {
    expect(findSessionControlInProjection(raw, "nope")).toEqual({ controlState: "local", reason: null, eligibility: "none" })
    expect(findSessionControlInProjection(undefined, "x")).toEqual({ controlState: "local", reason: null, eligibility: "none" })
  })

  test("drivingBannerFromProjection lights the banner for a driven (interactive) current session", () => {
    const driving = {
      sessions: [
        { id: "ses_studio", amicode_owner: { owner_machine_id: "studio", owner_name: "Studio", is_local: false }, amicode_control: { controlState: "interactive", reason: null, eligibility: "none" } },
      ],
    }
    expect(drivingBannerFromProjection(driving, "ses_studio")).toEqual({ machineId: "studio" })
    // read-only current session → no banner; unknown id → no banner
    expect(drivingBannerFromProjection(raw, "ses_studio")).toBeNull()
    expect(drivingBannerFromProjection(driving, "nope")).toBeNull()
    expect(drivingBannerFromProjection(undefined, "x")).toBeNull()
  })
})

// ── #1562-followup (Slice C): GROUP the dropdown by owner machine ─────────────
// The dropdown merged peer + local sessions and sorted by recency, so a single
// Studio session sat at the bottom under ~100 local ones — effectively
// invisible. The projection data is correct; this is PRESENTATION. groupSessions-
// ByOwner is the pure decision: the LOCAL / unowned rows first (one unlabeled
// group, order preserved), then ONE labeled group per peer machine (grouped by
// owner_machine_id, labeled with the owner name), in first-seen order. Read-only
// — no row is dropped or reordered within a group.
describe("#1562 groupSessionsByOwner — local first, then a labeled group per peer machine", () => {
  const laptopTag = { owner_machine_id: "jjs-macbook-pro", owner_name: "MacBook Pro", is_local: true }
  const studio = { owner_machine_id: "jjs-mac-studio", owner_name: "JJ's Mac Studio", is_local: false }
  const tower = { owner_machine_id: "lab-tower", owner_name: "Lab Tower", is_local: false }
  const mk = (id: string, owner?: DropdownSession["amicode_owner"]): DropdownSession =>
    ({ id, directory: "/d", time: { created: 0, updated: 0 }, ...(owner ? { amicode_owner: owner } : {}) }) as DropdownSession

  test("local + unowned first (one UNLABELED group), then one LABELED group per peer machine", () => {
    const groups: SessionGroup[] = groupSessionsByOwner([
      mk("a"),
      mk("b", laptopTag),
      mk("s1", studio),
      mk("c"),
      mk("s2", studio),
      mk("t1", tower),
    ])
    expect(groups).toHaveLength(3)
    // group 0 = local / unowned, no machineId, no label, input order preserved
    expect(groups[0].machineId).toBeNull()
    expect(groups[0].label).toBeUndefined()
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b", "c"])
    // then one labeled group per peer machine, FIRST-SEEN order (studio before tower)
    expect(groups[1].machineId).toBe("jjs-mac-studio")
    expect(groups[1].label).toBe("JJ's Mac Studio")
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s1", "s2"])
    expect(groups[2].machineId).toBe("lab-tower")
    expect(groups[2].label).toBe("Lab Tower")
    expect(groups[2].sessions.map((s) => s.id)).toEqual(["t1"])
  })

  test("empty peers → JUST the local list (one group, machineId null)", () => {
    const groups = groupSessionsByOwner([mk("a"), mk("b", laptopTag)])
    expect(groups).toHaveLength(1)
    expect(groups[0].machineId).toBeNull()
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b"])
  })

  test("empty input → a single empty local group (never blank / never throws)", () => {
    const groups = groupSessionsByOwner([])
    expect(groups).toHaveLength(1)
    expect(groups[0].machineId).toBeNull()
    expect(groups[0].sessions).toEqual([])
  })

  test("peer order is FIRST-SEEN; rows within a peer group keep input (recency) order", () => {
    const groups = groupSessionsByOwner([mk("t1", tower), mk("s1", studio), mk("t2", tower)])
    expect(groups.map((g) => g.machineId)).toEqual([null, "lab-tower", "jjs-mac-studio"])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["t1", "t2"])
    expect(groups[2].sessions.map((s) => s.id)).toEqual(["s1"])
  })

  test("only-peer input → an empty local group followed by the labeled peer group(s)", () => {
    const groups = groupSessionsByOwner([mk("s1", studio)])
    expect(groups).toHaveLength(2)
    expect(groups[0].machineId).toBeNull()
    expect(groups[0].sessions).toEqual([])
    expect(groups[1].machineId).toBe("jjs-mac-studio")
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s1"])
  })
})

// The dropdown consumes the pure grouping and renders peer rows UNDER a labeled
// machine group — not recency-merged into the local list. Source-assertion (the
// component's SolidJS wiring), following the repo's component-source pattern.
describe("#1562 the dropdown renders peer rows in a labeled machine group", () => {
  const headerSource = readFileSync(resolve(__dirname, "session-header.tsx"), "utf8")
  test("the dropdown groups by owner via groupSessionsByOwner and renders a per-machine label", () => {
    expect(headerSource).toContain("groupSessionsByOwner(")
    expect(headerSource).toContain('data-slot="session-group-label"')
  })
})

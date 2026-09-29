import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  peerSessionsFromProjection,
  allSessionsFromProjection,
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
  drivenByBanner,
  drivenByBannerFromProjection,
  remoteDeleteAction,
  findSessionControlInProjection,
  groupSessionsByOwner,
  sortDropdownSessions,
  CONTROL_CHIP_REASONS,
  type DropdownSession,
  type SessionControlProjection,
  type SessionGroup,
  type SortMode,
} from "./session-fleet-peers"

// #1525 B1 (read-only): merge PEER sessions from the fleet projection into the
// titlebar Sessions dropdown. These pure helpers are the data layer the
// component consumes; every reader is tolerant (never throws, [] on garbage).

const localTag = { owner_machine_id: "test-laptop", owner_name: "MacBook Pro", is_local: true }
const studioTag = { owner_machine_id: "test-desktop", owner_name: "Test Desktop", device_type: "desktop", is_local: false }

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
    expect(out[0].amicode_owner).toMatchObject({ owner_machine_id: "test-desktop", is_local: false })
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

  // #1646 regression: the peer row MUST carry the projection's amicode_control
  // overlay. Without it, readSessionControl on the row always fell to the
  // remote fail-closed default (`no-control-grant`), so an enabled `interactive`
  // grant never reached the row and archive/delete stayed refused forever.
  test("#1646: a peer entry's amicode_control overlay is carried onto the row", () => {
    const out = peerSessionsFromProjection(
      projection([
        {
          id: "ses_studio",
          amicode_owner: studioTag,
          amicode_control: { controlState: "interactive", reason: null, eligibility: "none" },
        },
      ]),
    )
    expect(out).toHaveLength(1)
    expect(readSessionControl(out[0]).controlState).toBe("interactive")
  })

  test("#1646: a peer entry WITHOUT control still coerces (degrades to fail-closed at read time)", () => {
    const out = peerSessionsFromProjection(projection([{ id: "ses_studio", amicode_owner: studioTag }]))
    expect(out[0].amicode_control).toBeUndefined()
    // No overlay on the row → readSessionControl applies the remote fail-closed default.
    expect(readSessionControl(out[0]).reason).toBe("no-control-grant")
  })
})

describe("#1525 deriveSessionBadge / isRemotePeerSession", () => {
  test("remote session badges with the owner name", () => {
    expect(deriveSessionBadge({ amicode_owner: studioTag })).toBe("Test Desktop")
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

  test("id collision: the local row wins but is enriched with the peer's owner tag", () => {
    const local = [mk("dup", 5)]
    const peers = [mk("dup", 99, studioTag)]
    const out = mergePeerSessions(local, peers)
    expect(out).toHaveLength(1)
    // The local row stays (its id, its time — live state), but #1599 enriches
    // it with the peer's owner overlay so the machine badge survives dedup.
    expect(out[0].id).toBe("dup")
    expect(out[0].time.updated).toBe(5) // local row's data, not the peer's
    expect(out[0].amicode_owner).toMatchObject({ owner_machine_id: "test-desktop", is_local: false })
  })

  test("id collision: an already-tagged local row keeps its OWN owner tag (no clobber)", () => {
    const laptop = { owner_machine_id: "other", owner_name: "Other", is_local: false }
    const local = [mk("dup", 5, laptop)]
    const peers = [mk("dup", 99, studioTag)]
    const out = mergePeerSessions(local, peers)
    expect(out).toHaveLength(1)
    expect(out[0].amicode_owner).toMatchObject({ owner_machine_id: "other" })
  })

  test("empty peers → local list unchanged (degrade path)", () => {
    const local = [mk("a", 5), mk("b", 9)]
    expect(mergePeerSessions(local, []).map((s) => s.id)).toEqual(["b", "a"])
  })

  // #1599 regression: opening a remote session pulls an UNTAGGED copy of it
  // into the local directory store (the intended open flow — openSession calls
  // projects.open + session.sync to render it). On the next dropdown compute,
  // mergePeerSessions sees the local (untagged) copy AND the projection
  // (tagged) copy for the same id. Previously local won outright and the badge
  // vanished the moment the remote session went live. The fix enriches the
  // local copy with the projection's owner tag so the badge persists.
  test("#1599 regression: opening a remote session keeps its badge (local copy enriched from projection)", () => {
    const liveLocalCopy = mk("ses_remote", 5) // untagged — pulled in by opening it
    const fromProjection = mk("ses_remote", 5, studioTag) // authoritative owner overlay
    const out = mergePeerSessions([liveLocalCopy], [fromProjection])
    expect(out).toHaveLength(1)
    // Badge survives — this is the corrected behavior (was `undefined` pre-#1599).
    expect(out[0].amicode_owner).toBeDefined()
    expect(deriveSessionBadge(out[0])).toBe("Test Desktop")
  })

  // #1646 regression: the SAME open flow that pulls an untagged local copy also
  // strips the fleet CONTROL overlay — the local copy has no control channel of
  // its own. Enabling control flips the PROJECTION's copy to `interactive`, but
  // pre-#1646 the merge kept the control-less local copy, so the row read
  // fail-closed and archive/delete refused with "Control not enabled" even
  // though control was held. The fix grafts the peer's control overlay across.
  test("#1646 regression: an enabled control grant on the projection reaches the merged row", () => {
    const liveLocalCopy = mk("ses_remote", 5) // untagged, control-less — pulled in by opening it
    const fromProjection = {
      ...mk("ses_remote", 5, studioTag),
      amicode_control: { controlState: "interactive", reason: null, eligibility: "none" },
    } as DropdownSession
    const out = mergePeerSessions([liveLocalCopy], [fromProjection])
    expect(out).toHaveLength(1)
    // Control is HELD on the merged row (was fail-closed `read-only` pre-#1646),
    // so writeAffordanceEnabled — the archive/delete gate — is true.
    expect(readSessionControl(out[0]).controlState).toBe("interactive")
    expect(writeAffordanceEnabled(readSessionControl(out[0]))).toBe(true)
  })

  test("#1646: a revoked/read-only grant on the projection also reaches the merged row (not just interactive)", () => {
    const liveLocalCopy = mk("ses_remote", 5)
    const fromProjection = {
      ...mk("ses_remote", 5, studioTag),
      amicode_control: { controlState: "read-only", reason: "grant-revoked", eligibility: "enable-control" },
    } as DropdownSession
    const out = mergePeerSessions([liveLocalCopy], [fromProjection])
    // The projection is SoT both ways: a revocation must reach the row too.
    expect(readSessionControl(out[0]).reason).toBe("grant-revoked")
    expect(writeAffordanceEnabled(readSessionControl(out[0]))).toBe(false)
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
    expect(deriveSessionBadge(remote)).toBe("Test Desktop")
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
  const studioTag = { owner_machine_id: "test-desktop", owner_name: "Test Desktop", is_local: false }

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
const remoteWith = (control: SessionControlProjection, machineId = "test-desktop"): DropdownSession =>
  ({
    id: "ses_studio",
    directory: "/studio-proj",
    time: { created: 1 },
    amicode_owner: { owner_machine_id: machineId, owner_name: "Studio", is_local: false },
    amicode_control: control,
  }) as unknown as DropdownSession

describe("#1544 readSessionControl — tolerant read of amicode_control", () => {
  test("absent / malformed on a LOCAL / unowned session → the local no-affordance default (never throws)", () => {
    expect(readSessionControl(undefined)).toEqual({ controlState: "local", reason: null, eligibility: "none" })
    expect(readSessionControl({} as DropdownSession)).toEqual({ controlState: "local", reason: null, eligibility: "none" })
    expect(readSessionControl({ amicode_control: { nope: 1 } } as unknown as DropdownSession).controlState).toBe("local")
  })
  test("absent / malformed on a REMOTE peer session → FAIL-CLOSED (amicode#1544 follow-up)", () => {
    // A remote row with no control channel must NOT read as held — the server
    // write gate denies with no-control-grant, so the client must agree (no
    // silently-failing delete button; a "Control not enabled" chip instead).
    const remoteOwner = { owner_machine_id: "studio", owner_name: "Studio", is_local: false as const }
    const missing = readSessionControl({ amicode_owner: remoteOwner } as unknown as DropdownSession)
    expect(missing).toEqual({ controlState: "read-only", reason: "no-control-grant", eligibility: "enable-control" })
    expect(writeAffordanceEnabled(missing)).toBe(false)
    const malformed = readSessionControl({
      amicode_owner: remoteOwner,
      amicode_control: { nope: 1 },
    } as unknown as DropdownSession)
    expect(malformed.controlState).toBe("read-only")
    expect(writeAffordanceEnabled(malformed)).toBe(false)
  })
  test("a well-formed projection round-trips", () => {
    expect(readSessionControl(remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" })))).toEqual({
      controlState: "interactive",
      reason: null,
      eligibility: "none",
    })
  })
})

// ── sortDropdownSessions (#1599) ──────────────────────────────────────────────

describe("sortDropdownSessions", () => {
  // helper: create a minimal DropdownSession fixture
  function mk(
    id: string,
    title: string,
    created: number,
    updated?: number,
    ownerTag?: { owner_machine_id: string; owner_name: string; is_local: boolean },
  ): DropdownSession {
    return {
      id,
      title,
      directory: "/p",
      time: { created, ...(updated !== undefined ? { updated } : {}) },
      ...(ownerTag ? { amicode_owner: ownerTag } : {}),
    } as DropdownSession
  }

  const local = (id: string, title: string, created: number, updated?: number) =>
    mk(id, title, created, updated)
  const remote = (id: string, title: string, created: number, owner: string, updated?: number) =>
    mk(id, title, created, updated, { owner_machine_id: owner, owner_name: owner, is_local: false })

  describe("recent mode", () => {
    test("sorts by updated desc, falls back to created when no updated", () => {
      const sessions = [local("a", "A", 100), local("b", "B", 300), local("c", "C", 200)]
      const result = sortDropdownSessions(sessions, "recent")
      expect(result.map((s) => s.id)).toEqual(["b", "c", "a"])
    })

    test("prefers updated over created when both present", () => {
      const sessions = [local("a", "A", 100, 500), local("b", "B", 600, 200)]
      const result = sortDropdownSessions(sessions, "recent")
      expect(result.map((s) => s.id)).toEqual(["a", "b"])
    })

    test("tie-breaks by id ascending", () => {
      const sessions = [local("z", "Z", 100), local("a", "A", 100)]
      const result = sortDropdownSessions(sessions, "recent")
      expect(result.map((s) => s.id)).toEqual(["a", "z"])
    })
  })

  describe("alpha mode", () => {
    test("sorts by title case-insensitive ascending", () => {
      const sessions = [local("1", "Zebra", 300), local("2", "alpha", 100), local("3", "Middle", 200)]
      const result = sortDropdownSessions(sessions, "alpha")
      expect(result.map((s) => s.id)).toEqual(["2", "3", "1"])
    })

    test("tie-breaks by recency desc", () => {
      const sessions = [local("a", "Same", 100), local("b", "Same", 300)]
      const result = sortDropdownSessions(sessions, "alpha")
      expect(result.map((s) => s.id)).toEqual(["b", "a"])
    })

    test("falls back to id when title is missing", () => {
      const noTitle = { id: "zzz", directory: "/p", time: { created: 100 } } as DropdownSession
      const withTitle = local("aaa", "Beta", 200)
      const result = sortDropdownSessions([noTitle, withTitle], "alpha")
      // "Beta" < "zzz"
      expect(result.map((s) => s.id)).toEqual(["aaa", "zzz"])
    })
  })

  describe("machine mode", () => {
    test("local/unowned sessions come first, then by owner_name asc", () => {
      const sessions = [
        remote("r1", "R1", 300, "Studio"),
        local("l1", "L1", 100),
        remote("r2", "R2", 200, "Box"),
      ]
      const result = sortDropdownSessions(sessions, "machine")
      expect(result.map((s) => s.id)).toEqual(["l1", "r2", "r1"])
    })

    test("tie-breaks by recency within the same machine", () => {
      const sessions = [
        remote("r1", "R1", 100, "Box"),
        remote("r2", "R2", 300, "Box"),
      ]
      const result = sortDropdownSessions(sessions, "machine")
      expect(result.map((s) => s.id)).toEqual(["r2", "r1"])
    })

    test("sessions with is_local=true are treated as local", () => {
      const localTagged = mk("l", "L", 100, undefined, { owner_machine_id: "me", owner_name: "Me", is_local: true })
      const remoteTagged = remote("r", "R", 200, "Peer")
      const result = sortDropdownSessions([remoteTagged, localTagged], "machine")
      expect(result[0].id).toBe("l")
      expect(result[1].id).toBe("r")
    })
  })

  test("never mutates the input array", () => {
    const sessions = [local("b", "B", 100), local("a", "A", 200)]
    const original = [...sessions]
    sortDropdownSessions(sessions, "alpha")
    expect(sessions.map((s) => s.id)).toEqual(original.map((s) => s.id))
  })

  test("returns empty array for empty input", () => {
    expect(sortDropdownSessions([], "recent")).toEqual([])
    expect(sortDropdownSessions([], "alpha")).toEqual([])
    expect(sortDropdownSessions([], "machine")).toEqual([])
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
    const session = remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }), "test-desktop")
    expect(drivingBanner(session)).toEqual({ machineId: "test-desktop" })
  })
  test("not interactive (read-only / local) → no banner", () => {
    expect(drivingBanner(remoteWith(ctrl({ controlState: "read-only" })))).toBeNull()
    const local = { id: "l", directory: "/d", time: { created: 1 } } as DropdownSession
    expect(drivingBanner(local)).toBeNull()
  })
})

describe("#1544 remoteDeleteAction — owner-routed delete, gated on control (arm→confirm reused, not this gate)", () => {
  test("control held → allowed + an OWNER-ROUTED request carrying the owner machineId", () => {
    const session = remoteWith(ctrl({ controlState: "interactive", reason: null, eligibility: "none" }), "test-desktop")
    const action = remoteDeleteAction(session)
    expect(action.allowed).toBe(true)
    expect(action.request).toEqual({ sessionID: "ses_studio", directory: "/studio-proj", ownerMachineId: "test-desktop" })
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
  const laptopTag = { owner_machine_id: "test-laptop", owner_name: "MacBook Pro", is_local: true }
  const studio = { owner_machine_id: "test-desktop", owner_name: "Test Desktop", is_local: false }
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
    expect(groups[1].machineId).toBe("test-desktop")
    expect(groups[1].label).toBe("Test Desktop")
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
    expect(groups.map((g) => g.machineId)).toEqual([null, "lab-tower", "test-desktop"])
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["t1", "t2"])
    expect(groups[2].sessions.map((s) => s.id)).toEqual(["s1"])
  })

  test("only-peer input → an empty local group followed by the labeled peer group(s)", () => {
    const groups = groupSessionsByOwner([mk("s1", studio)])
    expect(groups).toHaveLength(2)
    expect(groups[0].machineId).toBeNull()
    expect(groups[0].sessions).toEqual([])
    expect(groups[1].machineId).toBe("test-desktop")
    expect(groups[1].sessions.map((s) => s.id)).toEqual(["s1"])
  })
})

// #1599: the dropdown now renders a FLAT list with per-row machine badges
// (no per-machine group headers). Source-assertion confirms the old grouping
// code was removed and the sort utility is wired in.
describe("#1599 the dropdown renders a flat sorted list (no machine group headers)", () => {
  const headerSource = readFileSync(resolve(__dirname, "session-header.tsx"), "utf8")
  test("the dropdown uses sortDropdownSessions and does NOT group by owner", () => {
    expect(headerSource).toContain("sortDropdownSessions(")
    expect(headerSource).not.toContain("groupSessionsByOwner(")
    expect(headerSource).not.toContain('data-slot="session-group-label"')
  })
})

// ── #1568: drivenByBanner — presence indicator for locally-owned sessions
// being remotely controlled. The REVERSE of drivingBanner: a local session
// whose projection entry carries `amicode_controlled_by` shows who is driving.
describe("#1568 drivenByBanner — presence indicator for a locally-controlled session", () => {
  test("local session with amicode_controlled_by → banner carries the controller machine info", () => {
    const session = {
      id: "ses_local",
      directory: "/proj",
      time: { created: 1 },
      amicode_owner: localTag,
      amicode_controlled_by: { machine_id: "peer-studio", machine_name: "Mac Studio" },
    } as DropdownSession
    expect(drivenByBanner(session)).toEqual({ machineId: "peer-studio", machineName: "Mac Studio" })
  })

  test("local session without amicode_controlled_by → no banner", () => {
    const session = {
      id: "ses_local",
      directory: "/proj",
      time: { created: 1 },
      amicode_owner: localTag,
    } as DropdownSession
    expect(drivenByBanner(session)).toBeNull()
  })

  test("remote session with amicode_controlled_by → no banner (only local sessions show it)", () => {
    const session = {
      id: "ses_remote",
      directory: "/proj",
      time: { created: 1 },
      amicode_owner: studioTag,
      amicode_controlled_by: { machine_id: "peer-x", machine_name: "X" },
    } as DropdownSession
    expect(drivenByBanner(session)).toBeNull()
  })

  test("undefined / garbage → no banner (tolerant, never throws)", () => {
    expect(drivenByBanner(undefined)).toBeNull()
    expect(drivenByBanner({} as DropdownSession)).toBeNull()
  })

  test("drivenByBannerFromProjection reads the overlay off the fleet projection by session id", () => {
    const raw = {
      sessions: [
        {
          id: "ses_local",
          time: { created: 1 },
          amicode_owner: { owner_machine_id: "me", owner_name: "Me", is_local: true },
          amicode_controlled_by: { machine_id: "studio", machine_name: "Mac Studio" },
        },
        {
          id: "ses_no_control",
          time: { created: 2 },
          amicode_owner: { owner_machine_id: "me", owner_name: "Me", is_local: true },
        },
      ],
    }
    expect(drivenByBannerFromProjection(raw, "ses_local")).toEqual({ machineId: "studio", machineName: "Mac Studio" })
    expect(drivenByBannerFromProjection(raw, "ses_no_control")).toBeNull()
    expect(drivenByBannerFromProjection(raw, "unknown")).toBeNull()
    expect(drivenByBannerFromProjection(undefined, "x")).toBeNull()
  })
})

// The Studio dropdown must show LOCAL sessions too — including local sessions in
// directories the local store never iterates (a remote-created session that
// landed in the owner's ambient temp cwd, or any project not in projects.list()).
// peerSessionsFromProjection drops all is_local rows on the assumption "the local
// list already carries those" — false for an unlisted-directory session, so such a
// session was invisible on the owning machine's dropdown. allSessionsFromProjection
// keeps local AND remote rows; mergePeerSessions then dedupes (local store wins),
// so listed-dir sessions are unchanged and only the missing ones are surfaced.
describe("allSessionsFromProjection — local + remote (the Studio-dropdown fix)", () => {
  test("keeps BOTH local and remote rows (unlike peerSessionsFromProjection)", () => {
    const raw = projection([
      { id: "ses_local_temp", time: { created: 2 }, title: "Testing greeting", directory: "/var/folders/T/engine-x", amicode_owner: localTag },
      { id: "ses_remote", time: { created: 1 }, title: "Peer one", amicode_owner: studioTag },
    ])
    const out = allSessionsFromProjection(raw)
    const ids = out.map((s) => s.id).sort()
    expect(ids).toEqual(["ses_local_temp", "ses_remote"])
  })

  test("surfaces a local temp-dir session the local store list is missing", () => {
    // The local store list only has sessions from listed project dirs.
    const localList: DropdownSession[] = [
      { id: "ses_in_project", time: { created: 5 }, directory: "/Users/jj/harmoniqs/amicode" } as DropdownSession,
    ]
    // The projection (cross-project) carries that one PLUS the temp-dir local one.
    const raw = projection([
      { id: "ses_in_project", time: { created: 5 }, directory: "/Users/jj/harmoniqs/amicode", amicode_owner: localTag },
      { id: "ses_local_temp", time: { created: 9 }, title: "Testing greeting", directory: "/var/folders/T/engine-x", amicode_owner: localTag },
    ])
    const merged = mergePeerSessions(localList, allSessionsFromProjection(raw))
    expect(merged.map((s) => s.id)).toContain("ses_local_temp")
  })

  test("tolerant: garbage/empty ⇒ []", () => {
    expect(allSessionsFromProjection(undefined)).toEqual([])
    expect(allSessionsFromProjection({})).toEqual([])
    expect(allSessionsFromProjection({ sessions: "nope" })).toEqual([])
  })
})

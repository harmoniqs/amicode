import { describe, expect, test } from "bun:test"
import {
  peerSessionsFromProjection,
  mergePeerSessions,
  deriveSessionBadge,
  isRemotePeerSession,
  resolveDropdownOpenAction,
  type DropdownSession,
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

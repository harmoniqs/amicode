import { describe, expect, test } from "bun:test"
import { archivedSessionsWithRemote, type DropdownSession } from "./session-fleet-peers"

// #1647 (S3): the local Archive tab becomes fleet-aware. archivedSessionsWithRemote
// merges this machine's LOCAL archived sessions (authoritative, engine-paginated)
// with the peer-owned archived sessions from GET /amicode/fleet/sessions?archived=true.
// Standalone / fetch-failure ⇒ raw undefined ⇒ the local list is unchanged.

const localArchived: DropdownSession[] = [
  { id: "loc-1", time: { created: 5, updated: 5, archived: 5 } } as DropdownSession,
]

function projection(sessions: unknown[]): unknown {
  return { ok: true, mode: "fleet", sessions }
}

describe("#1647 S3 — archivedSessionsWithRemote", () => {
  test("raw undefined (standalone / fetch failure) ⇒ local list unchanged", () => {
    expect(archivedSessionsWithRemote(localArchived, undefined)).toEqual(localArchived)
  })

  test("remote archived peer sessions are merged in, owner-tagged", () => {
    const raw = projection([
      { id: "peer-1", time: { created: 9, updated: 9, archived: 9 }, amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false } },
    ])
    const merged = archivedSessionsWithRemote(localArchived, raw)
    const ids = merged.map((s) => s.id).sort()
    expect(ids).toEqual(["loc-1", "peer-1"])
    const peer = merged.find((s) => s.id === "peer-1")!
    expect(peer.amicode_owner?.owner_machine_id).toBe("mac-studio")
    expect(peer.amicode_owner?.is_local).toBe(false)
  })

  test("a LOCAL session in the projection is not double-added (peers-only pull)", () => {
    const raw = projection([
      { id: "loc-1", time: { created: 5, updated: 5, archived: 5 }, amicode_owner: { owner_machine_id: "local", owner_name: "Me", is_local: true } },
      { id: "peer-1", time: { created: 9, updated: 9, archived: 9 }, amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false } },
    ])
    const merged = archivedSessionsWithRemote(localArchived, raw)
    expect(merged.map((s) => s.id).sort()).toEqual(["loc-1", "peer-1"])
  })

  test("sorted by last activity descending (most recent first)", () => {
    const raw = projection([
      { id: "peer-1", time: { created: 9, updated: 9, archived: 9 }, amicode_owner: { owner_machine_id: "mac-studio", owner_name: "Mac Studio", is_local: false } },
    ])
    const merged = archivedSessionsWithRemote(localArchived, raw)
    expect(merged.map((s) => s.id)).toEqual(["peer-1", "loc-1"])
  })
})

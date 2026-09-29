import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

// #1649 — ancestor-of-active-child floor. A foreground subagent (Task tool)
// blocks its parent's turn inside the tool: the engine holds the parent runner
// busy but the parent emits no parts and no execution bracket, so neither the
// streamActiveParts nor the turnActive floor rises, and a stray/reconcile idle
// would blank the parent rail. session_working(parent) must stay true while any
// descendant is non-idle, and — critically — the parent's reactive consumers
// must RE-RUN when a child first spawns and when it goes idle (a plain-Map read
// would not be reactive; the fix pushes a store leaf, so it is).
//
// Dedicated file (not appended to server-session.test.ts): that suite has
// documented positive cross-test dependencies (#1239); a separate file is hermetic.

const sessionInfo = (id: string, parentID?: string) =>
  ({ id, parentID, time: { created: 1, updated: 1 } }) as Session

// A `task` tool part carrying the spawn metadata recordTaskSpawn reads
// (parentSessionId/sessionId live in part.state.metadata).
const taskPart = (input: { id: string; parentSessionID: string; childSessionID: string }) =>
  ({
    id: input.id,
    sessionID: input.parentSessionID,
    messageID: `msg_${input.parentSessionID}`,
    type: "tool",
    tool: "task",
    callID: `call_${input.id}`,
    state: {
      status: "running",
      input: {},
      time: { start: 1 },
      metadata: { parentSessionId: input.parentSessionID, sessionId: input.childSessionID },
    },
  }) as unknown as Part

function createSession() {
  return createServerSession({ session: { get: async () => ({ data: undefined }) } } as unknown as OpencodeClient)
}

const spawnChild = (session: ReturnType<typeof createSession>, parentID: string, childID: string) => {
  session.apply({ type: "session.created", properties: { info: sessionInfo(parentID) } })
  session.apply({ type: "session.created", properties: { info: sessionInfo(childID, parentID) } })
  // Parent turn goes busy, then the task tool part records the ancestry.
  session.apply({ type: "session.status", properties: { sessionID: parentID, status: { type: "busy" } } })
  session.apply({
    type: "message.part.updated",
    properties: { part: taskPart({ id: "task_1", parentSessionID: parentID, childSessionID: childID }) },
  })
}

describe("#1649 — ancestor-of-active-child floor", () => {
  test("parent stays working across a stray reconcile idle while the child is busy", () => {
    const session = createSession()
    spawnChild(session, "P", "C")
    session.apply({ type: "session.status", properties: { sessionID: "C", status: { type: "busy" } } })
    expect(session.data.session_working("P")).toBe(true)

    // A stray/reconcile idle downgrades the PARENT's own leaf — but the child is
    // still busy, so the floor must hold.
    session.apply({ type: "session.status", properties: { sessionID: "P", status: { type: "idle" } } })
    expect(session.data.session_status["P"]?.type).toBe("idle")
    expect(session.data.session_working("P")).toBe(true) // held by the child floor
  })

  test("the parent floor lowers when the child goes idle", () => {
    const session = createSession()
    spawnChild(session, "P2", "C2")
    session.apply({ type: "session.status", properties: { sessionID: "C2", status: { type: "busy" } } })
    // Parent's own leaf goes idle (turn's raw status settled) but child holds it.
    session.apply({ type: "session.status", properties: { sessionID: "P2", status: { type: "idle" } } })
    expect(session.data.session_working("P2")).toBe(true)
    // Child finishes → floor lowers → parent no longer working.
    session.apply({ type: "session.status", properties: { sessionID: "C2", status: { type: "idle" } } })
    expect(session.data.session_working("P2")).toBe(false)
  })

  test("a child terminal via execution.succeeded also lowers the floor", () => {
    const session = createSession()
    spawnChild(session, "P3", "C3")
    session.apply({ type: "session.status", properties: { sessionID: "C3", status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: "P3", status: { type: "idle" } } })
    expect(session.data.session_working("P3")).toBe(true)
    session.apply({ type: "session.execution.succeeded", properties: { sessionID: "C3" } })
    expect(session.data.session_working("P3")).toBe(false)
  })

  test("REACTIVITY MECHANISM: the child floor is a store leaf (session_child_active), written on spawn/edge", () => {
    // The fix's reactivity rests on session_child_active being a STORE leaf
    // (setData-written), not a plain-Map read — so a parent's projection memo
    // re-runs on a child edge. Under bun's solid-js server build, createMemo
    // does not track (it resolves to solid-js/dist/server.js — a no-op stub), so
    // we assert the reactive SOURCE directly: the store leaf transitions on the
    // child's status edges, which is what drives the parent consumer. (The end-
    // to-end re-render is covered by the human live-reproduce; see the ledger.)
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("PR") } })
    // No child yet → no floor entry.
    expect(session.data.session_child_active["PR"] ?? 0).toBe(0)
    expect(session.data.session_working("PR")).toBe(false)

    session.apply({ type: "session.created", properties: { info: sessionInfo("CR", "PR") } })
    session.apply({ type: "session.status", properties: { sessionID: "PR", status: { type: "busy" } } })
    session.apply({
      type: "message.part.updated",
      properties: { part: taskPart({ id: "task_r", parentSessionID: "PR", childSessionID: "CR" }) },
    })
    session.apply({ type: "session.status", properties: { sessionID: "CR", status: { type: "busy" } } })
    // The store leaf rose on the child busy — the reactive source is live.
    expect(session.data.session_child_active["PR"]).toBe(1)
    // Stray-idle the parent: only the child floor holds it working.
    session.apply({ type: "session.status", properties: { sessionID: "PR", status: { type: "idle" } } })
    expect(session.data.session_working("PR")).toBe(true)

    // Child idle lowers the leaf back to 0.
    session.apply({ type: "session.status", properties: { sessionID: "CR", status: { type: "idle" } } })
    expect(session.data.session_child_active["PR"] ?? 0).toBe(0)
    expect(session.data.session_working("PR")).toBe(false)
  })

  test("idempotent: duplicate child busy frames do not drift the floor; one idle clears it", () => {
    const session = createSession()
    spawnChild(session, "P4", "C4")
    // Several busy frames for the same child (reorder/duplicate).
    session.apply({ type: "session.status", properties: { sessionID: "C4", status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: "C4", status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: "C4", status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: "P4", status: { type: "idle" } } })
    expect(session.data.session_working("P4")).toBe(true)
    // A single idle must fully clear it (contribution was 1, not 3).
    session.apply({ type: "session.status", properties: { sessionID: "C4", status: { type: "idle" } } })
    expect(session.data.session_working("P4")).toBe(false)
  })

  test("evict clears the child index so a parent is not wedged live forever", () => {
    const session = createSession()
    spawnChild(session, "P5", "C5")
    session.apply({ type: "session.status", properties: { sessionID: "C5", status: { type: "busy" } } })
    session.apply({ type: "session.status", properties: { sessionID: "P5", status: { type: "idle" } } })
    expect(session.data.session_working("P5")).toBe(true)
    // Deleting the child tears down the ancestry + floor via evict.
    session.apply({ type: "session.deleted", properties: { sessionID: "C5" } })
    expect(session.data.session_working("P5")).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Part, Session, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createServerSession } from "./server-session"

const sessionInfo = (id: string, parentID?: string) =>
  ({
    id,
    parentID,
    time: { created: 1, updated: 1 },
  }) as Session

const toolPart = (input: {
  id: string
  sessionID: string
  tool: string
  metadata?: Record<string, unknown>
}) =>
  ({
    id: input.id,
    sessionID: input.sessionID,
    messageID: `msg_${input.sessionID}`,
    type: "tool",
    tool: input.tool,
    callID: `call_${input.id}`,
    state: {
      status: "completed",
      input: {},
      output: "",
      title: input.tool,
      time: { start: 1, end: 2 },
      metadata: input.metadata,
    },
  }) as Part

function createSession() {
  return createServerSession({ session: { get: async () => ({ data: undefined }) } } as unknown as OpencodeClient)
}

describe("ServerSession live file-edit route", () => {
  test("invalidates a task-spawn parent for every completed file-edit tool", () => {
    for (const tool of ["edit", "write", "patch", "apply_patch"]) {
      const session = createSession()
      session.apply({ type: "session.created", properties: { info: sessionInfo("root") } })
      session.apply({ type: "session.created", properties: { info: sessionInfo("tab", "root") } })
      session.apply({
        type: "message.part.updated",
        properties: {
          part: toolPart({
            id: `task_${tool}`,
            sessionID: "tab",
            tool: "task",
            metadata: { parentSessionId: "tab", sessionId: `worker_${tool}` },
          }),
        },
      })
      session.apply({
        type: "message.part.updated",
        properties: {
          part: toolPart({
            id: `edit_${tool}`,
            sessionID: `worker_${tool}`,
            tool,
            metadata: { filediff: { file: `${tool}.ts`, status: "modified" } },
          }),
        },
      })

      expect(session.data.diff_version[`worker_${tool}`]).toBe(1)
      expect(session.data.diff_version.tab).toBe(1)
      expect(session.data.diff_version.root).toBeUndefined()
    }
  })

  test("records task ancestry before the child edit and invalidates only task-spawn ancestors while busy", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("root") } })
    session.apply({ type: "session.created", properties: { info: sessionInfo("tab", "root") } })
    session.set("session_status", "tab", { type: "busy" } as SessionStatus)

    session.apply({
      type: "message.part.updated",
      properties: {
        part: toolPart({
          id: "task_1",
          sessionID: "tab",
          tool: "task",
          metadata: { parentSessionId: "tab", sessionId: "worker" },
        }),
      },
    })

    const parentDiffKey = () => `${session.data.session_status.tab?.type ?? "idle"}:${session.data.diff_version.tab ?? 0}`
    expect(parentDiffKey()).toBe("busy:0")

    const workerEdit = {
      type: "message.part.updated",
      properties: {
        part: toolPart({
          id: "edit_1",
          sessionID: "worker",
          tool: "edit",
          metadata: { filediff: { file: "changed.ts", status: "modified" } },
        }),
      },
    }
    session.apply(workerEdit)
    session.apply(workerEdit)

    expect(session.data.diff_version.worker).toBe(1)
    expect(session.data.diff_version.tab).toBe(1)
    expect(session.data.diff_version.root).toBeUndefined()
    expect(parentDiffKey()).toBe("busy:1")

    const generic = createSession()
    generic.apply({ type: "session.created", properties: { info: sessionInfo("generic-root") } })
    generic.apply({ type: "session.created", properties: { info: sessionInfo("generic-child", "generic-root") } })
    generic.apply({
      type: "message.part.updated",
      properties: {
        part: toolPart({
          id: "edit_generic",
          sessionID: "generic-child",
          tool: "write",
          metadata: { filediff: { file: "changed.ts", status: "added" } },
        }),
      },
    })

    expect(generic.data.diff_version["generic-child"]).toBe(1)
    expect(generic.data.diff_version["generic-root"]).toBeUndefined()
  })

  test("an evicted session can invalidate again when its completed file part is seen again", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("worker") } })
    const workerEdit = {
      type: "message.part.updated",
      properties: {
        part: toolPart({
          id: "edit_evict",
          sessionID: "worker",
          tool: "apply_patch",
          metadata: { filediff: { file: "changed.ts", status: "modified" } },
        }),
      },
    }
    session.apply(workerEdit)

    expect(session.data.diff_version.worker).toBe(1)
    session.evict("worker")
    expect(session.data.diff_version.worker).toBeUndefined()

    session.apply(workerEdit)
    expect(session.data.diff_version.worker).toBe(1)
  })
})

// ── #1617 (follow-up) — rail must not go idle while the agent is still streaming ──
// The wire carries NO sequence/timestamp on session status (only {type}), and the
// client's session_status writer blindly overwrites from THREE unordered writers.
// A racing/stale `idle` (from a prior turn, or a reordered frame) could blank the
// rail while the agent is still producing output. The self-correcting floor:
// session_working() stays true while message-part deltas are actively streaming
// for the session, regardless of a stray idle status.
describe("#1617 — session_working floor: a racing idle does not blank a streaming rail", () => {
  const textPart = (id: string, sessionID: string, text = "") =>
    ({
      id,
      sessionID,
      messageID: `msg_${sessionID}`,
      type: "text",
      text,
    }) as Part
  const assistantMessage = (sessionID: string) =>
    ({
      id: `msg_${sessionID}`,
      sessionID,
      role: "assistant",
      time: { created: 1 },
    }) as unknown as Parameters<ReturnType<typeof createSession>["apply"]>[0]

  // Establish the parent message so a part.updated is not dropped as an orphan.
  const openStreamingMessage = (session: ReturnType<typeof createSession>, sessionID: string) => {
    session.apply({ type: "message.updated", properties: { info: assistantMessage(sessionID) } })
    session.apply({ type: "message.part.updated", properties: { part: textPart("p1", sessionID, "hel") } })
    session.apply({
      type: "message.part.delta",
      properties: { sessionID, messageID: `msg_${sessionID}`, partID: "p1", field: "text", delta: "lo" },
    })
  }

  test("an idle status arriving WHILE parts stream keeps session_working true", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("s1") } })
    // The turn is running: busy + a text part that is actively receiving deltas.
    session.apply({ type: "session.status", properties: { sessionID: "s1", status: { type: "busy" } } })
    openStreamingMessage(session, "s1")
    expect(session.data.session_working("s1")).toBe(true)

    // A RACING/STALE idle arrives (reordered, or from a prior turn). The rail must
    // NOT blank while deltas are still streaming.
    session.apply({ type: "session.status", properties: { sessionID: "s1", status: { type: "idle" } } })
    expect(session.data.session_working("s1")).toBe(true) // <-- RED before the fix
  })

  test("a genuine idle AFTER streaming stops clears session_working", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("s2") } })
    session.apply({ type: "session.status", properties: { sessionID: "s2", status: { type: "busy" } } })
    openStreamingMessage(session, "s2")
    expect(session.data.session_working("s2")).toBe(true)
    // Streaming settles: the finalizing part.updated clears the stream marker, then idle.
    session.apply({ type: "message.part.updated", properties: { part: textPart("p1", "s2", "hello") } })
    session.apply({ type: "session.status", properties: { sessionID: "s2", status: { type: "idle" } } })
    expect(session.data.session_working("s2")).toBe(false)
  })

  test("no false floor: a session with no streaming and an idle status is not working", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("s3") } })
    session.apply({ type: "session.status", properties: { sessionID: "s3", status: { type: "idle" } } })
    expect(session.data.session_working("s3")).toBe(false)
  })
})

// ── #1637 — turn-active floor keyed on execution.started (covers no-part turns) ──
// The #1617 per-delta floor only rises on message.part.{delta}, but most turns
// stream via message.part.updated and some turns produce NO parts at all
// (refusal, immediate provider error, empty completion, abort-before-first-token).
// The turn-active flag is keyed on session.execution.started — the bracket the
// server emits for EVERY turn shape — and cleared on the terminal execution
// events OR any fallback (session.error / eviction / idle status frame / bounded
// timeout), so a swallowed terminal cannot wedge the rail "working" forever.
describe("#1637 — turn-active floor keyed on execution.started", () => {
  test("a no-part turn keeps session_working true for its duration and clears once when it ends", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("np1") } })
    // execution.started brackets the turn — no parts are ever produced.
    session.apply({ type: "session.execution.started", properties: { sessionID: "np1" } })
    // The server stamps a monotonic seq on the busy status frame (#1636).
    session.apply({ type: "session.status", properties: { sessionID: "np1", status: { type: "busy" }, seq: 5 } })
    expect(session.data.session_working("np1")).toBe(true)
    // A stray/reordered idle from a prior turn (lower seq) must NOT blank the rail:
    // the seq guard drops it before it can clear the turn flag.
    session.apply({ type: "session.status", properties: { sessionID: "np1", status: { type: "idle" }, seq: 2 } })
    expect(session.data.session_working("np1")).toBe(true)
    // The turn ends (empty completion) → clears exactly once.
    session.apply({ type: "session.execution.succeeded", properties: { sessionID: "np1" } })
    expect(session.data.session_working("np1")).toBe(false)
  })

  test("a turn streaming only tool/reasoning parts keeps session_working true across a stray idle", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("to1") } })
    session.apply({ type: "session.execution.started", properties: { sessionID: "to1" } })
    session.apply({ type: "session.status", properties: { sessionID: "to1", status: { type: "busy" }, seq: 8 } })
    // A completed tool part (no text delta stream) arrives; then a racing idle.
    session.apply({
      type: "message.part.updated",
      properties: { part: toolPart({ id: "t1", sessionID: "to1", tool: "read" }) },
    })
    // A stray idle (lower seq) — dropped by the seq guard, floor held by the turn flag.
    session.apply({ type: "session.status", properties: { sessionID: "to1", status: { type: "idle" }, seq: 4 } })
    expect(session.data.session_working("to1")).toBe(true)
    session.apply({ type: "session.execution.interrupted", properties: { sessionID: "to1" } })
    expect(session.data.session_working("to1")).toBe(false)
  })

  test("clear path: session.execution.failed clears the flag (no stuck-working)", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("cf") } })
    session.apply({ type: "session.execution.started", properties: { sessionID: "cf" } })
    expect(session.data.session_working("cf")).toBe(true)
    session.apply({ type: "session.execution.failed", properties: { sessionID: "cf" } })
    expect(session.data.session_working("cf")).toBe(false)
  })

  test("clear path: session.error clears a flag left set by a swallowed terminal", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("ce") } })
    session.apply({ type: "session.execution.started", properties: { sessionID: "ce" } })
    expect(session.data.session_working("ce")).toBe(true)
    // A Session.Event.Error site skips the terminal execution event; session.error is the fallback.
    session.apply({ type: "session.error", properties: { sessionID: "ce", error: { name: "ProviderError" } } })
    expect(session.data.session_working("ce")).toBe(false)
  })

  test("clear path: eviction / session.deleted clears the flag", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("cd") } })
    session.apply({ type: "session.execution.started", properties: { sessionID: "cd" } })
    expect(session.data.session_working("cd")).toBe(true)
    session.apply({ type: "session.deleted", properties: { sessionID: "cd" } })
    expect(session.data.session_working("cd")).toBe(false)
  })

  test("clear path: an idle session.status frame clears the flag once the turn is genuinely idle", () => {
    // The idle-frame fallback clears the turn flag. (The mid-turn floor is held by
    // the ACTIVE-part stream / a fresh execution bracket, not a lone idle frame;
    // here there is no active stream, so an authoritative idle frame settles it.)
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("ci") } })
    session.apply({ type: "session.execution.started", properties: { sessionID: "ci" } })
    expect(session.data.session_working("ci")).toBe(true)
    session.apply({ type: "session.status", properties: { sessionID: "ci", status: { type: "idle" } } })
    // The flag itself is cleared by the idle frame (fallback); with no active
    // stream and idle status, the session is no longer working.
    expect(session.data.session_working("ci")).toBe(false)
  })

  test("clear path: the bounded timeout clears a flag whose terminal never arrived", async () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("ct") } })
    // A tiny timeout so the test is fast; the flag must self-clear when it fires.
    session.apply({ type: "session.execution.started", properties: { sessionID: "ct", turnFloorTimeoutMs: 20 } })
    expect(session.data.session_working("ct")).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(session.data.session_working("ct")).toBe(false)
  })
})

// ── #1637 — honor status seq (drop stale/out-of-order status) — depends on #1636 ──
// #1636 stamps a strictly-increasing-per-session `seq` on session.status event
// DATA (v1 event.properties.seq / v2 event.data.seq, adapted to properties.seq
// in this reducer). A client tracking the max seq per session must DISCARD any
// status frame carrying seq <= what it has already seen.
describe("#1637 — honor status seq: a status with seq <= last seen is discarded", () => {
  test("a stale idle (seq below the last busy) does not overwrite the live busy", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("q1") } })
    session.apply({ type: "session.status", properties: { sessionID: "q1", status: { type: "busy" }, seq: 5 } })
    expect(session.data.session_status.q1?.type).toBe("busy")
    // An out-of-order idle with a LOWER seq must be dropped.
    session.apply({ type: "session.status", properties: { sessionID: "q1", status: { type: "idle" }, seq: 3 } })
    expect(session.data.session_status.q1?.type).toBe("busy")
    // A newer seq is honored.
    session.apply({ type: "session.status", properties: { sessionID: "q1", status: { type: "idle" }, seq: 6 } })
    expect(session.data.session_status.q1?.type).toBe("idle")
  })

  test("an equal seq is discarded (strictly-greater to win)", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("q2") } })
    session.apply({ type: "session.status", properties: { sessionID: "q2", status: { type: "busy" }, seq: 10 } })
    session.apply({ type: "session.status", properties: { sessionID: "q2", status: { type: "idle" }, seq: 10 } })
    expect(session.data.session_status.q2?.type).toBe("busy")
  })

  test("seq is optional: a status frame without seq is applied (pre-#1636 compat)", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("q3") } })
    session.apply({ type: "session.status", properties: { sessionID: "q3", status: { type: "busy" }, seq: 4 } })
    // A frame with NO seq is still applied (the flag+reconcile halves must land without seq).
    session.apply({ type: "session.status", properties: { sessionID: "q3", status: { type: "idle" } } })
    expect(session.data.session_status.q3?.type).toBe("idle")
  })
})

// ── #1637 — reconcile session_status from /session/status on reconnect/gap ──
// On a reconnect edge and on a gap frame the client must re-fetch the FULL
// tri-state status map (/session/status — NOT /session/active, which is
// running-only and cannot carry idle) and correct BOTH a stale idle and a stale
// busy without a reload — recency-guarded so an out-of-order reconcile cannot
// downgrade a LIVE busy to idle.
describe("#1637 — reconcileStatuses from /session/status (tri-state)", () => {
  test("corrects a stale idle: a fetched busy raises a session the client left idle", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("r1") } })
    session.apply({ type: "session.status", properties: { sessionID: "r1", status: { type: "idle" } } })
    // A reconcile fetched AFTER the local idle sees the session actually busy.
    session.reconcileStatuses({ r1: { type: "busy" } }, { fetchedAt: Date.now() + 1000 })
    expect(session.data.session_status.r1?.type).toBe("busy")
  })

  test("corrects a stale busy: a fetched idle downgrades a session the client left busy (older local mutation)", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("r2") } })
    session.apply({ type: "session.status", properties: { sessionID: "r2", status: { type: "busy" } } })
    // The reconcile response is newer than the last local mutation → downgrade is honored.
    session.reconcileStatuses({ r2: { type: "idle" } }, { fetchedAt: Date.now() + 1000 })
    expect(session.data.session_status.r2?.type).toBe("idle")
  })

  test("recency guard: an out-of-order (older) reconcile does NOT downgrade a live busy to idle", () => {
    const session = createSession()
    session.apply({ type: "session.created", properties: { info: sessionInfo("r3") } })
    // The reconcile was fetched in the past; the local busy is fresher.
    const past = Date.now() - 10_000
    session.apply({ type: "session.status", properties: { sessionID: "r3", status: { type: "busy" } } })
    session.reconcileStatuses({ r3: { type: "idle" } }, { fetchedAt: past })
    expect(session.data.session_status.r3?.type).toBe("busy") // live busy preserved
  })
})

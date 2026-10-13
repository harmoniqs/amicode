import { describe, expect, test } from "bun:test"
import type { OpencodeClient, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { createStore, produce } from "solid-js/store"
import { createServerSession } from "./server-session"
import {
  INBOX_STALE_MS,
  INBOX_TTL_MS,
  applyInboxClears,
  collectQuestionInbox,
  createInboxAnswerAction,
  createInboxState,
  initQuestionInbox,
  questionInbox,
  runInboxRead,
  type InboxClear,
} from "./question-inbox"

// amicode#1786 (S2) — the question inbox model. The seams it rides are pinned
// elsewhere (the #1753 live dispatch seam, the store's question lifecycle in
// server-session.test.ts); these tests pin the INBOX's own behavior: deriving
// every pending question from the shared store (no session opened), the
// session identity + staleness read, TTL clearing, the reconcile read's
// recency-guarded freshness, and the reply action's single-flight +
// idempotency + telemetry floor.

const sessionInfo = (id: string, directory?: string, title?: string) =>
  ({ id, directory, title, time: { created: 1, updated: 1 } }) as Session

const questionRequest = (id: string, sessionID: string, header = id) =>
  ({
    id,
    sessionID,
    questions: [{ header, question: `${header}?`, options: [{ label: "a", description: "d" }] }],
  }) as QuestionRequest

function createSession() {
  return createServerSession({ session: { get: async () => ({ data: undefined }) } } as unknown as OpencodeClient)
}

// ── AC1: a question asked by a session the client has NOT opened ────────────

describe("#1786 AC1 — an unopened session's question lists in the inbox", () => {
  test("a live question.asked event lands in the inbox with the badge count rising to 1", () => {
    const session = createSession()
    const state = createInboxState()
    // The session was never created, never opened, no info in the store — the
    // question arrives cold over the directory's event stream.
    session.apply({ type: "question.asked", properties: questionRequest("que_live", "ses_unopened") })

    const entries = collectQuestionInbox({ question: session.data.question, info: session.data.info, state, now: 1_000 })
    expect(entries.length).toBe(1)
    expect(entries[0]?.id).toBe("que_live")
    expect(entries[0]?.sessionID).toBe("ses_unopened")
    // The badge count is the entry count.
    expect(entries.length).toBe(1)
  })

  test("settle on question.replied: the entry leaves the inbox and its tracking state is dropped", () => {
    const session = createSession()
    const state = createInboxState()
    session.apply({ type: "question.asked", properties: questionRequest("que_gone", "ses_unopened") })
    collectQuestionInbox({ question: session.data.question, info: session.data.info, state, now: 1_000 })

    session.apply({
      type: "question.replied",
      properties: { sessionID: "ses_unopened", requestID: "que_gone" },
    })

    const entries = collectQuestionInbox({ question: session.data.question, info: session.data.info, state, now: 2_000 })
    expect(entries.length).toBe(0)
    expect(state.evidence.has("que_gone")).toBe(false)
  })
})

// ── AC2: session identity + staleness read; answerable from the inbox ───────

describe("#1786 AC2 — the entry's session identity and staleness read", () => {
  test("an entry carries the session's title and directory from the shared info store", () => {
    const state = createInboxState()
    const question = { ses_a: [questionRequest("que_id", "ses_a")] }
    const info = { ses_a: sessionInfo("ses_a", "/work/proj", "CZ gate sweep") }
    const entries = collectQuestionInbox({ question, info, state, now: 5_000 })
    expect(entries[0]?.title).toBe("CZ gate sweep")
    expect(entries[0]?.directory).toBe("/work/proj")
    expect(entries[0]?.askedAt).toBe(5_000)
  })

  test("a fresh entry does not read as stale", () => {
    const state = createInboxState()
    const entries = collectQuestionInbox({
      question: { ses_a: [questionRequest("que_f", "ses_a")] },
      info: {},
      state,
      now: 10_000,
    })
    expect(entries[0]?.stale).toBe(false)
  })
})

// ── AC4: stale rows read honestly, never block, clear by TTL ────────────────

describe("#1786 AC4 — stale reads, non-blocking, TTL clearing", () => {
  test("an entry with no liveness evidence past the stale window reads honestly as stale", () => {
    const state = createInboxState()
    const question = { ses_a: [questionRequest("que_old", "ses_a")] }
    collectQuestionInbox({ question, info: {}, state, now: 1_000 })

    const entries = collectQuestionInbox({ question, info: {}, state, now: 1_000 + INBOX_STALE_MS + 1 })
    expect(entries.length).toBe(1)
    expect(entries[0]?.stale).toBe(true)
  })

  test("a stale entry never blocks the rest of the inbox: fresh entries stay fresh and listed", () => {
    const state = createInboxState()
    // The older question is seen first; the fresher one is asked later.
    const older = { ses_a: [questionRequest("que_old", "ses_a")] }
    const both = {
      ses_a: [questionRequest("que_old", "ses_a")],
      ses_fresh: [questionRequest("que_fresh", "ses_fresh")],
    }
    collectQuestionInbox({ question: older, info: {}, state, now: 1_000 })
    collectQuestionInbox({ question: both, info: {}, state, now: 1_000 + INBOX_STALE_MS })

    const entries = collectQuestionInbox({ question: both, info: {}, state, now: 1_000 + INBOX_STALE_MS + 1 })
    const stale = entries.find((entry) => entry.id === "que_old")
    const fresh = entries.find((entry) => entry.id === "que_fresh")
    expect(stale?.stale).toBe(true)
    expect(fresh?.stale).toBe(false)
    expect(entries.length).toBe(2)
  })

  test("clears by TTL: an entry with no evidence past the TTL drops from the inbox, others remain", () => {
    const state = createInboxState()
    const older = { ses_a: [questionRequest("que_dead", "ses_a")] }
    const both = {
      ses_a: [questionRequest("que_dead", "ses_a")],
      ses_fresh: [questionRequest("que_fresh", "ses_fresh")],
    }
    collectQuestionInbox({ question: older, info: {}, state, now: 1_000 })
    collectQuestionInbox({ question: both, info: {}, state, now: 1_000 + INBOX_STALE_MS })

    const after = collectQuestionInbox({ question: both, info: {}, state, now: 1_000 + INBOX_TTL_MS + 1 })
    expect(after.map((entry) => entry.id)).toEqual(["que_fresh"])
    // The TTL clear is stable on re-collect while the store row lingers
    // (the in-session dock keeps its own view of the same store).
    const again = collectQuestionInbox({ question: both, info: {}, state, now: 1_000 + INBOX_TTL_MS + 2 })
    expect(again.map((entry) => entry.id)).toEqual(["que_fresh"])
  })

  test("a TTL-cleared entry whose session later settles is forgotten entirely", () => {
    const state = createInboxState()
    const question: Record<string, QuestionRequest[]> = { ses_a: [questionRequest("que_dead", "ses_a")] }
    collectQuestionInbox({ question, info: {}, state, now: 1_000 })
    collectQuestionInbox({ question, info: {}, state, now: 1_000 + INBOX_TTL_MS + 1 })
    expect(state.tombstones.has("que_dead")).toBe(true)

    // The store row leaves (settled / evicted) — the tombstone must not leak.
    const settled: Record<string, QuestionRequest[]> = {}
    const entries = collectQuestionInbox({ question: settled, info: {}, state, now: 1_000 + INBOX_TTL_MS + 2 })
    expect(entries.length).toBe(0)
    expect(state.tombstones.has("que_dead")).toBe(false)
  })
})

// ── the reconcile read: freshness rides the event flow plus row TTLs ────────
// The engine's /question list is the shared pending rows (live-heartbeat rows
// only, any owner) — the read is the inbox's liveness probe; the #1768
// reconcile semantics apply (recency-guarded, honest absence keeps current
// value).

describe("#1786 — the inbox reconcile read", () => {
  const storeFor = (rows: Record<string, QuestionRequest[]>) => rows
  const infoFor = (directory: string) => ({ ses_a: sessionInfo("ses_a", directory), ses_b: sessionInfo("ses_b", directory) })

  test("presence refreshes liveness: a stale entry goes live again after the read includes it", async () => {
    const state = createInboxState()
    const question = storeFor({ ses_a: [questionRequest("que_1", "ses_a")] })
    const info = infoFor("/work/proj")
    collectQuestionInbox({ question, info, state, now: 1_000 })
    collectQuestionInbox({ question, info, state, now: 1_000 + INBOX_STALE_MS + 1 })
    const staleBefore = collectQuestionInbox({ question, info, state, now: 1_000 + INBOX_STALE_MS + 1 })
    expect(staleBefore[0]?.stale).toBe(true)

    const out = await runInboxRead({
      directory: "/work/proj",
      read: async () => [questionRequest("que_1", "ses_a")],
      question,
      info,
      state,
      now: () => 1_000 + INBOX_STALE_MS + 2,
    })

    expect(out.kind).toBe("ok")
    expect(out.refreshed).toEqual(["que_1"])
    expect(out.cleared).toEqual([])
    const after = collectQuestionInbox({ question, info, state, now: 1_000 + INBOX_STALE_MS + 3 })
    expect(after[0]?.stale).toBe(false)
  })

  test("absence on a read that covers the entry clears it — an unreachable owner never wedges the inbox", async () => {
    const state = createInboxState()
    const question = storeFor({
      ses_a: [questionRequest("que_gone", "ses_a")],
      ses_other: [questionRequest("que_kept", "ses_other")],
    })
    const info = { ...infoFor("/work/proj"), ses_other: sessionInfo("ses_other", "/work/other") }
    collectQuestionInbox({ question, info, state, now: 1_000 })

    const out = await runInboxRead({
      directory: "/work/proj",
      // The owner died: its row expired engine-side and the fresh list omits it.
      read: async () => [],
      question,
      info,
      state,
      now: () => 2_000,
    })

    expect(out.kind).toBe("ok")
    expect(out.cleared).toEqual([{ sessionID: "ses_a", id: "que_gone" }])
    expect(out.refreshed).toEqual([])
    // The cleared pair removes the dead store row; the other directory's
    // entry is untouched.
    applyInboxClears(question, out.cleared)
    const entries = collectQuestionInbox({ question, info, state, now: 2_001 })
    expect(entries.map((entry) => entry.id)).toEqual(["que_kept"])
  })

  test("honest absence: a read that does not cover the entry's directory changes nothing", async () => {
    const state = createInboxState()
    const question = storeFor({ ses_other: [questionRequest("que_kept", "ses_other")] })
    const info = { ses_other: sessionInfo("ses_other", "/work/other") }
    collectQuestionInbox({ question, info, state, now: 1_000 })

    const out = await runInboxRead({
      directory: "/work/proj",
      read: async () => [],
      question,
      info,
      state,
      now: () => 2_000,
    })

    expect(out.cleared).toEqual([])
    expect(state.evidence.has("que_kept")).toBe(true)
  })

  test("recency guard: a read issued BEFORE the ask does not clear the entry it predates", async () => {
    const state = createInboxState()
    const question = storeFor({ ses_a: [questionRequest("que_new", "ses_a")] })
    const info = infoFor("/work/proj")
    collectQuestionInbox({ question, info, state, now: 5_000 })

    const out = await runInboxRead({
      directory: "/work/proj",
      read: async () => [],
      question,
      info,
      state,
      now: () => 2_000, // the read was issued before the ask arrived locally
    })

    expect(out.cleared).toEqual([])
    expect(state.evidence.has("que_new")).toBe(true)
  })

  test("a failed read is honest absence: nothing changes, the inbox stays as-is", async () => {
    const state = createInboxState()
    const question = storeFor({ ses_a: [questionRequest("que_keep", "ses_a")] })
    const info = infoFor("/work/proj")
    collectQuestionInbox({ question, info, state, now: 1_000 })

    const out = await runInboxRead({
      directory: "/work/proj",
      read: async () => {
        throw new Error("connection refused")
      },
      question,
      info,
      state,
      now: () => 2_000,
    })

    expect(out.kind).toBe("failed")
    expect(out.cleared).toEqual([])
    expect(out.refreshed).toEqual([])
    expect(state.evidence.has("que_keep")).toBe(true)
  })

  test("an unreachable owner never blocks the other directories: one failed read, one successful read", async () => {
    const state = createInboxState()
    const question = storeFor({
      ses_dead: [questionRequest("que_dead", "ses_dead")],
      ses_live: [questionRequest("que_live", "ses_live")],
    })
    const info = {
      ses_dead: sessionInfo("ses_dead", "/work/dead"),
      ses_live: sessionInfo("ses_live", "/work/live"),
    }
    collectQuestionInbox({ question, info, state, now: 1_000 })

    const dead = await runInboxRead({
      directory: "/work/dead",
      read: async () => {
        throw new Error("unreachable")
      },
      question,
      info,
      state,
      now: () => 2_000,
    })
    const live = await runInboxRead({
      directory: "/work/live",
      read: async () => [questionRequest("que_live", "ses_live")],
      question,
      info,
      state,
      now: () => 2_000,
    })

    expect(dead.kind).toBe("failed")
    expect(live.kind).toBe("ok")
    expect(live.refreshed).toEqual(["que_live"])
    const entries = collectQuestionInbox({ question, info, state, now: 2_001 })
    expect(entries.map((entry) => entry.id).sort()).toEqual(["que_dead", "que_live"])
  })

  test("a TTL-tombstoned row that the read proves alive revives; one it proves dead clears fully", async () => {
    const state = createInboxState()
    const question = storeFor({
      ses_a: [questionRequest("que_back", "ses_a")],
      ses_b: [questionRequest("que_out", "ses_b")],
    })
    const info = infoFor("/work/proj")
    collectQuestionInbox({ question, info, state, now: 1_000 })
    collectQuestionInbox({ question, info, state, now: 1_000 + INBOX_TTL_MS + 1 })
    expect(state.tombstones.has("que_back")).toBe(true)
    expect(state.tombstones.has("que_out")).toBe(true)

    const out = await runInboxRead({
      directory: "/work/proj",
      read: async () => [questionRequest("que_back", "ses_a")],
      question,
      info,
      state,
      now: () => 1_000 + INBOX_TTL_MS + 2,
    })

    expect(out.cleared).toEqual([{ sessionID: "ses_b", id: "que_out" }])
    expect(state.tombstones.has("que_back")).toBe(false)
    applyInboxClears(question, out.cleared)
    const entries = collectQuestionInbox({ question, info, state, now: 1_000 + INBOX_TTL_MS + 3 })
    expect(entries.map((entry) => entry.id)).toEqual(["que_back"])
  })
})

// ── the answer action: single-flight, idempotent settle, telemetry floor ────

describe("#1786 AC2/AC3 — answering from the inbox", () => {
  test("answering submits the reply with the session's directory and settles the local entry on success", async () => {
    const replies: { sessionID: string; requestID: string; directory: string | undefined; answers: string[][] }[] = []
    const settled: string[] = []
    let live = true
    const action = createInboxAnswerAction({
      reply: async (input) => {
        replies.push({
          sessionID: input.sessionID,
          requestID: input.requestID,
          directory: input.directory,
          answers: input.answers.map((a) => [...a]),
        })
      },
      hasQuestion: () => live,
      settle: (input) => settled.push(input.requestID),
    })

    await action.submit({
      sessionID: "ses_a",
      requestID: "que_1",
      directory: "/work/proj",
      answers: [["a"]],
    })

    expect(replies.length).toBe(1)
    expect(replies[0]).toEqual({ sessionID: "ses_a", requestID: "que_1", directory: "/work/proj", answers: [["a"]] })
    expect(settled).toEqual(["que_1"])
  })

  test("never double-submit: a retry while the reply is in flight rides the same promise", async () => {
    let calls = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const action = createInboxAnswerAction({
      reply: () => {
        calls++
        return gate
      },
      hasQuestion: () => true,
      settle: () => {},
    })

    const first = action.submit({ sessionID: "ses_a", requestID: "que_1", directory: undefined, answers: [["a"]] })
    const second = action.submit({ sessionID: "ses_a", requestID: "que_1", directory: undefined, answers: [["a"]] })
    expect(second).toBe(first)
    expect(calls).toBe(1)

    release()
    await first
    expect(calls).toBe(1)
  })

  test("a late 'already settled' reads as success: the question left the store while the reply was in flight", async () => {
    const settled: string[] = []
    let live = false
    const action = createInboxAnswerAction({
      reply: async () => {
        throw new Error("question request not found")
      },
      hasQuestion: () => live,
      settle: (input) => settled.push(input.requestID),
    })

    // The question was answered elsewhere; the settle event removed the store
    // row before this reply's failure came back. The goal state is reached.
    await action.submit({ sessionID: "ses_a", requestID: "que_1", directory: undefined, answers: [["a"]] })
    expect(settled).toEqual(["que_1"])
  })

  test("a genuine failure (the row is still live locally) rejects and does not settle", async () => {
    const settled: string[] = []
    let live = true
    const action = createInboxAnswerAction({
      reply: async () => {
        throw new Error("boom")
      },
      hasQuestion: () => live,
      settle: (input) => settled.push(input.requestID),
    })

    await expect(
      action.submit({ sessionID: "ses_a", requestID: "que_1", directory: undefined, answers: [["a"]] }),
    ).rejects.toThrow("boom")
    expect(settled).toEqual([])
  })
})

// ── AC5: the diagnostic reply captures, absorbed as the inbox's floor ────────

describe("#1786 AC5 — the absorbed reply telemetry floor (question-reply-attempt/ok/failed)", () => {
  test("a successful submit emits the attempt and ok captures", async () => {
    const bodies: string[] = []
    const action = createInboxAnswerAction({
      reply: async () => {},
      hasQuestion: () => true,
      settle: () => {},
      telemetry: (body) => bodies.push(body),
    })
    await action.submit({ sessionID: "ses_a", requestID: "que_1", directory: "/w", answers: [["a"]] })

    expect(bodies.length).toBe(2)
    const attempt = JSON.parse(bodies[0]!)
    const ok = JSON.parse(bodies[1]!)
    expect(attempt.kind).toBe("question-reply-attempt")
    expect(attempt.requestID).toBe("que_1")
    expect(attempt.sessionID).toBe("ses_a")
    expect(attempt.directory).toBe("/w")
    expect(ok.kind).toBe("question-reply-ok")
    expect(ok.requestID).toBe("que_1")
  })

  test("a failed submit emits the attempt and failed captures with the error text", async () => {
    const bodies: string[] = []
    const action = createInboxAnswerAction({
      reply: async () => {
        throw new Error("not found")
      },
      hasQuestion: () => true,
      settle: () => {},
      telemetry: (body) => bodies.push(body),
    })
    await action.submit({ sessionID: "ses_a", requestID: "que_2", directory: undefined, answers: [] }).catch(() => {})

    expect(bodies.length).toBe(2)
    const attempt = JSON.parse(bodies[0]!)
    const failed = JSON.parse(bodies[1]!)
    expect(attempt.kind).toBe("question-reply-attempt")
    expect(failed.kind).toBe("question-reply-failed")
    expect(failed.requestID).toBe("que_2")
    expect(String(failed.error)).toContain("not found")
  })

  test("an already-settled late reply emits ok (the goal state) with the settled marker", async () => {
    const bodies: string[] = []
    const action = createInboxAnswerAction({
      reply: async () => {
        throw new Error("question request not found")
      },
      hasQuestion: () => false,
      settle: () => {},
      telemetry: (body) => bodies.push(body),
    })
    await action.submit({ sessionID: "ses_a", requestID: "que_3", directory: undefined, answers: [] })

    expect(bodies.length).toBe(2)
    expect(JSON.parse(bodies[0]!).kind).toBe("question-reply-attempt")
    const ok = JSON.parse(bodies[1]!)
    expect(ok.kind).toBe("question-reply-ok")
    expect(ok.requestID).toBe("que_3")
    expect(ok.alreadySettled).toBe(true)
  })
})

// ── AC6 (app half): the end-to-end inbox path over the real store seam ──────
// The macbook headless probe owns the live end of this path; this pins the app
// half: unopened session → inbox → answered from the inbox → settled
// everywhere through the shared store.

describe("#1786 AC6 (app half) — question from an unopened session, answered from the inbox", () => {
  test("the full path: asked (unopened) → listed → answered → settled + duplicate submit is a safe no-op", async () => {
    const session = createSession()
    const state = createInboxState()
    let replyCalls = 0
    let live = true
    const hasQuestion = (sessionID: string, requestID: string) =>
      (session.data.question[sessionID] ?? []).some((row) => row.id === requestID)
    const action = createInboxAnswerAction({
      reply: async () => {
        replyCalls++
        live = false // the engine settles the row before the response lands
      },
      hasQuestion: () => live,
      settle: (input) => {
        session.set(
          "question",
          input.sessionID,
          session.data.question[input.sessionID]?.filter((row) => row.id !== input.requestID),
        )
      },
    })

    session.apply({ type: "question.asked", properties: questionRequest("que_e2e", "ses_elsewhere") })
    const entries = collectQuestionInbox({ question: session.data.question, info: session.data.info, state, now: 1 })
    expect(entries.length).toBe(1)

    await action.submit({ sessionID: "ses_elsewhere", requestID: "que_e2e", directory: undefined, answers: [["a"]] })
    expect(replyCalls).toBe(1)

    // The engine's question.replied event arrives next (the settle the whole
    // fleet sees) — and the store is already settled by the local settle hook.
    session.apply({
      type: "question.replied",
      properties: { sessionID: "ses_elsewhere", requestID: "que_e2e" },
    })
    const after = collectQuestionInbox({ question: session.data.question, info: session.data.info, state, now: 2 })
    expect(after.length).toBe(0)
  })
})

// ── the store clear helper ───────────────────────────────────────────────────

describe("applyInboxClears", () => {
  test("removes exactly the cleared rows from the store map", () => {
    const question: Record<string, QuestionRequest[]> = {
      ses_a: [questionRequest("que_1", "ses_a"), questionRequest("que_2", "ses_a")],
      ses_b: [questionRequest("que_3", "ses_b")],
    }
    const clears: InboxClear[] = [
      { sessionID: "ses_a", id: "que_1" },
      { sessionID: "ses_b", id: "que_3" },
    ]
    applyInboxClears(question, clears)
    expect(question.ses_a?.map((row) => row.id)).toEqual(["que_2"])
    expect(question.ses_b).toBeUndefined()
  })
})

// ── the per-window controller (the badge + panel's live state) ──────────────

describe("#1786 — the inbox controller", () => {
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  test("uninitialized reads degrade to an empty inbox", () => {
    expect(questionInbox().entries()).toEqual([])
    expect(questionInbox().opened()).toBe(false)
    expect(questionInbox().pending("que_x")).toBe(false)
  })

  test("derives entries from the live store and settles when the store does", async () => {
    const [question, setQuestion] = createStore<Record<string, QuestionRequest[]>>({})
    const inbox = initQuestionInbox({
      question: () => question,
      info: () => undefined,
      removeQuestion: (clears) => setQuestion(produce((draft) => applyInboxClears(draft, clears))),
      isLive: (sessionID, requestID) => (question[sessionID] ?? []).some((row) => row.id === requestID),
      listQuestions: async () => [],
      reply: async () => {},
      reconcileMs: 5,
    })

    setQuestion("ses_a", [questionRequest("que_c", "ses_a")])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inbox.entries().map((entry) => entry.id)).toEqual(["que_c"])

    // Settled anywhere (the replied event, a reconcile clear) — the store row
    // leaves and the inbox entry follows within one derivation pass.
    setQuestion("ses_a", [])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inbox.entries().length).toBe(0)
    inbox.dispose()
  })

  test("the reconcile cadence reads each involved directory and applies the clears it proves", async () => {
    const [question, setQuestion] = createStore<Record<string, QuestionRequest[]>>({})
    const readDirectories: string[] = []
    let reads = 0
    const inbox = initQuestionInbox({
      question: () => question,
      info: () => ({ ses_a: sessionInfo("ses_a", "/work/proj") }),
      removeQuestion: (clears) => setQuestion(produce((draft) => applyInboxClears(draft, clears))),
      isLive: (sessionID, requestID) => (question[sessionID] ?? []).some((row) => row.id === requestID),
      listQuestions: async (directory) => {
        readDirectories.push(directory)
        reads++
        // The first read proves the row alive; the owner dies before the next.
        return reads === 1 ? [questionRequest("que_dead", "ses_a")] : []
      },
      reply: async () => {},
      connected: () => true,
      reconcileMs: 10,
    })

    setQuestion("ses_a", [questionRequest("que_dead", "ses_a")])
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(inbox.entries().length).toBe(1)

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(readDirectories).toContain("/work/proj")
    expect(question.ses_a).toBeUndefined()
    expect(inbox.entries().length).toBe(0)
    inbox.dispose()
  })

  test("disposal resets the singleton to the empty inbox", async () => {
    const [question] = createStore<Record<string, QuestionRequest[]>>({})
    const inbox = initQuestionInbox({
      question: () => question,
      info: () => undefined,
      removeQuestion: () => {},
      isLive: () => false,
      listQuestions: async () => [],
      reply: async () => {},
      reconcileMs: 60_000,
    })
    inbox.dispose()
    expect(questionInbox().entries()).toEqual([])
    expect(questionInbox().opened()).toBe(false)
  })
})

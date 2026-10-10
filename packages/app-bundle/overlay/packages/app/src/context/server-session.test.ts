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


// 2026-10-10: the live question card never rendered even with the V1-shape
// normalizer deployed — this pins the REDUCER: a question.asked event in the
// V1 wire shape (payload in `properties`) must land in the question store.
test("question.asked (V1 wire shape) lands in the question store", () => {
  const session = createServerSession({ session: { get: async () => ({ data: undefined }) } } as unknown as OpencodeClient)
  session.apply({ type: "session.created", properties: { info: sessionInfo("root") } })
  session.apply({
    type: "question.asked",
    properties: {
      id: "que_test1",
      sessionID: sessionInfo("root").id,
      questions: [{ header: "h", question: "live?", options: [{ label: "a", description: "d" }] }],
    },
  })
  const stored = session.data.question[sessionInfo("root").id]
  expect(stored?.length).toBe(1)
  expect(stored?.[0]?.id).toBe("que_test1")
  expect(stored?.[0]?.questions?.[0]?.header).toBe("h")
  session.apply({
    type: "question.replied",
    properties: { sessionID: sessionInfo("root").id, requestID: "que_test1" },
  })
  expect(session.data.question[sessionInfo("root").id]?.length ?? 0).toBe(0)
})

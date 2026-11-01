import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import {
  isTimelineReady,
  loadOlderTimeline,
  queuedUserMessageIDs,
  selectUserMessages,
  selectVisibleUserMessages,
} from "./model-pure"

const user = (id: string) => ({ id, role: "user" }) as UserMessage
const assistant = (id: string) => ({ id, role: "assistant" }) as AssistantMessage

describe("timeline model", () => {
  test("selects users and applies the revert boundary", () => {
    const messages: Message[] = [user("msg_1"), assistant("msg_2"), user("msg_3"), user("msg_5")]
    const users = selectUserMessages(messages)

    expect(users.map((message) => message.id)).toEqual(["msg_1", "msg_3", "msg_5"])
    expect(selectVisibleUserMessages(users, "msg_5").map((message) => message.id)).toEqual(["msg_1", "msg_3"])
    expect(selectVisibleUserMessages(users)).toBe(users)
  })

  test("waits for an assistant-only load to hydrate its user root", () => {
    expect(isTimelineReady([assistant("msg_2")], true)).toBe(false)
    expect(isTimelineReady([user("msg_1"), assistant("msg_2")], true)).toBe(true)
    expect(isTimelineReady([], false)).toBe(true)
  })

  test("loads exactly one opaque cursor page", async () => {
    let calls = 0
    const anchors: Array<string | boolean> = []

    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
      before: () => anchors.push("before"),
      after: (done) => anchors.push("after", done),
    })

    expect(calls).toBe(1)
    expect(anchors).toEqual(["before", "after", true])
  })

  test("stops when a page adds no raw messages", async () => {
    let calls = 0
    await loadOlderTimeline({
      sessionID: () => "ses_test",
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        calls += 1
      },
    })

    expect(calls).toBe(1)
  })

  test("does not restore an anchor after the session changes", async () => {
    let sessionID = "ses_old"
    let restore = 0

    await loadOlderTimeline({
      sessionID: () => sessionID,
      more: () => true,
      loading: () => false,
      loadMore: async () => {
        sessionID = "ses_new"
      },
      after: () => {
        restore += 1
      },
    })

    expect(restore).toBe(0)
  })

  test("releases the anchor when loading history fails", async () => {
    let restore = 0

    await expect(
      loadOlderTimeline({
        sessionID: () => "ses_test",
        more: () => true,
        loading: () => false,
        loadMore: async () => {
          throw new Error("history failed")
        },
        after: () => {
          restore += 1
        },
      }),
    ).rejects.toThrow("history failed")

    expect(restore).toBe(1)
  })
})

// harmoniqs/amicode#1671 — a message sent while the session is running must read
// as queued (terminal parity), not as an ordinary turn.
describe("queuedUserMessageIDs", () => {
  const reply = (id: string, parentID: string, completed?: number) =>
    ({ id, role: "assistant", parentID, time: { created: 1, completed } }) as AssistantMessage

  test("a user message behind the in-flight turn is queued", () => {
    const messages: Message[] = [user("msg_1"), reply("msg_2", "msg_1"), user("msg_3")]
    expect([...queuedUserMessageIDs(messages, true)]).toEqual(["msg_3"])
  })

  test("several unanswered messages all queue, in order", () => {
    const messages: Message[] = [user("msg_1"), reply("msg_2", "msg_1"), user("msg_3"), user("msg_4")]
    expect([...queuedUserMessageIDs(messages, true)]).toEqual(["msg_3", "msg_4"])
  })

  test("the first message of a turn (nothing running ahead of it) is not queued", () => {
    expect(queuedUserMessageIDs([user("msg_1")], true).size).toBe(0)
    expect(queuedUserMessageIDs([user("msg_1"), reply("msg_2", "msg_1", 5), user("msg_3")], true).size).toBe(0)
  })

  test("a completed earlier turn does not queue the next message; a mid-tool-loop assistant does", () => {
    const loop: Message[] = [user("msg_1"), reply("msg_2", "msg_1", 5), reply("msg_3", "msg_1"), user("msg_4")]
    expect([...queuedUserMessageIDs(loop, true)]).toEqual(["msg_4"])
  })

  test("a message that already has its own reply is no longer queued", () => {
    const messages: Message[] = [user("msg_1"), reply("msg_2", "msg_1", 5), user("msg_3"), reply("msg_4", "msg_3")]
    expect(queuedUserMessageIDs(messages, true).size).toBe(0)
  })

  test("nothing is queued once the session is idle", () => {
    const messages: Message[] = [user("msg_1"), reply("msg_2", "msg_1"), user("msg_3")]
    expect(queuedUserMessageIDs(messages, false).size).toBe(0)
  })
})

import { describe, expect, mock, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { normalizeSessionMessages } from "@/utils/session-message"

mock.module("@opencode-ai/session-ui/message-part", () => ({
  renderable: () => true,
  groupParts: (refs: Array<{ messageID: string; part: { id: string } }>) =>
    refs.map((ref) => ({
      type: "part" as const,
      key: ref.part.id,
      ref: { messageID: ref.messageID, partID: ref.part.id },
    })),
}))

const { Timeline, TimelineRow } = await import("./rows")

describe("current session timeline rows", () => {
  test("derives turns and tagged rows from chronological current messages", () => {
    const source = [
      { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
      {
        id: "msg_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_3", type: "user", text: "second", time: { created: 4 } },
      {
        id: "msg_4",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", text: "working" }],
        time: { created: 5 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_3")
    // msg_4's reasoning is the busy turn's streaming tail (no time.end) — it
    // is withheld until it completes (blocks land whole), so Thinking stands
    // in as the working signal.
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "thinking:msg_1",
      "assistant-part:msg_1:msg_2:text:0",
      "thinking-meta:msg_1",
      "turn-gap:msg_3",
      "user-message:msg_3",
      "thinking:msg_3",
    ])
  })

  test("renders a current shell message as a standalone turn", () => {
    const source = [
      {
        id: "msg_shell",
        type: "shell",
        shellID: "shell_1",
        command: "pwd",
        status: "exited",
        exit: 0,
        output: { output: "/repo", cursor: 5, size: 5, truncated: false },
        time: { created: 1, completed: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.activeMessageID).toBe("msg_shell")
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_shell",
      "thinking:msg_shell",
      "assistant-part:msg_shell:msg_shell:tool",
      "thinking-meta:msg_shell",
    ])
  })

  test("keeps a projected parent missing from the source page before newer turns", () => {
    const source = [
      { id: "msg_user_1", type: "user", text: "first question", time: { created: 1 } },
      {
        id: "msg_assistant_1",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      { id: "msg_user_2", type: "user", text: "second question", time: { created: 4 } },
      {
        id: "msg_assistant_2",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "second answer" }],
        time: { created: 5, completed: 6 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source.slice(1),
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "idle",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_user_1",
      "thinking:msg_user_1",
      "assistant-part:msg_user_1:msg_assistant_1:text:0",
      "thinking-meta:msg_user_1",
      "turn-gap:msg_user_2",
      "user-message:msg_user_2",
      "thinking:msg_user_2",
      "assistant-part:msg_user_2:msg_assistant_2:text:0",
      "thinking-meta:msg_user_2",
    ])
  })

  test("renders an optimistic user turn and thinking before the protocol message arrives", () => {
    const source = [
      { id: "msg_1", type: "user", text: "existing", time: { created: 1 } },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const optimistic = {
      id: "msg_2",
      sessionID: "ses_1",
      role: "user" as const,
      time: { created: 2 },
      agent: "build",
      model: { modelID: "model", providerID: "provider" },
    }
    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) =>
        messageID === optimistic.id ? optimistic : normalized.messages.find((message) => message.id === messageID),
      () => [],
      true,
      "busy",
      true,
      [...normalized.messages.filter((message) => message.role === "user"), optimistic],
    )

    expect(result.activeMessageID).toBe(optimistic.id)
    expect(result.rows.map(TimelineRow.key)).toEqual([
      "user-message:msg_1",
      "turn-gap:msg_2",
      "user-message:msg_2",
      "thinking:msg_2",
    ])
  })

  test("removes a failed assistant error when the turn continues streaming", () => {
    const source = [
      { id: "msg_user", type: "user", text: "recover", time: { created: 1 } },
      {
        id: "msg_failed",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [],
        error: { type: "ProviderError", message: "temporary failure" },
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_recovery",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "streaming again" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((message) => [message.id, message]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (messageID) => messages.get(messageID),
      (messageID) => normalized.parts.get(messageID) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((message) => message.role === "user"),
    )

    // The stale error row must not appear once the turn resumes. The resumed
    // text is the streaming tail (no time.end) so it is withheld until it
    // completes — Thinking, not the half-streamed part, is what renders.
    expect(result.rows.map((row) => row._tag)).toEqual(["UserMessage", "Thinking"])
  })

  test("harmonic dot travels: on Thinking when no output, on last AssistantPart once output lands", () => {
    // Phase 1: turn is busy, no settled output yet — dot should be on Thinking
    const sourceNoOutput = [
      { id: "msg_u", type: "user", text: "go", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "reasoning", text: "hmm" }],
        time: { created: 2 },
      },
    ] satisfies SessionMessageInfo[]
    const norm1 = normalizeSessionMessages("ses_1", sourceNoOutput)
    const msgs1 = new Map(norm1.messages.map((m) => [m.id, m]))
    const r1 = Timeline.constructSessionMessageRows(
      sourceNoOutput,
      (id) => msgs1.get(id),
      (id) => norm1.parts.get(id) ?? [],
      true,
      "busy",
      true,
      norm1.messages.filter((m) => m.role === "user"),
    )
    const thinking1 = r1.rows.find((r) => r._tag === "Thinking")!
    expect(thinking1._tag).toBe("Thinking")
    expect((thinking1 as any).turnRunning).toBe(true)
    // No AssistantPart rows (reasoning withheld while streaming)
    expect(r1.rows.filter((r) => r._tag === "AssistantPart").length).toBe(0)

    // Phase 2: turn is busy, output HAS landed — dot should be on last AssistantPart
    const sourceWithOutput = [
      { id: "msg_u", type: "user", text: "go", time: { created: 1 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "first answer" }],
        time: { created: 2, completed: 3 },
      },
      {
        id: "msg_b",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "still going" }],
        time: { created: 4 },
      },
    ] satisfies SessionMessageInfo[]
    const norm2 = normalizeSessionMessages("ses_1", sourceWithOutput)
    const msgs2 = new Map(norm2.messages.map((m) => [m.id, m]))
    const r2 = Timeline.constructSessionMessageRows(
      sourceWithOutput,
      (id) => msgs2.get(id),
      (id) => norm2.parts.get(id) ?? [],
      true,
      "busy",
      true,
      norm2.messages.filter((m) => m.role === "user"),
    )
    const thinking2 = r2.rows.find((r) => r._tag === "Thinking")!
    // Thinking still says turnRunning (turn IS running) but output exists,
    // so the rail function knows the dot moves away from Thinking
    expect((thinking2 as any).turnRunning).toBe(true)
    const assistantParts = r2.rows.filter((r) => r._tag === "AssistantPart")
    expect(assistantParts.length).toBeGreaterThan(0)
    const lastPart = assistantParts[assistantParts.length - 1]!
    expect((lastPart as any).lastAssistantPart).toBe(true)
    expect((lastPart as any).turnRunning).toBe(true)

    // Phase 3: turn is complete — no running anywhere
    const r3 = Timeline.constructSessionMessageRows(
      sourceWithOutput.slice(0, 2), // only the completed message
      (id) => msgs2.get(id),
      (id) => norm2.parts.get(id) ?? [],
      true,
      "idle",
      true,
      norm2.messages.filter((m) => m.role === "user"),
    )
    const thinking3 = r3.rows.find((r) => r._tag === "Thinking")!
    expect((thinking3 as any).turnRunning).toBe(false)
    const parts3 = r3.rows.filter((r) => r._tag === "AssistantPart")
    for (const p of parts3) {
      expect((p as any).turnRunning).toBe(false)
    }
  })

  test("turnStartedAt is threaded through Thinking and AssistantPart rows from user message time.created", () => {
    const source = [
      { id: "msg_u", type: "user", text: "go", time: { created: 1000 } },
      {
        id: "msg_a",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "output" }],
        time: { created: 1050, completed: 1200 },
      },
      {
        id: "msg_b",
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        content: [{ type: "text", text: "more" }],
        time: { created: 1300 },
      },
    ] satisfies SessionMessageInfo[]
    const normalized = normalizeSessionMessages("ses_1", source)
    const messages = new Map(normalized.messages.map((m) => [m.id, m]))

    const result = Timeline.constructSessionMessageRows(
      source,
      (id) => messages.get(id),
      (id) => normalized.parts.get(id) ?? [],
      true,
      "busy",
      true,
      normalized.messages.filter((m) => m.role === "user"),
    )

    // Thinking row carries the user message's time.created as turnStartedAt
    const thinking = result.rows.find((r) => r._tag === "Thinking")!
    expect((thinking as any).turnStartedAt).toBe(1000)

    // AssistantPart rows carry it too (for dot tooltip on last part)
    const assistantParts = result.rows.filter((r) => r._tag === "AssistantPart")
    for (const part of assistantParts) {
      expect((part as any).turnStartedAt).toBe(1000)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { serializeSession } from "./serialize-session"
import type { Message, Part } from "@opencode-ai/sdk/v2"

function userMsg(id: string): Message {
  return {
    id,
    sessionID: "s1",
    role: "user",
    time: { created: 1 },
    agent: "default",
    model: { providerID: "test", modelID: "test" },
  }
}

function assistantMsg(id: string): Message {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    time: { created: 2 },
    parentID: "m1",
    modelID: "test",
    providerID: "test",
    mode: "default",
    agent: "default",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function textPart(messageID: string, text: string, opts?: { ignored?: boolean; synthetic?: boolean }): Part {
  return {
    id: `p-${messageID}-${Math.random().toString(36).slice(2, 6)}`,
    sessionID: "s1",
    messageID,
    type: "text",
    text,
    ignored: opts?.ignored,
    synthetic: opts?.synthetic,
  }
}

function toolPart(messageID: string): Part {
  return {
    id: `t-${messageID}`,
    sessionID: "s1",
    messageID,
    type: "tool",
    callID: "call1",
    tool: "bash",
    state: {
      status: "completed",
      input: {},
      output: "done",
      title: "bash",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

describe("serializeSession", () => {
  test("formats a simple user + assistant exchange", () => {
    const messages: Message[] = [userMsg("m1"), assistantMsg("m2")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "How do I list files?")],
      m2: [textPart("m2", "Use `ls` to list files in the current directory.")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe(
      "User:\nHow do I list files?\n\nAssistant:\nUse `ls` to list files in the current directory.",
    )
  })

  test("concatenates multiple text parts within a single message", () => {
    const messages: Message[] = [assistantMsg("m1")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "First chunk. "), textPart("m1", "Second chunk.")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("Assistant:\nFirst chunk. Second chunk.")
  })

  test("skips messages with no text parts", () => {
    const messages: Message[] = [userMsg("m1"), assistantMsg("m2"), assistantMsg("m3")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "hello")],
      m2: [toolPart("m2")], // only a tool call, no text
      m3: [textPart("m3", "done")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("User:\nhello\n\nAssistant:\ndone")
  })

  test("skips ignored and synthetic text parts", () => {
    const messages: Message[] = [assistantMsg("m1")]
    const parts: Record<string, Part[]> = {
      m1: [
        textPart("m1", "visible"),
        textPart("m1", " ignored", { ignored: true }),
        textPart("m1", " synthetic", { synthetic: true }),
      ],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("Assistant:\nvisible")
  })

  test("skips messages where all text is whitespace", () => {
    const messages: Message[] = [userMsg("m1"), assistantMsg("m2")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "   \n  ")],
      m2: [textPart("m2", "actual content")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("Assistant:\nactual content")
  })

  test("returns empty string for an empty session", () => {
    const result = serializeSession([], () => [])
    expect(result).toBe("")
  })

  test("trims trailing whitespace from message text", () => {
    const messages: Message[] = [userMsg("m1")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "hello world   \n\n")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("User:\nhello world")
  })

  test("handles a multi-turn conversation", () => {
    const messages: Message[] = [userMsg("m1"), assistantMsg("m2"), userMsg("m3"), assistantMsg("m4")]
    const parts: Record<string, Part[]> = {
      m1: [textPart("m1", "What is 2+2?")],
      m2: [textPart("m2", "4")],
      m3: [textPart("m3", "And 3+3?")],
      m4: [textPart("m4", "6")],
    }

    const result = serializeSession(messages, (id) => parts[id] ?? [])

    expect(result).toBe("User:\nWhat is 2+2?\n\nAssistant:\n4\n\nUser:\nAnd 3+3?\n\nAssistant:\n6")
  })
})

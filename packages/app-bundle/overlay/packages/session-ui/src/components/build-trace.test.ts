import { describe, expect, test } from "bun:test"
import { buildTrace, buildSessionTrace } from "./build-trace"
import type { AssistantMessage, Message, Part as PartType, UserMessage } from "@opencode-ai/sdk/v2"

function msg(id: string): AssistantMessage {
  return {
    id,
    sessionID: "s1",
    role: "assistant",
    providerID: "p1",
    modelID: "m1",
    time: { created: 1000, completed: 2000 },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as AssistantMessage
}

function textPart(id: string, text: string): PartType {
  return { id, sessionID: "s1", messageID: "msg1", type: "text", text } as PartType
}

function bashPart(id: string, command: string, output: string): PartType {
  return {
    id,
    sessionID: "s1",
    messageID: "msg1",
    type: "tool",
    callID: id,
    tool: "bash",
    state: { status: "completed", input: { command }, output, title: "", metadata: {}, time: { start: 0, end: 1 } },
  } as PartType
}

function toolPart(id: string, tool: string, output: string): PartType {
  return {
    id,
    sessionID: "s1",
    messageID: "msg1",
    type: "tool",
    callID: id,
    tool,
    state: { status: "completed", input: {}, output, title: "", metadata: {}, time: { start: 0, end: 1 } },
  } as PartType
}

function errorPart(id: string, tool: string, error: string): PartType {
  return {
    id,
    sessionID: "s1",
    messageID: "msg1",
    type: "tool",
    callID: id,
    tool,
    state: { status: "error", input: {}, error, time: { start: 0, end: 1 } },
  } as PartType
}

function skipPart(id: string, tool: string): PartType {
  return {
    id,
    sessionID: "s1",
    messageID: "msg1",
    type: "tool",
    callID: id,
    tool,
    state: { status: "completed", input: {}, output: "some output", title: "", metadata: {}, time: { start: 0, end: 1 } },
  } as PartType
}

function userMsg(id: string): UserMessage {
  return {
    id,
    sessionID: "s1",
    role: "user",
    time: { created: 1000 },
    agent: "default",
    model: { providerID: "p1", modelID: "m1" },
  } as UserMessage
}

describe("buildTrace", () => {
  test("concatenates text parts from a single message", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "Hello world"), textPart("p2", "Second paragraph")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("Hello world\n\nSecond paragraph")
  })

  test("includes bash command and output", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "Running a command"), bashPart("p2", "echo hello", "hello")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("Running a command\n\n$ echo hello\nhello")
  })

  test("includes non-exploration tool output", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [toolPart("p1", "edit", "File edited successfully")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("[edit] File edited successfully")
  })

  test("includes error tool output", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [errorPart("p1", "bash", "command not found")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("[bash] Error: command not found")
  })

  test("skips exploration tools (read, glob, grep, list)", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [
        textPart("p1", "Looking at files"),
        skipPart("p2", "read"),
        skipPart("p3", "glob"),
        skipPart("p4", "grep"),
        skipPart("p5", "list"),
        textPart("p6", "Found what I needed"),
      ],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("Looking at files\n\nFound what I needed")
  })

  test("skips reasoning and other non-content parts", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [
        { id: "r1", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "thinking..." } as PartType,
        textPart("p1", "The answer is 42"),
      ],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("The answer is 42")
  })

  test("handles multiple messages in a turn", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "First message")],
      msg2: [textPart("p2", "Second message"), bashPart("p3", "ls", "file.txt")],
    }
    const result = buildTrace([msg("msg1"), msg("msg2")], (id) => parts[id] ?? [])
    expect(result).toBe("First message\n\nSecond message\n\n$ ls\nfile.txt")
  })

  test("trims whitespace from text and output", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "  spaced  "), bashPart("p2", "echo x", "  output  ")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("spaced\n\n$ echo x\noutput")
  })

  test("returns empty string for empty messages", () => {
    const result = buildTrace([], () => [])
    expect(result).toBe("")
  })

  test("bash part with no command still includes output", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [bashPart("p1", "", "some output")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("some output")
  })

  test("prepends user text with You: prefix when provided", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "The answer is 42")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [], "What is the meaning of life?")
    expect(result).toBe("You: What is the meaning of life?\n\nThe answer is 42")
  })

  test("no user prefix for empty userText", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "The answer")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [], "")
    expect(result).toBe("The answer")
  })

  test("no user prefix for whitespace-only userText", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "The answer")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [], "   ")
    expect(result).toBe("The answer")
  })

  test("no user prefix when userText is undefined", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "The answer")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [], undefined)
    expect(result).toBe("The answer")
  })

  test("user text with only assistant trace (backward compatible)", () => {
    const parts: Record<string, PartType[]> = {
      msg1: [textPart("p1", "Hello"), bashPart("p2", "ls", "file.txt")],
    }
    const result = buildTrace([msg("msg1")], (id) => parts[id] ?? [])
    expect(result).toBe("Hello\n\n$ ls\nfile.txt")
  })
})

describe("buildSessionTrace", () => {
  test("single turn with user and assistant", () => {
    const messages: Message[] = [userMsg("u1"), msg("a1")]
    const parts: Record<string, PartType[]> = {
      u1: [textPart("p0", "Hello")],
      a1: [textPart("p1", "Hi there")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("You: Hello\n\nHi there")
  })

  test("multiple turns in order", () => {
    const messages: Message[] = [userMsg("u1"), msg("a1"), userMsg("u2"), msg("a2")]
    const parts: Record<string, PartType[]> = {
      u1: [textPart("p0", "First question")],
      a1: [textPart("p1", "First answer")],
      u2: [textPart("p2", "Second question")],
      a2: [textPart("p3", "Second answer")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("You: First question\n\nFirst answer\n\nYou: Second question\n\nSecond answer")
  })

  test("returns empty string for no messages", () => {
    const result = buildSessionTrace([], () => [])
    expect(result).toBe("")
  })

  test("user message with no assistant response", () => {
    const messages: Message[] = [userMsg("u1"), userMsg("u2"), msg("a1")]
    const parts: Record<string, PartType[]> = {
      u1: [textPart("p0", "First")],
      u2: [textPart("p1", "Second")],
      a1: [textPart("p2", "Response")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("You: First\n\nYou: Second\n\nResponse")
  })

  test("user message with no text part produces no prefix", () => {
    const messages: Message[] = [userMsg("u1"), msg("a1")]
    const parts: Record<string, PartType[]> = {
      u1: [],
      a1: [textPart("p1", "Response")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("Response")
  })

  test("skips synthetic user text parts", () => {
    const syntheticPart = {
      id: "p0",
      sessionID: "s1",
      messageID: "u1",
      type: "text",
      text: "system prompt",
      synthetic: true,
    } as PartType
    const messages: Message[] = [userMsg("u1"), msg("a1")]
    const parts: Record<string, PartType[]> = {
      u1: [syntheticPart],
      a1: [textPart("p1", "Response")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("Response")
  })

  test("turn with multiple assistant messages", () => {
    const messages: Message[] = [userMsg("u1"), msg("a1"), msg("a2")]
    const parts: Record<string, PartType[]> = {
      u1: [textPart("p0", "Run something")],
      a1: [textPart("p1", "Running"), bashPart("p2", "echo hi", "hi")],
      a2: [textPart("p3", "Done")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("You: Run something\n\nRunning\n\n$ echo hi\nhi\n\nDone")
  })

  test("session with no assistant messages at all", () => {
    const messages: Message[] = [userMsg("u1")]
    const parts: Record<string, PartType[]> = {
      u1: [textPart("p0", "Hello?")],
    }
    const result = buildSessionTrace(messages, (id) => parts[id] ?? [])
    expect(result).toBe("You: Hello?")
  })
})

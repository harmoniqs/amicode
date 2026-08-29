import { describe, expect, test } from "bun:test"
import { buildTrace } from "./build-trace"
import type { AssistantMessage, Part as PartType } from "@opencode-ai/sdk/v2"

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
})

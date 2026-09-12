import { describe, expect, test } from "bun:test"
import type { Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"

/**
 * Mirrors the logic inside MessageTimeline's `visiblePromptBubble` memo (amicode#271).
 *
 * Uses the viewport's startIndex: a user message is "above the viewport" when
 * its row index is less than startIndex. The memo is triggered by scrollTop
 * (a signal), and reads virtualizer.range.startIndex for the actual check.
 */
function findVisiblePromptBubble(
  userMessages: UserMessage[],
  partsFor: (id: string) => Part[],
  rowIndexFor: (id: string) => number | undefined,
  viewportStartIndex: number | undefined,
): { text: string; messageId: string } | undefined {
   if (viewportStartIndex === undefined) return undefined
  for (let i = userMessages.length - 1; i >= 0; i--) {
    const msg = userMessages[i]
    const rowIndex = rowIndexFor(msg.id)
    if (rowIndex === undefined) continue
    if (rowIndex < viewportStartIndex) {
      const parts = partsFor(msg.id)
      const textPart = parts.find(
        (p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic,
      )
      const text = textPart?.text?.trim()
      if (text) return { text, messageId: msg.id }
      // No text in this message (e.g. skill-only) — keep looking
      continue
    }
  }
  return undefined
}

const userMsg = (id: string) => ({ id, role: "user" }) as UserMessage

const textPart = (text: string, synthetic = false): TextPart =>
  ({
    id: `prt_${text.slice(0, 4)}`,
    sessionID: "ses_1",
    messageID: "msg_1",
    type: "text",
    text,
    synthetic,
  }) as TextPart

describe("last-prompt bubble", () => {
  test("shows the most recent user message above the viewport start", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("first prompt")],
      msg_2: [textPart("second prompt")],
      msg_3: [textPart("third prompt")],
    }
    const rowIndices: Record<string, number> = { msg_1: 0, msg_2: 5, msg_3: 10 }

    // Viewport starts at row 7 → msg_1 (row 0) and msg_2 (row 5) are above
    // Most recent above viewport = msg_2
    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      7,
    )
    expect(result).toEqual({ text: "second prompt", messageId: "msg_2" })
  })

  test("shows last message when viewport is past all messages", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("first")],
      msg_2: [textPart("second")],
    }
    const rowIndices: Record<string, number> = { msg_1: 0, msg_2: 3 }

    // Viewport starts at row 20 → both messages above
    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      20,
    )
    expect(result).toEqual({ text: "second", messageId: "msg_2" })
  })

  test("returns undefined when all messages are still visible", () => {
    const messages = [userMsg("msg_1")]
    const parts: Record<string, Part[]> = { msg_1: [textPart("prompt")] }
    const rowIndices: Record<string, number> = { msg_1: 5 }

    // Viewport starts at row 0 → message at row 5 is still in/below view
    expect(
      findVisiblePromptBubble(messages, (id) => parts[id] ?? [], (id) => rowIndices[id], 0),
    ).toBeUndefined()
  })

  test("returns undefined when range is undefined (not mounted)", () => {
    const messages = [userMsg("msg_1")]
    expect(
      findVisiblePromptBubble(messages, () => [], () => 0, undefined),
    ).toBeUndefined()
  })

  test("returns undefined for empty messages", () => {
    expect(
      findVisiblePromptBubble([], () => [], () => undefined, 10),
    ).toBeUndefined()
  })

  test("skips synthetic text parts", () => {
    const messages = [userMsg("msg_1")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("synthetic content", true), textPart("real prompt")],
    }
    const rowIndices: Record<string, number> = { msg_1: 0 }

    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      5,
    )
    expect(result).toEqual({ text: "real prompt", messageId: "msg_1" })
  })

  test("trims whitespace from extracted text", () => {
    const messages = [userMsg("msg_1")]
    const parts: Record<string, Part[]> = { msg_1: [textPart("  padded text  ")] }
    const rowIndices: Record<string, number> = { msg_1: 0 }

    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      5,
    )
    expect(result?.text).toBe("padded text")
  })

  test("updates as viewport scrolls past different messages", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("alpha")],
      msg_2: [textPart("beta")],
      msg_3: [textPart("gamma")],
    }
    const rowIndices: Record<string, number> = { msg_1: 0, msg_2: 10, msg_3: 20 }
    const lookup = (id: string) => parts[id] ?? []
    const rowLookup = (id: string) => rowIndices[id]

    // Scrolled just past msg_1
    expect(findVisiblePromptBubble(messages, lookup, rowLookup, 3)?.text).toBe("alpha")
    // Scrolled past msg_2
    expect(findVisiblePromptBubble(messages, lookup, rowLookup, 15)?.text).toBe("beta")
    // Scrolled past msg_3
    expect(findVisiblePromptBubble(messages, lookup, rowLookup, 25)?.text).toBe("gamma")
  })

  test("streaming case: message goes above viewport as content grows", () => {
    // The agent is streaming. Auto-scroll keeps the viewport at the bottom.
    // The user's message started visible but is now above the viewport.
    const messages = [userMsg("msg_1")]
    const parts: Record<string, Part[]> = { msg_1: [textPart("fix the bug in auth.ts")] }
    const rowIndices: Record<string, number> = { msg_1: 0 }

    // Initially: viewport starts at row 0 → message at row 0 is NOT above
    expect(
      findVisiblePromptBubble(messages, (id) => parts[id] ?? [], (id) => rowIndices[id], 0),
    ).toBeUndefined()

    // After streaming: viewport has moved to row 5 → message at row 0 IS above
    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      5,
    )
    expect(result).toEqual({ text: "fix the bug in auth.ts", messageId: "msg_1" })
  })

  test("existing session opened at bottom: message far above viewport shows bubble", () => {
    // Key case: open a long existing session anchored at the bottom.
    // User message is at row 2, viewport starts at row 400.
    const messages = [userMsg("msg_1"), userMsg("msg_2")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("initial question")],
      msg_2: [textPart("follow-up question")],
    }
    const rowIndices: Record<string, number> = { msg_1: 2, msg_2: 200 }

    // Viewport at row 400 → both messages above
    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      400,
    )
    expect(result).toEqual({ text: "follow-up question", messageId: "msg_2" })
  })

  test("skips skill-only messages and shows the previous message with text", () => {
    // User sent a real message, then a skill-only command (e.g. /tdd).
    // The bubble should show the real message, not disappear.
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("implement the auth flow")],
      msg_2: [textPart("add some tests for it")],
      // msg_3 is a skill invocation — has a skill part but no meaningful text
      msg_3: [{ id: "prt_skill", sessionID: "ses_1", messageID: "msg_3", type: "skill", name: "tdd" } as unknown as Part],
    }
    const rowIndices: Record<string, number> = { msg_1: 0, msg_2: 8, msg_3: 16 }

    // Viewport at row 20 → all messages above. msg_3 has no text, so falls through to msg_2
    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      20,
    )
    expect(result).toEqual({ text: "add some tests for it", messageId: "msg_2" })
  })

  test("skips multiple consecutive skill-only messages", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("the real question")],
      msg_2: [], // empty parts
      msg_3: [], // empty parts
    }
    const rowIndices: Record<string, number> = { msg_1: 0, msg_2: 5, msg_3: 10 }

    const result = findVisiblePromptBubble(
      messages,
      (id) => parts[id] ?? [],
      (id) => rowIndices[id],
      15,
    )
    expect(result).toEqual({ text: "the real question", messageId: "msg_1" })
  })
})

/**
 * Mirrors the `findPreviousBubble` logic: when the user clicks the bubble
 * showing message N, find message N-1 (the previous user message with text).
 */
function findPreviousBubble(
  currentMessageId: string,
  userMessages: UserMessage[],
  partsFor: (id: string) => Part[],
): { text: string; messageId: string } | undefined {
  const currentIdx = userMessages.findIndex((m) => m.id === currentMessageId)
  if (currentIdx <= 0) return undefined
  for (let i = currentIdx - 1; i >= 0; i--) {
    const msg = userMessages[i]
    const parts = partsFor(msg.id)
    const textPart = parts.find(
      (p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic,
    )
    const text = textPart?.text?.trim()
    if (text) return { text, messageId: msg.id }
  }
  return undefined
}

describe("click-to-previous (bubble override on click)", () => {
  test("clicking bubble showing msg_2 switches to msg_1", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("first question")],
      msg_2: [textPart("second question")],
      msg_3: [textPart("third question")],
    }

    const result = findPreviousBubble("msg_3", messages, (id) => parts[id] ?? [])
    expect(result).toEqual({ text: "second question", messageId: "msg_2" })
  })

  test("clicking bubble showing the first message returns undefined (hides bubble)", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("only message")],
      msg_2: [textPart("second")],
    }

    const result = findPreviousBubble("msg_1", messages, (id) => parts[id] ?? [])
    expect(result).toBeUndefined()
  })

  test("skips skill-only messages when finding previous", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [textPart("real question")],
      msg_2: [], // skill-only, no text
      msg_3: [textPart("latest question")],
    }

    // Clicking msg_3 should skip msg_2 (no text) and land on msg_1
    const result = findPreviousBubble("msg_3", messages, (id) => parts[id] ?? [])
    expect(result).toEqual({ text: "real question", messageId: "msg_1" })
  })

  test("returns undefined when all previous messages are skill-only", () => {
    const messages = [userMsg("msg_1"), userMsg("msg_2"), userMsg("msg_3")]
    const parts: Record<string, Part[]> = {
      msg_1: [], // no text
      msg_2: [], // no text
      msg_3: [textPart("latest")],
    }

    const result = findPreviousBubble("msg_3", messages, (id) => parts[id] ?? [])
    expect(result).toBeUndefined()
  })
})

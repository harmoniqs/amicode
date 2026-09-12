// Serialize a session's messages and parts into human-readable markdown text.
// Used by the clipboard "copy full session" flow — the data-model path that
// doesn't depend on DOM selection or virtualized rendering.

import type { Message, Part } from "@opencode-ai/sdk/v2"

export type PartsAccessor = (messageID: string) => readonly Part[]

/**
 * Serialize a session into markdown-formatted text with role labels.
 *
 * Format:
 *   User:
 *   <user text>
 *
 *   Assistant:
 *   <assistant text>
 *
 * Only text parts are included — tool calls, reasoning, step markers, and
 * other structural parts are omitted for readability.
 */
export function serializeSession(messages: readonly Message[], getParts: PartsAccessor): string {
  const blocks: string[] = []

  for (const msg of messages) {
    const textParts = getParts(msg.id).filter((p) => p.type === "text" && !p.ignored && !p.synthetic)
    if (textParts.length === 0) continue

    const role = msg.role === "user" ? "User" : "Assistant"
    const text = textParts.map((p) => (p as { text: string }).text).join("")
    if (!text.trim()) continue

    blocks.push(`${role}:\n${text.trimEnd()}`)
  }

  return blocks.join("\n\n")
}

import type { AssistantMessage, Message, Part as PartType, TextPart } from "@opencode-ai/sdk/v2"

// Skipped tool types when building the copy-trace content — these are internal
// bookkeeping or exploration noise, not user-facing output.
const TRACE_SKIP_TOOLS = new Set(["read", "glob", "grep", "list"])

/**
 * Build a copyable trace string from an assistant turn's messages and parts.
 * Concatenates text parts with tool command+output, skipping exploration noise.
 *
 * When `userText` is provided and non-empty, prepends `You: <userText>` before
 * the assistant trace, separated by a blank line.
 */
export function buildTrace(
  messages: AssistantMessage[],
  getParts: (messageID: string) => PartType[],
  userText?: string,
): string {
  const segments: string[] = []

  const trimmedUser = userText?.trim()
  if (trimmedUser) segments.push(`You: ${trimmedUser}`)

  for (const message of messages) {
    for (const part of getParts(message.id)) {
      if (!part) continue
      if (part.type === "text") {
        const text = part.text?.trim()
        if (text) segments.push(text)
      } else if (part.type === "tool") {
        if (TRACE_SKIP_TOOLS.has(part.tool)) continue
        if (part.state.status === "completed") {
          const input = part.state.input ?? {}
          const output = part.state.output?.trim() ?? ""
          if (part.tool === "bash" || part.tool === "shell") {
            const cmd = typeof input.command === "string" ? input.command : ""
            segments.push(cmd ? `$ ${cmd}\n${output}` : output)
          } else if (output) {
            segments.push(`[${part.tool}] ${output}`)
          }
        } else if (part.state.status === "error") {
          segments.push(`[${part.tool}] Error: ${part.state.error}`)
        }
      }
    }
  }

  return segments.join("\n\n")
}

/** Extract the user-typed text from a user message's parts (first non-synthetic text). */
function extractUserText(parts: PartType[]): string | undefined {
  const textPart = parts.find(
    (p): p is TextPart => p.type === "text" && !(p as TextPart).synthetic,
  )
  return textPart?.text?.trim() || undefined
}

/**
 * Build a full session trace from all messages in order.
 * Groups messages into turns (user → assistant*) and concatenates each turn's
 * trace with `You: <input>` prefixes, separated by blank lines.
 */
export function buildSessionTrace(
  messages: Message[],
  getParts: (messageID: string) => PartType[],
): string {
  const turns: string[] = []

  let i = 0
  while (i < messages.length) {
    const message = messages[i]
    if (message.role === "user") {
      const userText = extractUserText(getParts(message.id))
      // Collect all subsequent assistant messages for this turn
      const assistantMsgs: AssistantMessage[] = []
      i++
      while (i < messages.length && messages[i].role === "assistant") {
        assistantMsgs.push(messages[i] as AssistantMessage)
        i++
      }
      const turnTrace = buildTrace(assistantMsgs, getParts, userText)
      if (turnTrace) turns.push(turnTrace)
    } else {
      // Orphan assistant message without a preceding user message
      const assistantMsgs: AssistantMessage[] = []
      while (i < messages.length && messages[i].role === "assistant") {
        assistantMsgs.push(messages[i] as AssistantMessage)
        i++
      }
      const turnTrace = buildTrace(assistantMsgs, getParts)
      if (turnTrace) turns.push(turnTrace)
    }
  }

  return turns.join("\n\n")
}

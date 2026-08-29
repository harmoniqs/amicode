import type { AssistantMessage, Part as PartType } from "@opencode-ai/sdk/v2"

// Skipped tool types when building the copy-trace content — these are internal
// bookkeeping or exploration noise, not user-facing output.
const TRACE_SKIP_TOOLS = new Set(["read", "glob", "grep", "list"])

/**
 * Build a copyable trace string from an assistant turn's messages and parts.
 * Concatenates text parts with tool command+output, skipping exploration noise.
 */
export function buildTrace(
  messages: AssistantMessage[],
  getParts: (messageID: string) => PartType[],
): string {
  const segments: string[] = []

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

// Pure task-session matching helpers, extracted from message-part.tsx for
// testability (same pattern as message-part-text.ts / message-part-groups.ts).
// JSX-free, no DOM imports.

/** Find the best matching child session for a Task tool-call display. */
export function findTaskSession(
  sessions: readonly { id: string; parentID?: string; title: string; time: { created?: number; archived?: number } }[],
  parentID: string,
  description: string,
  agentName: string,
): string | undefined {
  return sessions
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title?.startsWith(description) : true))
    .filter((session) => (agentName ? session.title?.includes(`@${agentName}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

/** Check whether a part-like object is an amicode_* tool call. */
export function isAmicodeToolCall(part: { type?: string; tool?: unknown } | undefined | null): boolean {
  if (!part || part.type !== "tool") return false
  return typeof part.tool === "string" && part.tool.startsWith("amicode_")
}

// Pure tool-status settling, extracted from message-part.tsx for testability
// (same pattern as message-part-task.ts). JSX-free, no DOM imports.

type MessageLike = { role?: string; time?: object } | undefined

/**
 * harmoniqs/amicode#1427 — an assistant message that has completed (including a
 * cancel/Esc finalize) cannot own a live tool call. If its tool part still reads
 * pending/running (the part's terminal update was missed or never written), the
 * spinner would run forever — notably the subagent (task) card after Esc. Resolve
 * such a part to "error" (stopped); every other status passes through untouched.
 */
export function settledToolStatus(status: string, message: MessageLike): string {
  if (status !== "pending" && status !== "running") return status
  if (message?.role !== "assistant") return status
  return typeof (message.time as { completed?: number } | undefined)?.completed === "number" ? "error" : status
}

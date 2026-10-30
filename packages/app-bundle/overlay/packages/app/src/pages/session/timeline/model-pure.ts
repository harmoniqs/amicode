import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk/v2"
import type { Accessor } from "solid-js"

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

/**
 * harmoniqs/amicode#1671 — ids of user messages that were sent while a turn is
 * still running and have not started yet (terminal parity: they read as queued).
 *
 * The "current" turn is the first user message whose turn is unfinished — no
 * assistant reply yet, or its last reply still incomplete. Every LATER user
 * message that has no reply of its own is queued. Idle sessions queue nothing
 * (a stale unanswered message is not "queued"), and the current turn itself is
 * never queued — a lone message about to run is just a running turn.
 */
export function queuedUserMessageIDs(messages: Message[], working: boolean): Set<string> {
  const queued = new Set<string>()
  if (!working) return queued

  const replies = new Map<string, AssistantMessage>()
  for (const message of messages) {
    if (message.role === "assistant" && message.parentID) replies.set(message.parentID, message)
  }

  let ahead = false
  for (const message of messages) {
    if (message.role !== "user") continue
    const last = replies.get(message.id)
    if (!last) {
      if (ahead) queued.add(message.id)
      ahead = true
      continue
    }
    if (typeof last.time?.completed !== "number") ahead = true
  }
  return queued
}

export function isTimelineReady(messages: Message[] | undefined, loading: boolean) {
  return messages !== undefined && (messages.some((message) => message.role === "user") || !loading)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  return messages.filter((message) => message.id < revertMessageID)
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  await input.loadMore(id).catch((error) => {
    if (input.sessionID() === id) input.after?.(true)
    throw error
  })
  if (input.sessionID() !== id) return
  input.after?.(true)
}

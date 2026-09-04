import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import type { SessionMessageInfo } from "@opencode-ai/client/promise"
import { AssistantMessage, Part, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { groupParts, renderable, type PartGroup } from "@opencode-ai/session-ui/message-part"
import { TimelineRow, type SummaryDiff } from "./timeline-row"
// import { uniqueSummaryDiffs } from "./summary-diffs"  // suppressed (harmoniqs/amicode#733)

export { TimelineRow, type SummaryDiff } from "./timeline-row"

export type TimelineRowMap = {
  TurnGap: { userMessageID: string }
  CommentStrip: {
    userMessageID: string
  }
  UserMessage: {
    userMessageID: string
    anchor: boolean
  }
  TurnDivider: {
    userMessageID: string
    label: "compaction" | "interrupted"
  }
  AssistantPart: {
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    lastAssistantPart: boolean
    turnRunning: boolean
    railLabel?: string
  }
  Thinking: { userMessageID: string; reasoningHeading?: string }
  Retry: { userMessageID: string }
  DiffSummary: { userMessageID: string; diffs: SummaryDiff[] }
  Error: { userMessageID: string; text: string }
}

export namespace Timeline {
  export function constructSessionMessageRows(
    messages: SessionMessageInfo[],
    getMessage: (messageID: string) => UserMessage | AssistantMessage | undefined,
    getMessageParts: (messageID: string) => Part[],
    showReasoning: boolean,
    status: SessionStatus["type"],
    inlineComments: boolean,
    projectedUserMessages: UserMessage[],
    // the streaming prose tail has at least one settled chunk (computed by the
    // timeline from the delta-accumulated text, which rows cannot see)
    tailProseSettled = false,
  ) {
    const turns: { user: UserMessage; assistants: AssistantMessage[] }[] = []
    const turnByUserID = new Map<string, (typeof turns)[number]>()
    messages.forEach((message) => {
      const projected = getMessage(message.id)
      if (message.type === "shell" && projected?.role === "user") {
        const assistant = getMessage(`${message.id}:assistant`)
        const turn = { user: projected, assistants: assistant?.role === "assistant" ? [assistant] : [] }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        return
      }
      if (projected?.role === "user") {
        if (turnByUserID.has(projected.id)) return
        const turn = { user: projected, assistants: [] }
        turns.push(turn)
        turnByUserID.set(projected.id, turn)
        return
      }
      if (projected?.role !== "assistant") return
      const existing = turnByUserID.get(projected.parentID)
      if (existing) {
        existing.assistants.push(projected)
        return
      }
      const user = getMessage(projected.parentID)
      if (user?.role !== "user") return
      const turn = { user, assistants: [projected] }
      turns.push(turn)
      turnByUserID.set(user.id, turn)
    })
    const latestUserMessageID = turns.at(-1)?.user.id
    projectedUserMessages.forEach((user) => {
      if (turnByUserID.has(user.id)) return
      if (latestUserMessageID && user.id < latestUserMessageID) return
      const turn = { user, assistants: [] }
      turns.push(turn)
      turnByUserID.set(user.id, turn)
    })
    const activeMessageID = turns.at(-1)?.user.id
    return {
      activeMessageID,
      rows: turns.flatMap((turn, index) =>
        constructMessageRows(
          turn.user,
          getMessageParts,
          turn.assistants,
          index,
          showReasoning,
          status,
          turn.user.id === activeMessageID,
          inlineComments,
          tailProseSettled,
        ),
      ),
    }
  }

  export function constructMessageRows(
    userMessage: UserMessage,
    getMessageParts: (messageID: string) => Part[],
    assistantMessages: AssistantMessage[],
    index: number,
    showReasoning: boolean,
    status: SessionStatus["type"],
    isActive: boolean,
    // v2 renders comments inside the user message attachments row instead of a strip row
    inlineComments: boolean,
    tailProseSettled = false,
  ) {
    const rows: TimelineRow.TimelineRow[] = []

    const previousUserMessage = index > 0
    const userParts = getMessageParts(userMessage.id)
    const comments = userParts.flatMap((p) => MessageComment.fromPart(p) ?? [])
    const compaction = userParts.some((p) => p.type === "compaction")
    const interruptedMessageIndex = assistantMessages.findIndex((m) => m.error?.name === "MessageAbortedError")
    const interrupted = interruptedMessageIndex !== -1
    const latestError = assistantMessages.at(-1)?.error
    const error = latestError?.name === "MessageAbortedError" ? undefined : latestError

    const assistantPartRefs = assistantMessages.flatMap((message, messageIndex) =>
      getMessageParts(message.id)
        .filter((part) => renderable(part, showReasoning))
        .map((part) => ({ messageID: message.id, messageIndex, part })),
    )
    // Steps land as FULL blocks (Kate 2026-08-24: no typing reveal — the site
    // demo's grammar). A streaming prose tail reveals in CHUNKS (Kate
    // 2026-08-25: no waiting for the whole reply either): its row joins the
    // timeline as soon as the FIRST chunk settles (tailProseSettled, computed
    // by the timeline from the delta-accumulated text) and the renderer shows
    // settled chunks only. Before that first chunk — and for streaming
    // reasoning, which keeps whole-block withholding — the row is withheld
    // and Thinking is the working signal. A part with a successor is complete
    // by definition, so only the tail can ever be withheld, and a done turn
    // (status not busy) withholds nothing.
    const tail = assistantPartRefs.at(-1)
    const tailStreaming =
      isActive &&
      status === "busy" &&
      !error &&
      tail !== undefined &&
      tail.messageIndex === assistantMessages.length - 1 &&
      (tail.part.type === "text" || tail.part.type === "reasoning") &&
      !tail.part.time?.end
    const tailWithheld =
      tailStreaming && tail !== undefined && (tail.part.type === "reasoning" || !tailProseSettled)
    const settledPartRefs = tailWithheld ? assistantPartRefs.slice(0, -1) : assistantPartRefs
    const assistantItems =
      interrupted && !compaction
        ? [
            ...groupParts(settledPartRefs.filter((ref) => ref.messageIndex <= interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
            { type: "interrupted" as const },
            ...groupParts(settledPartRefs.filter((ref) => ref.messageIndex > interruptedMessageIndex)).map(
              (group) => ({
                type: "part" as const,
                group,
              }),
            ),
          ]
        : groupParts(settledPartRefs).map((group) => ({ type: "part" as const, group }))
    if (previousUserMessage) rows.push(new TimelineRow.TurnGap({ userMessageID: userMessage.id }))

    if (comments.length > 0 && !inlineComments)
      rows.push(
        new TimelineRow.CommentStrip({
          userMessageID: userMessage.id,
        }),
      )

    rows.push(
      new TimelineRow.UserMessage({
        userMessageID: userMessage.id,
        anchor: inlineComments || comments.length === 0,
      }),
    )

    if (compaction) {
      rows.push(
        new TimelineRow.TurnDivider({
          userMessageID: userMessage.id,
          label: "compaction",
        }),
      )
    }

    let assistantGroupIndex = 0
    // The thought rail fills a step when its SUCCESSOR appears — the same grammar
    // the website animation uses. That deliberately sidesteps out-of-order tool
    // completion: adjacency decides, not each tool's own lifecycle, so a filled
    // dot can never appear above a hollow one.
    const lastRenderableIndex = assistantItems.reduce(
      (acc, item, index) => (item.type === "interrupted" ? acc : index),
      -1,
    )
    const turnIsRunning = isActive && status === "busy" && !error
    // The rail label names steps whose content doesn't already open with its
    // own title. Group rows announce themselves ("Explored", "Worked in
    // shell", "Edited files") and tool cards wear their chips. Prose needs no
    // caption either — the words ARE the step, and "Update" said nothing they
    // don't (Kate 2026-08-24) — so only reasoning steps get a name here.
    const railLabel = (group: PartGroup): string | undefined => {
      if (group.type !== "part") return undefined
      const part = assistantPartRefs.find(
        (ref) => ref.messageID === group.ref.messageID && ref.part.id === group.ref.partID,
      )?.part
      if (part?.type === "reasoning") return "Reasoning"
      return undefined
    }

    // Thinking row renders FIRST — it's the top of the rail, like Shell/Edit.
    // Shows just "Thinking" label. Always present once a turn has assistant content.
    if (assistantPartRefs.length > 0 || turnIsRunning) {
      const heading = assistantMessages
        .flatMap((message) => getMessageParts(message.id))
        .map((part) => (part.type === "reasoning" && part.text ? reasoningHeading(part.text) : undefined))
        .find((value): value is string => !!value)

      rows.push(
        new TimelineRow.Thinking({
          userMessageID: userMessage.id,
          reasoningHeading: heading,
          turnRunning: turnIsRunning,
          turnStartedAt: userMessage.time.created,
        }),
      )
    }

    assistantItems.forEach((item, itemIndex) => {
      if (item.type === "interrupted") {
        // ThinkingMeta attaches to the last output BEFORE the interruption —
        // it summarises the work that was interrupted, not the post-interrupt tail.
        if (assistantPartRefs.length > 0 && !turnIsRunning) {
          rows.push(
            new TimelineRow.ThinkingMeta({
              userMessageID: userMessage.id,
              turnRunning: false,
              turnDurationMs: computeTurnDuration(userMessage, assistantMessages),
            }),
          )
        }
        rows.push(
          new TimelineRow.TurnDivider({
            userMessageID: userMessage.id,
            label: "interrupted",
          }),
        )
        return
      }

      rows.push(
        new TimelineRow.AssistantPart({
          userMessageID: userMessage.id,
          group: item.group,
          previousAssistantPart: assistantGroupIndex > 0,
          lastAssistantPart: itemIndex === lastRenderableIndex,
          turnRunning: turnIsRunning,
          turnStartedAt: userMessage.time.created,
          railLabel: railLabel(item.group),
        }),
      )
      assistantGroupIndex += 1
    })

    // ThinkingMeta row renders LAST — duration + tokens as a historical record.
    // Hidden while streaming (the harmonic dot signals "working"); appears only
    // after the turn completes. Skipped when interrupted — already emitted above.
    if (assistantPartRefs.length > 0 && !turnIsRunning && !interrupted) {
      rows.push(
        new TimelineRow.ThinkingMeta({
          userMessageID: userMessage.id,
          turnRunning: false,
          turnDurationMs: computeTurnDuration(userMessage, assistantMessages),
        }),
      )
    }

    if (isActive && status === "retry") rows.push(new TimelineRow.Retry({ userMessageID: userMessage.id }))

    // Per-message "Changed files" section suppressed (harmoniqs/amicode#733):
    // redundant with the side-panel Files Changed tab, and the unfiltered
    // snapshot diff leaks cross-session file changes during concurrent turns.

    if (error) {
      const data = error.data?.message
      rows.push(
        new TimelineRow.Error({
          userMessageID: userMessage.id,
          text: unwrapErrorMessage(
            typeof data === "string" ? data : data === undefined || data === null ? "" : String(data),
          ),
        }),
      )
    }

    return rows
  }

  function reasoningHeading(text: string) {
    const markdown = text.replace(/\r\n?/g, "\n")
    const html = markdown.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    if (html?.[1]) {
      const value = cleanHeading(html[1].replace(/<[^>]+>/g, " "))
      if (value) return value
    }

    const atx = markdown.match(/^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/m)
    if (atx?.[1]) {
      const value = cleanHeading(atx[1])
      if (value) return value
    }

    const setext = markdown.match(/^([^\n]+)\n(?:=+|-+)\s*$/m)
    if (setext?.[1]) {
      const value = cleanHeading(setext[1])
      if (value) return value
    }

    const strong = markdown.match(/^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/m)
    if (strong?.[1]) {
      const value = cleanHeading(strong[1])
      if (value) return value
    }
  }

  function cleanHeading(value: string) {
    return value
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_~]+/g, "")
      .trim()
  }

  function unwrapErrorMessage(message: string) {
    const text = message.replace(/^Error:\s*/, "").trim()

    const parse = (value: string) => {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return undefined
      }
    }

    const read = (value: string) => {
      const first = parse(value)
      if (typeof first !== "string") return first
      return parse(first.trim())
    }

    let json = read(text)

    if (json === undefined) {
      const start = text.indexOf("{")
      const end = text.lastIndexOf("}")
      if (start !== -1 && end > start) json = read(text.slice(start, end + 1))
    }

    if (!record(json)) return message

    const err = record(json.error) ? json.error : undefined
    if (err) {
      const type = typeof err.type === "string" ? err.type : undefined
      const msg = typeof err.message === "string" ? err.message : undefined
      if (type && msg) return `${type}: ${msg}`
      if (msg) return msg
      if (type) return type
      const code = typeof err.code === "string" ? err.code : undefined
      if (code) return code
    }

    const msg = typeof json.message === "string" ? json.message : undefined
    if (msg) return msg

    const reason = typeof json.error === "string" ? json.error : undefined
    if (reason) return reason

    return message
  }

  function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }
}

export namespace MessageComment {
  export type MessageComment = {
    path: string
    comment: string
    selection?: {
      startLine: number
      endLine: number
    }
  }

  export const fromPart = (part: Part): MessageComment | undefined => {
    if (part.type !== "text" || !part.synthetic) return
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return
    return {
      path: next.path,
      comment: next.comment,
      selection: next.selection
        ? {
            startLine: next.selection.startLine,
            endLine: next.selection.endLine,
          }
        : undefined,
    }
  }
}

function computeTurnDuration(userMessage: UserMessage, assistantMessages: AssistantMessage[]): number | undefined {
  const end = assistantMessages.reduce<number | undefined>((max, msg) => {
    const completed = msg.time.completed
    if (typeof completed !== "number") return max
    if (max === undefined) return completed
    return Math.max(max, completed)
  }, undefined)
  if (typeof end !== "number") return
  if (end < userMessage.time.created) return
  return end - userMessage.time.created
}

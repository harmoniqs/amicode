import type { SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import type { PartGroup } from "@opencode-ai/session-ui/message-part"
import { Data, Equal } from "effect"

export type SummaryDiff = SnapshotFileDiff & { file: string }

export namespace TimelineRow {
  export class TurnGap extends Data.TaggedClass("TurnGap")<{
    userMessageID: string
  }> {}
  export class CommentStrip extends Data.TaggedClass("CommentStrip")<{
    userMessageID: string
  }> {}
  export class UserMessage extends Data.TaggedClass("UserMessage")<{
    userMessageID: string
    anchor: boolean
  }> {}
  export class TurnDivider extends Data.TaggedClass("TurnDivider")<{
    userMessageID: string
    label: "compaction" | "interrupted"
  }> {}
  export class AssistantPart extends Data.TaggedClass("AssistantPart")<{
    userMessageID: string
    group: PartGroup
    previousAssistantPart: boolean
    /** no further assistant part follows in this turn — the rail's tail */
    lastAssistantPart: boolean
    /** the turn is still working, so the tail step is in flight rather than done */
    turnRunning: boolean
    /** epoch-ms when the user message was created — anchors the dot tooltip timer */
    turnStartedAt: number
    /** eyebrow naming the action for steps whose content doesn't already open
     *  with its own title — reasoning ("Reasoning") only. Prose carries no
     *  caption (the words are the step), and tool cards and the Explored /
     *  Worked-in-shell / Edited group headers announce themselves. */
    railLabel?: string
  }> {}
  export class Thinking extends Data.TaggedClass("Thinking")<{
    userMessageID: string
    reasoningHeading?: string
    /** the turn is still actively streaming */
    turnRunning: boolean
    /** epoch-ms when the user message was created — anchors the dot tooltip timer */
    turnStartedAt: number
  }> {}
  export class ThinkingMeta extends Data.TaggedClass("ThinkingMeta")<{
    userMessageID: string
    /** the turn is still actively streaming */
    turnRunning: boolean
    /** total turn duration in ms (set only for completed turns) */
    turnDurationMs?: number
  }> {}
  export class DiffSummary extends Data.TaggedClass("DiffSummary")<{
    userMessageID: string
    diffs: SummaryDiff[]
  }> {}
  export class Error extends Data.TaggedClass("Error")<{
    userMessageID: string
    text: string
  }> {}
  export class Retry extends Data.TaggedClass("Retry")<{
    userMessageID: string
  }> {}

  export type TimelineRow =
    | TurnGap
    | CommentStrip
    | UserMessage
    | TurnDivider
    | AssistantPart
    | Thinking
    | ThinkingMeta
    | DiffSummary
    | Error
    | Retry

  export const key = (row: TimelineRow) => {
    switch (row._tag) {
      case "TurnGap":
        return `turn-gap:${row.userMessageID}`
      case "CommentStrip":
        return `comment-strip:${row.userMessageID}`
      case "UserMessage":
        return `user-message:${row.userMessageID}`
      case "TurnDivider":
        return `turn-divider:${row.userMessageID}:${row.label}`
      case "AssistantPart":
        return `assistant-part:${row.userMessageID}:${row.group.key}`
      case "Thinking":
        return `thinking:${row.userMessageID}`
      case "ThinkingMeta":
        return `thinking-meta:${row.userMessageID}`
      case "DiffSummary":
        return `diff-summary:${row.userMessageID}`
      case "Error":
        return `error:${row.userMessageID}`
      case "Retry":
        return `retry:${row.userMessageID}`
    }
  }

  export function equals(a: TimelineRow, b: TimelineRow) {
    return Equal.equals(a, b)
  }
}

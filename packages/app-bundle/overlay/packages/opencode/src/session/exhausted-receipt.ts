// #1905 (spec rd-system v2.1 A13a): the engine-emitted EXHAUSTED receipt.
//
// When a run reaches its agent's step limit, the session loop forces a final
// text-only turn (MAX_STEPS_PROMPT). That decision is loop-local — no plugin
// hook observes it — so the loop marks the forced turn here and the task tool
// turns the mark into a structured receipt for the parent. The receipt is
// derived from the child's persisted tool parts, never from its prose.
import type { SessionV1 } from "@opencode-ai/core/v1/session"

export interface Receipt {
  exhausted: true
  steps: number
  files_touched: string[]
  last_todo?: unknown
  last_error?: string
  task_id: string
}

// assistant messageID -> step count at which the step limit forced it. Bounded:
// only task-tool consumers take() entries; a primary agent with `steps` would
// otherwise accumulate marks forever.
const marks = new Map<string, number>()
const LIMIT = 1024

export function mark(messageID: string, steps: number) {
  marks.delete(messageID)
  marks.set(messageID, steps)
  if (marks.size <= LIMIT) return
  const oldest = marks.keys().next().value
  if (oldest !== undefined) marks.delete(oldest)
}

export function take(messageID: string) {
  const steps = marks.get(messageID)
  marks.delete(messageID)
  return steps
}

// `messages` in chronological order (oldest first).
export function build(input: { taskID: string; steps: number; messages: SessionV1.WithParts[] }): Receipt {
  const tools = input.messages
    .flatMap((msg) => msg.parts)
    .filter((part): part is SessionV1.ToolPart => part.type === "tool")
  const files = [...new Set(tools.flatMap(touched))]
  const todo = tools.findLast((part) => part.tool === "todowrite" && part.state.status === "completed")
  const error = lastError(input.messages, tools)
  return {
    exhausted: true,
    steps: input.steps,
    files_touched: files,
    ...(todo && todo.state.status === "completed" ? { last_todo: todo.state.input.todos } : {}),
    ...(error ? { last_error: error } : {}),
    task_id: input.taskID,
  }
}

export const OPEN = "<exhausted_receipt>"
export const CLOSE = "</exhausted_receipt>"
const PATTERN = /<exhausted_receipt>\n```json\n([\s\S]*?)\n```\n<\/exhausted_receipt>/

export function render(receipt: Receipt) {
  return [OPEN, "```json", JSON.stringify(receipt), "```", CLOSE].join("\n")
}

export function parse(text: string): Receipt | undefined {
  const body = text.match(PATTERN)?.[1]
  if (!body) return undefined
  const value: unknown = JSON.parse(body)
  if (typeof value !== "object" || value === null || (value as { exhausted?: unknown }).exhausted !== true)
    return undefined
  return value as Receipt
}

function touched(part: SessionV1.ToolPart): string[] {
  if (part.state.status !== "completed") return []
  if (part.tool === "edit" || part.tool === "write") {
    const file = part.state.input.filePath
    return typeof file === "string" && file ? [file] : []
  }
  if (part.tool === "apply_patch") {
    const files = part.state.metadata?.files
    if (!Array.isArray(files)) return []
    return files.flatMap((file: { filePath?: unknown; movePath?: unknown }) =>
      [file.filePath, file.movePath].filter((item): item is string => typeof item === "string" && item !== ""),
    )
  }
  return []
}

function lastError(messages: SessionV1.WithParts[], tools: SessionV1.ToolPart[]) {
  const message = messages.findLast((msg) => msg.info.role === "assistant" && msg.info.error)?.info
  const tool = tools.findLast((part) => part.state.status === "error")
  const fromMessage =
    message?.role === "assistant" && message.error
      ? { at: message.id, text: describe(message.error) }
      : undefined
  const fromTool =
    tool && tool.state.status === "error" ? { at: tool.messageID, text: `${tool.tool}: ${tool.state.error}` } : undefined
  if (!fromMessage) return fromTool?.text
  if (!fromTool) return fromMessage.text
  return fromTool.at > fromMessage.at ? fromTool.text : fromMessage.text
}

function describe(error: { name: string; data?: unknown }) {
  const data = error.data as { message?: unknown } | undefined
  return typeof data?.message === "string" && data.message ? `${error.name}: ${data.message}` : error.name
}

export * as ExhaustedReceipt from "./exhausted-receipt"

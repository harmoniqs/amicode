import { AmicoSpinner } from "@opencode-ai/ui/amico-spinner"
import { ThinkingLine, turnTokens } from "@opencode-ai/ui/amicode-thinking"
import { shellRowLabel } from "@opencode-ai/ui/amicode-shell-row"
import { sessionHasAmicodeParts } from "@opencode-ai/ui/amicode-rail-gate"
import { amicoBrainRef, emitAmicoBrainHover } from "@opencode-ai/ui/amicode-brain-ref"
import { copyTextToClipboard } from "../util/clipboard"
import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
  onCleanup,
  Index,
  untrack,
  type JSX,
  type ComponentProps,
} from "solid-js"
import { createStore } from "solid-js/store"
import stripAnsi from "strip-ansi"
import { Dynamic } from "solid-js/web"
import {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message as MessageType,
  Part as PartType,
  ReasoningPart,
  Session,
  SkillPart,
  TextPart,
  ToolPart,
  UserMessage,
  Todo,
  QuestionAnswer,
  QuestionInfo,
} from "@opencode-ai/sdk/v2"
import { useData } from "../context"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type UiI18n, useI18n } from "@opencode-ai/ui/context/i18n"
import { BasicTool, GenericTool } from "./basic-tool"
import { AmicodeToolCard, AmicoSkillChip } from "@opencode-ai/ui/amicode-card"
import { openFileInEditor } from "@opencode-ai/ui/amicode-bridge"
import { Accordion } from "@opencode-ai/ui/accordion"
import { StickyAccordionHeader } from "@opencode-ai/ui/sticky-accordion-header"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { ToolErrorCard } from "./tool-error-card"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { DiffChanges } from "@opencode-ai/ui/diff-changes"
import { Markdown } from "./markdown"
import { skillBody } from "./message-part-skill"
import { ImagePreview } from "@opencode-ai/ui/image-preview"
import { getDirectory as _getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { AttachmentCardV2 } from "../v2/components/attachment-card-v2"
import { CommentCardV2 } from "../v2/components/comment-card-v2"
import { checksum } from "@opencode-ai/core/util/encode"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { AnimatedCountList } from "./tool-count-summary"
import { ToolStatusTitle } from "./tool-status-title"
import { patchFiles } from "./apply-patch-file"
import { animate } from "motion"
import { attached, inline, kind, typeLabel } from "./message-file"
import { readPartText, splitSettledChunks } from "./message-part-text"
import { buildTrace } from "./build-trace"
import { SessionProgressIndicatorV2 } from "../v2/components/session-progress-indicator-v2"

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

// Amicode webview: the execCommand trick and navigator.clipboard both die in
// the chat iframe — copyTextToClipboard bridges to the extension host there.
async function writeClipboard(text: string): Promise<boolean> {
  return copyTextToClipboard(text)
}

function ShellSubmessage(props: { text: string; animate?: boolean }) {
  let widthRef: HTMLSpanElement | undefined
  let valueRef: HTMLSpanElement | undefined

  onMount(() => {
    if (!props.animate) return
    // The initial render collapses width to 0 and hides the value behind a blur;
    // if the user prefers reduced motion, snap straight to the resting state
    // instead of animating (and instead of leaving it stuck collapsed/hidden).
    if (reducedMotion()) {
      if (widthRef) widthRef.style.width = "auto"
      if (valueRef) {
        valueRef.style.opacity = "1"
        valueRef.style.filter = "blur(0px)"
      }
      return
    }
    requestAnimationFrame(() => {
      if (widthRef) {
        animate(widthRef, { width: "auto" }, { type: "spring", visualDuration: 0.25, bounce: 0 })
      }
      if (valueRef) {
        animate(valueRef, { opacity: 1, filter: "blur(0px)" }, { duration: 0.32, ease: [0.16, 1, 0.3, 1] })
      }
    })
  })

  return (
    <span data-component="shell-submessage">
      <span ref={widthRef} data-slot="shell-submessage-width" style={{ width: props.animate ? "0px" : undefined }}>
        <span data-slot="basic-tool-tool-subtitle">
          <span
            ref={valueRef}
            data-slot="shell-submessage-value"
            style={props.animate ? { opacity: 0, filter: "blur(2px)" } : undefined}
          >
            {props.text}
          </span>
        </span>
      </span>
    </span>
  )
}

interface Diagnostic {
  range: {
    start: { line: number; character: number }
    end: { line: number; character: number }
  }
  message: string
  severity?: number
}

function getDiagnostics(
  diagnosticsByFile: Record<string, Diagnostic[]> | undefined,
  filePath: string | undefined,
): Diagnostic[] {
  if (!diagnosticsByFile || !filePath) return []
  const diagnostics = diagnosticsByFile[filePath] ?? []
  return diagnostics.filter((d) => d.severity === 1).slice(0, 3)
}

function DiagnosticsDisplay(props: { diagnostics: Diagnostic[] }): JSX.Element {
  const i18n = useI18n()
  return (
    <Show when={props.diagnostics.length > 0}>
      <div data-component="diagnostics">
        <For each={props.diagnostics}>
          {(diagnostic) => (
            <div data-slot="diagnostic">
              <span data-slot="diagnostic-label">{i18n.t("ui.messagePart.diagnostic.error")}</span>
              <span data-slot="diagnostic-location">
                [{diagnostic.range.start.line + 1}:{diagnostic.range.start.character + 1}]
              </span>
              <span data-slot="diagnostic-message">{diagnostic.message}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
  comments?: UserMessageComment[]
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
  openAttachment?: (file: FilePart) => void
}

export type UserMessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  toolOpen?: boolean
  onToolOpenChange?: (open: boolean) => void
  deferToolContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  useV2Actions?: boolean
  // amicode: set when this part is the surviving (latest) member of a
  // collapsed run of ≥2 identical (problem, entity, action) receipts
  // (./message-part-groups's PartGroup + ../amicode/receipt-runs.ts). Only
  // AmicodeToolCard reads it; every other part type ignores it.
  count?: number
}

function MessageActionButton(
  props: Pick<ComponentProps<"button">, "disabled" | "onMouseDown" | "onClick" | "aria-label"> & {
    icon: "check" | "copy" | "reset"
    label: JSX.Element
    useV2?: boolean
    placement?: "top" | "bottom"
  },
) {
  const icon = () => (props.icon === "copy" ? "outline-copy" : props.icon)
  const placement = () => props.placement ?? "top"
  return (
    <Show
      when={props.useV2}
      fallback={
        <Tooltip value={props.label} placement={placement()} gutter={4}>
          <IconButton
            icon={props.icon}
            size="normal"
            variant="ghost"
            disabled={props.disabled}
            onMouseDown={props.onMouseDown}
            onClick={props.onClick}
            aria-label={props["aria-label"]}
          />
        </Tooltip>
      }
    >
      <TooltipV2 value={props.label} placement={placement()} gutter={4}>
        <IconButtonV2
          icon={<IconV2 name={icon()} size="small" />}
          size="normal"
          variant="ghost-muted"
          disabled={props.disabled}
          onMouseDown={props.onMouseDown}
          onClick={props.onClick}
          aria-label={props["aria-label"]}
        />
      </TooltipV2>
    </Show>
  )
}

export type PartComponent = Component<MessagePartProps>

export const PART_MAPPING: Record<string, PartComponent | undefined> = {}

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_IMMEDIATE = 512
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(256, Math.ceil(size / 4))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length - shown.length <= TEXT_RENDER_IMMEDIATE) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

// Streaming prose lands in whole CHUNKS (Kate 2026-08-25): each settled chunk
// (message-part-text.ts boundaries — blank lines outside fences, never inside
// a list) mounts once and plays the entrance the host skins onto
// [data-part-enter]; the still-composing tail stays withheld — the working
// indicator is the signal while it grows. On completion the remainder lands
// as the final chunk, with its entrance.
//
// The once-only ledger is PART-scoped, not component-scoped: the part
// component can remount mid-stream or at completion (observed live — a
// remount at time.end reset a component-local count and swallowed the final
// chunk's entrance), so the revealed count survives in a module map. A chunk
// animates only when its index is past what this part had already revealed
// at mount; scroll-back remounts of finished parts reveal nothing new.
const revealedChunks = new Map<string, number>()

function ChunkedStreamMarkdown(props: { text: string; done: boolean; cacheKey: string }) {
  const parts = createMemo(() => {
    const { chunks, tail } = splitSettledChunks(props.text)
    if (props.done && tail.trim() !== "") return [...chunks, tail]
    return chunks
  })
  // A part that mounts already done with no ledger entry is HISTORY — every
  // chunk counts as revealed, nothing animates. Only parts observed streaming
  // (ledgered) animate their later chunks.
  const already = revealedChunks.get(props.cacheKey) ?? (untrack(() => props.done) ? Number.MAX_SAFE_INTEGER : 0)
  createEffect(() => {
    const count = parts().length
    if (count > (revealedChunks.get(props.cacheKey) ?? 0)) revealedChunks.set(props.cacheKey, count)
  })
  return (
    <For each={parts()}>
      {(chunk, index) => (
        <div data-prose-fragment data-part-enter={index() >= already ? "" : undefined}>
          <Markdown text={chunk} cacheKey={`${props.cacheKey}:${index()}`} streaming={false} />
        </div>
      )}
    </For>
  )
}

function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <Markdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} />
    </Show>
  )
}

function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}

import type { IconProps } from "@opencode-ai/ui/icon"
import { normalize, resolveFileDiff } from "./session-diff"

export type ToolInfo = {
  icon: IconProps["name"]
  title: string
  subtitle?: string
}

function agentTitle(i18n: UiI18n, type?: string) {
  if (!type) return i18n.t("ui.tool.agent.default")
  return i18n.t("ui.tool.agent", { type })
}

const agentTones: Record<string, string> = {
  ask: "var(--icon-agent-ask-base)",
  build: "var(--icon-agent-build-base)",
  docs: "var(--icon-agent-docs-base)",
  plan: "var(--icon-agent-plan-base)",
}

const v2AgentTones: Record<string, string> = {
  build: "var(--v2-agent-build-solid)",
  explore: "var(--v2-agent-explore-solid)",
  plan: "var(--v2-agent-plan-solid)",
  review: "var(--v2-agent-review-solid)",
  writer: "var(--v2-agent-writer-solid)",
}

const agentThemeColors: Record<string, string> = {
  primary: "var(--text-interactive-base)",
  secondary: "var(--text-base)",
  accent: "var(--icon-info-base)",
  success: "var(--icon-success-base)",
  warning: "var(--icon-warning-base)",
  error: "var(--icon-critical-base)",
  info: "var(--icon-info-base)",
}

const v2AgentThemeColors: Record<string, string> = {
  primary: "var(--v2-text-text-accent)",
  secondary: "var(--v2-text-text-muted)",
  accent: "var(--v2-icon-icon-accent)",
  success: "var(--v2-state-fg-success)",
  warning: "var(--v2-state-fg-warning)",
  error: "var(--v2-state-fg-danger)",
  info: "var(--v2-state-fg-info)",
}

const agentPalette = [
  "var(--icon-agent-ask-base)",
  "var(--icon-agent-build-base)",
  "var(--icon-agent-docs-base)",
  "var(--icon-agent-plan-base)",
  "var(--syntax-info)",
  "var(--syntax-success)",
  "var(--syntax-warning)",
  "var(--syntax-property)",
  "var(--syntax-constant)",
  "var(--text-diff-add-base)",
  "var(--text-diff-delete-base)",
  "var(--icon-warning-base)",
]

function tone(name: string) {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return agentPalette[hash % agentPalette.length]
}

function taskAgent(
  raw: unknown,
  list?: readonly { name: string; color?: string }[],
): { name?: string; color?: string; v2Color?: string } {
  if (typeof raw !== "string" || !raw) return {}
  const key = raw.toLowerCase()
  const item = list?.find((entry) => entry.name === raw || entry.name.toLowerCase() === key)
  const v2Tone = item?.color ? undefined : v2AgentTones[key]
  const color = agentColor(item?.color, agentThemeColors) ?? agentTones[key] ?? tone(key)
  const v2Color = agentColor(item?.color, v2AgentThemeColors) ?? v2Tone ?? color
  return {
    name: item?.name ?? `${raw[0]!.toUpperCase()}${raw.slice(1)}`,
    color,
    v2Color,
  }
}

function agentColor(value: string | undefined, themeColors: Record<string, string>) {
  if (!value) return
  return themeColors[value] ?? value
}

function newLayout() {
  return typeof document !== "undefined" && document.body.hasAttribute("data-new-layout")
}

function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel Web Search"
  if (provider === "exa") return "Exa Web Search"
  return "Web Search"
}

export function getToolInfo(
  tool: string,
  input: any = {},
  metadata: Record<string, unknown> | undefined = {},
): ToolInfo {
  const i18n = useI18n()
  switch (tool) {
    case "read":
      return {
        icon: "glasses",
        title: i18n.t("ui.tool.read"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "list":
      return {
        icon: "bullet-list",
        title: i18n.t("ui.tool.list"),
        subtitle: input.path ? getFilename(input.path) : undefined,
      }
    case "glob":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.glob"),
        subtitle: input.pattern,
      }
    case "grep":
      return {
        icon: "magnifying-glass-menu",
        title: i18n.t("ui.tool.grep"),
        subtitle: input.pattern,
      }
    case "webfetch":
      return {
        icon: "window-cursor",
        title: i18n.t("ui.tool.webfetch"),
        subtitle: input.url,
      }
    case "websearch":
      return {
        icon: "window-cursor",
        title: webSearchProviderLabel(metadata?.provider),
        subtitle: input.query,
      }
    case "task": {
      const type =
        typeof input.subagent_type === "string" && input.subagent_type
          ? input.subagent_type[0]!.toUpperCase() + input.subagent_type.slice(1)
          : undefined
      return {
        icon: "task",
        title: agentTitle(i18n, type),
        subtitle: input.description,
      }
    }
    case "bash":
    case "shell":
      return {
        icon: "console",
        title: i18n.t("ui.tool.shell"),
        subtitle: input.command,
      }
    case "edit":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.edit"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "write":
      return {
        icon: "code-lines",
        title: i18n.t("ui.messagePart.title.write"),
        subtitle: input.filePath ? getFilename(input.filePath) : undefined,
      }
    case "patch":
    case "apply_patch":
      return {
        icon: "code-lines",
        title: i18n.t("ui.tool.patch"),
        subtitle: input.files?.length
          ? `${input.files.length} ${i18n.t(input.files.length > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
          : undefined,
      }
    case "todowrite":
      return {
        icon: "checklist",
        title: i18n.t("ui.tool.todos"),
      }
    case "question":
      return {
        icon: "bubble-5",
        title: i18n.t("ui.tool.questions"),
      }
    case "skill":
      return {
        icon: "brain",
        // AMICODE: name the kind here too. This is the compact/summary path, where the
        // fallback-only use of ui.tool.skill left an activated skill looking like a bare tool.
        title: input.name ? `${i18n.t("ui.tool.skill")} · ${input.name}` : i18n.t("ui.tool.skill"),
      }
    default:
      return {
        icon: "mcp",
        title: tool,
      }
  }
}

function urls(text: string | undefined) {
  if (!text) return []
  const seen = new Set<string>()
  return [...text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)]
    .map((item) => item[0].replace(/[),.;:!?]+$/g, ""))
    .filter((item) => {
      if (seen.has(item)) return false
      seen.add(item)
      return true
    })
}

function sessionLink(id: string | undefined, href?: (id: string) => string | undefined) {
  if (!id) return undefined
  return href?.(id)
}

function taskSession(
  input: Record<string, any>,
  parentID: string | undefined,
  sessions: Session[] | undefined,
  agents?: readonly { name: string; color?: string }[],
) {
  if (!parentID) return undefined
  const description = typeof input.description === "string" ? input.description : ""
  const agent = taskAgent(input.subagent_type, agents).name
  return (sessions ?? [])
    .filter((session) => session.parentID === parentID && !session.time?.archived)
    .filter((session) => (description ? session.title.startsWith(description) : true))
    .filter((session) => (agent ? session.title.includes(`@${agent}`) : true))
    .sort((a, b) => (b.time.created ?? 0) - (a.time.created ?? 0))[0]?.id
}

const HIDDEN_TOOLS = new Set(["todowrite"])

function list<T>(value: T[] | undefined | null, fallback: T[]) {
  if (Array.isArray(value)) return value
  return fallback
}

function same<T>(a: readonly T[] | undefined, b: readonly T[] | undefined) {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  return a.every((x, i) => x === b[i])
}

// Grouping primitives live in ./message-part-groups (pure, unit-tested); re-export
// the public names so `@opencode-ai/ui/message-part` stays the stable import path.
export {
  groupParts,
  sameGroups,
  isContextGroupTool,
  isShellGroupTool,
  isEditGroupTool,
  type PartGroup,
  type PartRef,
} from "./message-part-groups"
import {
  groupParts,
  sameGroups,
  isContextGroupTool,
  isShellGroupTool,
  isEditGroupTool,
  type PartGroup,
  type PartRef,
} from "./message-part-groups"
import { parseDiffSentinel } from "@opencode-ai/ui/amicode-receipt"
import { editRowDiff, editRowFilePath, editRowLabel } from "@opencode-ai/ui/amicode-edit-row"
import {
  collapseReceiptRuns,
  receiptRunKey,
  type ReceiptCandidate,
  type ReceiptKey,
} from "@opencode-ai/ui/amicode-receipt-runs"

function index<T extends { id: string }>(items: readonly T[]) {
  return new Map(items.map((item) => [item.id, item] as const))
}

// amicode: does this resolved part carry a mergeable receipt key? Only
// completed amicode_* tool calls whose AMICODE_DIFF sentinel parses (and
// whose entity isn't inline-view-eligible — see receipt-runs.ts) are
// candidates; everything else (still running, errored, not amicode_*, no/
// unparseable sentinel) gets `key: undefined` and can never merge.
function amicodeReceiptCandidateKey(part: PartType | undefined): { key?: ReceiptKey; seq?: number } {
  if (!part || part.type !== "tool" || !part.tool.startsWith("amicode_")) return {}
  if (part.state.status !== "completed") return {}
  const sentinel = parseDiffSentinel(part.state.output)
  return { key: receiptRunKey(sentinel), seq: sentinel?.seq }
}

function sameAmicodeCounts(a: Map<string, number>, b: Map<string, number>) {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

// amicode: second pass over groupParts's output that collapses consecutive
// "part" entries which are amicode_* receipts sharing (problem, entity,
// action) into one — the fix for "these repeated amico cards add a lot of
// clutter" (four amicode_* calls updating the same entity rendering four
// identical cards). context/shell groups and any part that isn't a
// collapse-eligible receipt pass through unchanged; see ../amicode/
// receipt-runs.ts for the (conservative, tested) matching rules.
function collapseAmicodeGroups(
  groups: readonly PartGroup[],
  resolvePart: (ref: PartRef) => PartType | undefined,
): { groups: PartGroup[]; counts: Map<string, number> } {
  const candidates: ReceiptCandidate<PartGroup>[] = groups.map((group) => {
    if (group.type !== "part") return { ref: group }
    const { key, seq } = amicodeReceiptCandidateKey(resolvePart(group.ref))
    return { ref: group, key, seq }
  })
  const runs = collapseReceiptRuns(candidates)
  const counts = new Map<string, number>()
  const survivors = runs.map((run) => {
    if (run.count > 1) counts.set(run.latestRef.key, run.count)
    return run.latestRef
  })
  return { groups: survivors, counts }
}

export function renderable(part: PartType, showReasoningSummaries = true) {
  if (part.type === "tool") {
    if (HIDDEN_TOOLS.has(part.tool)) return false
    if (part.tool === "question") return part.state.status !== "pending" && part.state.status !== "running"
    return true
  }
  if (part.type === "text") return !!part.text?.trim()
  if (part.type === "reasoning") return showReasoningSummaries && !!part.text?.trim()
  return !!PART_MAPPING[part.type]
}

function toolDefaultOpen(tool: string, shell = false, edit = false) {
  if (tool === "bash" || tool === "shell") return shell
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch") return edit
}

export function partDefaultOpen(part: PartType, shell = false, edit = false) {
  if (part.type !== "tool") return
  return toolDefaultOpen(part.tool, shell, edit)
}

export function AssistantParts(props: {
  messages: AssistantMessage[]
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
  useV2Actions?: boolean
  working?: boolean
  showReasoningSummaries?: boolean
  shellToolDefaultOpen?: boolean
  editToolDefaultOpen?: boolean
}) {
  const data = useData()
  const emptyParts: PartType[] = []
  const emptyTools: ToolPart[] = []
  const msgs = createMemo(() => index(props.messages))
  const part = createMemo(
    () =>
      new Map(
        props.messages.map((message) => [message.id, index(list(data.store.part?.[message.id], emptyParts))] as const),
      ),
  )

  const grouped = createMemo(
    () =>
      groupParts(
        props.messages.flatMap((message) =>
          list(data.store.part?.[message.id], emptyParts)
            .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
            .map((part) => ({
              messageID: message.id,
              part,
            })),
        ),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  const last = createMemo(() => grouped().at(-1)?.key)

  // amicode: collapse runs of consecutive amicode_* receipts sharing (problem,
  // entity, action) into one card + count (../amicode/receipt-runs.ts). Drives
  // the render list below; `last()` above stays keyed off the UNCOLLAPSED
  // groups so the busy/streaming indicator keeps comparing against the raw
  // most-recent group (its key survives collapsing whenever it's genuinely the
  // latest receipt, which is the only case that indicator cares about).
  const collapsed = createMemo(
    () => collapseAmicodeGroups(grouped(), (ref) => part().get(ref.messageID)?.get(ref.partID)),
    { groups: [] as PartGroup[], counts: new Map<string, number>() },
    { equals: (a, b) => sameGroups(a.groups, b.groups) && sameAmicodeCounts(a.counts, b.counts) },
  )

  // amicode: tokens generated so far this turn (output + reasoning across the
  // turn's assistant messages) — feeds the thinking line's live token chip.
  // Reactive: re-runs as the store updates message.tokens.* while streaming.
  const turnTokenCount = createMemo(() => turnTokens(props.messages))

  // amicode: is THIS turn in Amico's domain? (does it carry an amicode_* tool
  // part). The only turn-level domain signal available in the UI — Amico's
  // presence (the working lane below; the rail waking) keys off it. Plain-prose
  // turns are the *normal chat*: no Amico chrome in the flow
  // (spec-20260712-amico-third-actor).
  // Shares the rail's gate (rail-gate.ts) rather than re-testing `amicode_*`
  // here. Both used the tool-name test independently, so a SHELL-driven amicode
  // session lost the chips AND Amico's presence mark together — the H-mark read
  // as "inactive" while a solve was running at iteration 29 (2026-07-29). One
  // definition, one place to widen.
  const inDomainTurn = createMemo(() =>
    sessionHasAmicodeParts(props.messages, (id) => list(data.store.part?.[id], emptyParts) as never),
  )

  return (
    <>
      {/* amicode: identity lives in the entity rail now (Amico's body), NOT a
          per-turn stamp — plain-prose turns read as the normal chat. On an
          in-domain turn, Amico's working presence rides in an offset accent
          lane BELOW the streamed parts (see the lane after </Index>).
          spec-20260712-amico-third-actor. */}
      <Index each={collapsed().groups}>
        {(entryAccessor) => {
          const entryType = createMemo(() => entryAccessor().type)

          return (
            <Switch>
              <Match when={entryType() === "context"}>
                {(() => {
                  const parts = createMemo(
                    () => {
                      const entry = entryAccessor()
                      if (entry.type !== "context") return emptyTools
                      return entry.refs
                        .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                        .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                    },
                    emptyTools,
                    { equals: same },
                  )
                  const busy = createMemo(() => props.working && last() === entryAccessor().key)

                  return (
                    <Show when={parts().length > 0}>
                      <ContextToolGroup parts={parts()} busy={busy()} />
                    </Show>
                  )
                })()}
              </Match>
              <Match when={entryType() === "shell"}>
                {(() => {
                  const parts = createMemo(
                    () => {
                      const entry = entryAccessor()
                      if (entry.type !== "shell") return emptyTools
                      return entry.refs
                        .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                        .filter((part): part is ToolPart => !!part && isShellGroupTool(part))
                    },
                    emptyTools,
                    { equals: same },
                  )
                  const busy = createMemo(() => props.working && last() === entryAccessor().key)

                  return (
                    <Show when={parts().length > 0}>
                      <ShellToolGroup parts={parts()} busy={busy()} />
                    </Show>
                  )
                })()}
              </Match>
              <Match when={entryType() === "edit"}>
                {(() => {
                  const parts = createMemo(
                    () => {
                      const entry = entryAccessor()
                      if (entry.type !== "edit") return emptyTools
                      return entry.refs
                        .map((ref) => part().get(ref.messageID)?.get(ref.partID))
                        .filter((part): part is ToolPart => !!part && isEditGroupTool(part))
                    },
                    emptyTools,
                    { equals: same },
                  )
                  const busy = createMemo(() => props.working && last() === entryAccessor().key)

                  return (
                    <Show when={parts().length > 0}>
                      <EditToolGroup parts={parts()} busy={busy()} />
                    </Show>
                  )
                })()}
              </Match>
              <Match when={entryType() === "part"}>
                {(() => {
                  const message = createMemo(() => {
                    const entry = entryAccessor()
                    if (entry.type !== "part") return
                    return msgs().get(entry.ref.messageID)
                  })
                  const item = createMemo(() => {
                    const entry = entryAccessor()
                    if (entry.type !== "part") return
                    return part().get(entry.ref.messageID)?.get(entry.ref.partID)
                  })
                  // amicode: >1 when this part survived a receipt-run collapse
                  // (../amicode/receipt-runs.ts); undefined for every other part.
                  const count = createMemo(() => collapsed().counts.get(entryAccessor().key))

                  return (
                    <Show when={message()}>
                      <Show when={item()}>
                        <Part
                          part={item()!}
                          message={message()!}
                          showAssistantCopyPartID={props.showAssistantCopyPartID}
                          turnDurationMs={props.turnDurationMs}
                          useV2Actions={props.useV2Actions}
                          defaultOpen={partDefaultOpen(item()!, props.shellToolDefaultOpen, props.editToolDefaultOpen)}
                          count={count()}
                        />
                      </Show>
                    </Show>
                  )
                })()}
              </Match>
            </Switch>
          )
        }}
      </Index>
      {/* amicode: Amico's working presence — the offset accent lane. Shown only
          while an in-domain turn streams (state === "on"), decoupled from any
          card-suppression: the thinking block (wave + cycling gerund + live
          elapsed/tokens) runs without a duplicate mark. Pops out the
          moment working flips false. spec-20260712-amico-third-actor. */}
      <Show when={inDomainTurn() && props.working && last() === grouped().at(-1)?.key}>
        <div class="amc-lane" data-slot="amico-working">
          <ThinkingLine tokens={turnTokenCount() || undefined} />
        </div>
      </Show>
      <TurnFooter messages={props.messages} turnDurationMs={props.turnDurationMs} working={props.working} />
    </>
  )
}

function TurnFooter(props: {
  messages: AssistantMessage[]
  turnDurationMs?: number
  working?: boolean
}) {
  const data = useData()
  const i18n = useI18n()
  const numfmt = createMemo(() => new Intl.NumberFormat(i18n.locale()))
  const [copied, setCopied] = createSignal(false)

  const lastMessage = createMemo(() => props.messages.at(-1))

  const model = createMemo(() => {
    const message = lastMessage()
    if (!message) return ""
    const match = data.store.provider?.all?.get(message.providerID)
    return match?.models?.[message.modelID]?.name ?? message.modelID
  })

  const duration = createMemo(() => {
    const message = lastMessage()
    if (!message) return ""
    const completed = message.time.completed
    const ms =
      typeof props.turnDurationMs === "number"
        ? props.turnDurationMs
        : typeof completed === "number"
          ? completed - message.time.created
          : -1
    if (!(ms >= 0)) return ""
    const total = Math.round(ms / 1000)
    if (total < 60) return i18n.t("ui.message.duration.seconds", { count: numfmt().format(total) })
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return i18n.t("ui.message.duration.minutesSeconds", {
      minutes: numfmt().format(minutes),
      seconds: numfmt().format(seconds),
    })
  })

  const interrupted = createMemo(() => {
    const message = lastMessage()
    return !!message?.error?.name && message.error.name === "MessageAbortedError"
  })

  const meta = createMemo(() => {
    const message = lastMessage()
    if (!message) return ""
    const agent = message.agent
    const items = [
      agent ? agent[0]?.toUpperCase() + agent.slice(1) : "",
      model(),
      duration(),
      interrupted() ? i18n.t("ui.message.interrupted") : "",
    ]
    return items.filter((x) => !!x).join(" \u00B7 ")
  })

  const handleCopyTrace = async () => {
    const emptyParts: PartType[] = []
    const content = buildTrace(props.messages, (id) => list(data.store.part?.[id], emptyParts))
    if (!content) return
    if (await writeClipboard(content)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  return (
    <Show when={!props.working && lastMessage()}>
      <div data-slot="turn-footer">
        <MessageActionButton
          icon={copied() ? "check" : "copy"}
          label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyTrace")}
          placement="bottom"
          useV2={true}
          onMouseDown={(event) => event.preventDefault()}
          onClick={handleCopyTrace}
          aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyTrace")}
        />
        <Show when={meta()}>
          <span data-slot="turn-footer-meta" class="text-12-regular text-text-weak cursor-default">
            {meta()}
          </span>
        </Show>
      </div>
    </Show>
  )
}
// One-line command for a bash part's row in the shell group. Logic lives in
// ../amicode/shell-row.ts so the fallback chain is testable — it shipped a bug
// where a pending part rendered the model's prose description as if it were the
// command, which read as a hard error for the command's whole duration.
function shellCommandText(part: ToolPart): string {
  return shellRowLabel(part)
}

function contextToolDetail(part: ToolPart): string | undefined {
  const info = getToolInfo(
    part.tool,
    part.state.input ?? {},
    "metadata" in part.state ? part.state.metadata : undefined,
  )
  if (info.subtitle) return info.subtitle
  if (part.state.status === "error") return part.state.error
  if ((part.state.status === "running" || part.state.status === "completed") && part.state.title)
    return part.state.title
  const description = part.state.input?.description
  if (typeof description === "string") return description
  return undefined
}

function contextToolTrigger(part: ToolPart, i18n: ReturnType<typeof useI18n>) {
  const input = (part.state.input ?? {}) as Record<string, unknown>
  const path = typeof input.path === "string" ? input.path : "/"
  const filePath = typeof input.filePath === "string" ? input.filePath : undefined
  const pattern = typeof input.pattern === "string" ? input.pattern : undefined
  const include = typeof input.include === "string" ? input.include : undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  const limit = typeof input.limit === "number" ? input.limit : undefined

  switch (part.tool) {
    case "read": {
      const args: string[] = []
      if (offset !== undefined) args.push("offset=" + offset)
      if (limit !== undefined) args.push("limit=" + limit)
      return {
        title: i18n.t("ui.tool.read"),
        subtitle: filePath ? getFilename(filePath) : "",
        args,
      }
    }
    case "list":
      return {
        title: i18n.t("ui.tool.list"),
        subtitle: getDirectory(path),
      }
    case "glob":
      return {
        title: i18n.t("ui.tool.glob"),
        subtitle: getDirectory(path),
        args: pattern ? ["pattern=" + pattern] : [],
      }
    case "grep": {
      const args: string[] = []
      if (pattern) args.push("pattern=" + pattern)
      if (include) args.push("include=" + include)
      return {
        title: i18n.t("ui.tool.grep"),
        subtitle: getDirectory(path),
        args,
      }
    }
    default: {
      const info = getToolInfo(part.tool, input, "metadata" in part.state ? part.state.metadata : undefined)
      return {
        title: info.title,
        subtitle: info.subtitle || contextToolDetail(part),
        args: [],
      }
    }
  }
}

function contextToolSummary(parts: ToolPart[]) {
  const read = parts.filter((part) => part.tool === "read").length
  const search = parts.filter((part) => part.tool === "glob" || part.tool === "grep").length
  const list = parts.filter((part) => part.tool === "list").length
  return { read, search, list }
}

function ExaOutput(props: { output?: string }) {
  const links = createMemo(() => urls(props.output))

  return (
    <Show when={links().length > 0}>
      <div data-component="exa-tool-output">
        <div data-slot="exa-tool-links">
          <For each={links()}>
            {(url) => (
              <a
                data-slot="exa-tool-link"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {url}
              </a>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}

export function registerPartComponent(type: string, component: PartComponent) {
  PART_MAPPING[type] = component
}

export function Message(props: MessageProps) {
  return (
    <Switch>
      <Match when={props.message.role === "user" && props.message}>
        {(userMessage) => (
          <UserMessageDisplay
            message={userMessage() as UserMessage}
            parts={props.parts}
            actions={props.actions}
            useV2Actions={props.useV2Actions}
            comments={props.comments}
          />
        )}
      </Match>
      <Match when={props.message.role === "assistant" && props.message}>
        {(assistantMessage) => (
          <AssistantMessageDisplay
            message={assistantMessage() as AssistantMessage}
            parts={props.parts}
            showAssistantCopyPartID={props.showAssistantCopyPartID}
            showReasoningSummaries={props.showReasoningSummaries}
            useV2Actions={props.useV2Actions}
          />
        )}
      </Match>
    </Switch>
  )
}

export function AssistantMessageDisplay(props: {
  message: AssistantMessage
  parts: PartType[]
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
  useV2Actions?: boolean
}) {
  const emptyTools: ToolPart[] = []
  const part = createMemo(() => index(props.parts))
  const grouped = createMemo(
    () =>
      groupParts(
        props.parts
          .filter((part) => renderable(part, props.showReasoningSummaries ?? true))
          .map((part) => ({
            messageID: props.message.id,
            part,
          })),
      ),
    [] as PartGroup[],
    { equals: sameGroups },
  )

  // amicode: same receipt-run collapse as AssistantParts, above — see
  // ../amicode/receipt-runs.ts.
  const collapsed = createMemo(
    () => collapseAmicodeGroups(grouped(), (ref) => part().get(ref.partID)),
    { groups: [] as PartGroup[], counts: new Map<string, number>() },
    { equals: (a, b) => sameGroups(a.groups, b.groups) && sameAmicodeCounts(a.counts, b.counts) },
  )

  return (
    <Index each={collapsed().groups}>
      {(entryAccessor) => {
        const entryType = createMemo(() => entryAccessor().type)

        return (
          <Switch>
            <Match when={entryType() === "context"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "context") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isContextGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ContextToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "shell"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "shell") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isShellGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <ShellToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "edit"}>
              {(() => {
                const parts = createMemo(
                  () => {
                    const entry = entryAccessor()
                    if (entry.type !== "edit") return emptyTools
                    return entry.refs
                      .map((ref) => part().get(ref.partID))
                      .filter((part): part is ToolPart => !!part && isEditGroupTool(part))
                  },
                  emptyTools,
                  { equals: same },
                )

                return (
                  <Show when={parts().length > 0}>
                    <EditToolGroup parts={parts()} />
                  </Show>
                )
              })()}
            </Match>
            <Match when={entryType() === "part"}>
              {(() => {
                const item = createMemo(() => {
                  const entry = entryAccessor()
                  if (entry.type !== "part") return
                  return part().get(entry.ref.partID)
                })
                const count = createMemo(() => collapsed().counts.get(entryAccessor().key))

                return (
                  <Show when={item()}>
                    <Part
                      part={item()!}
                      message={props.message}
                      showAssistantCopyPartID={props.showAssistantCopyPartID}
                      useV2Actions={props.useV2Actions}
                      count={count()}
                    />
                  </Show>
                )
              })()}
            </Match>
          </Switch>
        )
      }}
    </Index>
  )
}

export function ContextToolGroup(props: {
  parts: ToolPart[]
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSizeChange?: () => void
}) {
  const i18n = useI18n()
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const summary = createMemo(() => contextToolSummary(props.parts))
  const handleOpenChange = (value: boolean) => {
    if (props.open === undefined) setLocalOpen(value)
    props.onOpenChange?.(value)
    props.onSizeChange?.()
  }
  // amicode: hovering the group chip glances at every member node on the map
  const glanceAll = () => {
    for (const p of props.parts.slice(0, 8)) emitAmicoBrainHover(amicoBrainRef(p.tool, p.state.input ?? {}))
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger" onMouseEnter={glanceAll}>
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText={i18n.t("ui.sessionTurn.status.gatheringContext")}
                doneText={i18n.t("ui.sessionTurn.status.gatheredContext")}
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              <AnimatedCountList
                items={[
                  {
                    key: "read",
                    count: summary().read,
                    one: i18n.t("ui.messagePart.context.read.one"),
                    other: i18n.t("ui.messagePart.context.read.other"),
                  },
                  {
                    key: "search",
                    count: summary().search,
                    one: i18n.t("ui.messagePart.context.search.one"),
                    other: i18n.t("ui.messagePart.context.search.other"),
                  },
                  {
                    key: "list",
                    count: summary().list,
                    one: i18n.t("ui.messagePart.context.list.one"),
                    other: i18n.t("ui.messagePart.context.list.other"),
                  },
                ]}
                fallback=""
              />
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const trigger = createMemo(() => contextToolTrigger(partAccessor(), i18n))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title">
                              <span data-pending={running() ? "true" : "false"}>{trigger().title}</span>
                            </span>
                            <Show when={!running() && trigger().subtitle}>
                              <span data-slot="basic-tool-tool-subtitle">{trigger().subtitle}</span>
                            </Show>
                            <Show when={!running() && trigger().args?.length}>
                              <For each={trigger().args}>
                                {(arg) => <span data-slot="basic-tool-tool-arg">{arg}</span>}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

// AMICODE (spec B): consecutive bash commands collapse into one row so a long
// run of shell calls doesn't dominate the timeline. Mirrors ContextToolGroup's
// markup (reuses its CSS slots) with a shell label + per-command list. A lone
// command never reaches here — groupParts leaves it as a full bash card.
export function ShellToolGroup(props: { parts: ToolPart[]; busy?: boolean; onSizeChange?: () => void }) {
  const [open, setOpen] = createSignal(false)
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const count = createMemo(() => props.parts.length)
  const handleOpenChange = (value: boolean) => {
    setOpen(value)
    props.onSizeChange?.()
  }
  // amicode: hovering the group chip glances at every member node on the map
  const glanceAll = () => {
    for (const p of props.parts.slice(0, 8)) emitAmicoBrainHover(amicoBrainRef(p.tool, p.state.input ?? {}))
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger" onMouseEnter={glanceAll}>
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle
                active={pending()}
                activeText="Working in shell"
                doneText="Worked in shell"
                split={false}
              />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              {count()} {count() === 1 ? "command" : "commands"}
            </span>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const cmd = createMemo(() => shellCommandText(partAccessor()))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              const errored = createMemo(() => partAccessor().state.status === "error")
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title" class="font-mono">
                              <span data-pending={running() ? "true" : "false"}>{cmd()}</span>
                            </span>
                            <Show when={errored()}>
                              <span data-slot="basic-tool-tool-subtitle" style={{ color: "var(--v2-state-fg-danger)" }}>
                                failed
                              </span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

// AMICODE (spec B shape): consecutive file mutations (edit/write/patch) collapse
// into one row so a long authoring run doesn't dominate the timeline. Mirrors
// ShellToolGroup's markup (reuses its CSS slots) with per-file rows that keep
// their diff stats. A lone mutation never reaches here — groupParts leaves it
// as a full card, whose inline diff is worth the space. Row labels come from
// @opencode-ai/ui/amicode-edit-row (pure, tested): a pending part without a
// filePath can never fill the row with prose.
export function EditToolGroup(props: { parts: ToolPart[]; busy?: boolean; onSizeChange?: () => void }) {
  const [open, setOpen] = createSignal(false)
  const pending = createMemo(
    () =>
      !!props.busy || props.parts.some((part) => part.state.status === "pending" || part.state.status === "running"),
  )
  const count = createMemo(() => props.parts.length)
  // Unique targets: "4 changes in 3 files" reads truer than a bare call count
  // when the same file is re-edited mid-run.
  const fileCount = createMemo(() => {
    const paths = props.parts
      .map((part) => editRowFilePath(part))
      .filter((path): path is string => typeof path === "string")
    return new Set(paths).size
  })
  // Aggregate +/- across the run — DiffChanges sums an array itself. Parts that
  // haven't recorded a filediff yet (still pending) simply don't contribute.
  const diffs = createMemo(() =>
    props.parts
      .map((part) => editRowDiff(part))
      .filter((diff): diff is { additions: number; deletions: number } => !!diff),
  )
  const handleOpenChange = (value: boolean) => {
    setOpen(value)
    props.onSizeChange?.()
  }
  // amicode: hovering the group chip glances at every member node on the map
  const glanceAll = () => {
    for (const p of props.parts.slice(0, 8)) emitAmicoBrainHover(amicoBrainRef(p.tool, p.state.input ?? {}))
  }

  return (
    <Collapsible
      open={open()}
      onOpenChange={handleOpenChange}
      variant="ghost"
      class="tool-collapsible"
      data-timeline-part-ids={props.parts.map((part) => part.id).join(",")}
    >
      <Collapsible.Trigger>
        <div data-component="context-tool-group-trigger" onMouseEnter={glanceAll}>
          <span
            data-slot="context-tool-group-title"
            class="min-w-0 flex items-center gap-2 text-14-medium text-text-strong"
          >
            <span data-slot="context-tool-group-label" class="shrink-0">
              <ToolStatusTitle active={pending()} activeText="Editing files" doneText="Edited files" split={false} />
            </span>
            <span
              data-slot="context-tool-group-summary"
              class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-normal text-text-base"
            >
              {count()} {count() === 1 ? "change" : "changes"}
              <Show when={fileCount() > 0}>
                {" "}
                in {fileCount()} {fileCount() === 1 ? "file" : "files"}
              </Show>
            </span>
            <Show when={diffs().length > 0}>
              <DiffChanges changes={diffs()} />
            </Show>
          </span>
          <Collapsible.Arrow />
        </div>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div data-component="context-tool-group-list">
          <Index each={props.parts}>
            {(partAccessor) => {
              const label = createMemo(() => editRowLabel(partAccessor()))
              const diff = createMemo(() => editRowDiff(partAccessor()))
              const running = createMemo(
                () => partAccessor().state.status === "pending" || partAccessor().state.status === "running",
              )
              const errored = createMemo(() => partAccessor().state.status === "error")
              return (
                <div data-slot="context-tool-group-item">
                  <div data-component="tool-trigger">
                    <div data-slot="basic-tool-tool-trigger-content">
                      <div data-slot="basic-tool-tool-info">
                        <div data-slot="basic-tool-tool-info-structured">
                          <div data-slot="basic-tool-tool-info-main">
                            <span data-slot="basic-tool-tool-title" class="font-mono">
                              <span data-pending={running() ? "true" : "false"}>{label()}</span>
                            </span>
                            <Show when={!running() && diff()}>{(d) => <DiffChanges changes={d()} />}</Show>
                            <Show when={errored()}>
                              <span data-slot="basic-tool-tool-subtitle" style={{ color: "var(--v2-state-fg-danger)" }}>
                                failed
                              </span>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )
            }}
          </Index>
        </div>
      </Collapsible.Content>
    </Collapsible>
  )
}

function UserMessageComments(props: { comments: UserMessageComment[]; bounded: boolean }) {
  const i18n = useI18n()
  const [state, setState] = createStore({ expanded: false })
  const comments = createMemo(() => (props.bounded && !state.expanded ? props.comments.slice(0, 5) : props.comments))

  return (
    <div data-slot="user-message-comments" data-bounded={props.bounded ? "true" : undefined}>
      <For each={comments()}>
        {(comment) => (
          <CommentCardV2
            comment={comment.comment}
            path={comment.path}
            selection={comment.selection}
            title={comment.comment}
            tooltip
            wide
          />
        )}
      </For>
      <Show when={props.bounded && props.comments.length > 5 && !state.expanded}>
        <ButtonV2 size="small" variant="ghost-muted" onClick={() => setState("expanded", true)}>
          {i18n.t("ui.common.showMore")}
        </ButtonV2>
      </Show>
    </div>
  )
}

export function UserMessageDisplay(props: {
  message: UserMessage
  parts: PartType[]
  actions?: UserActions
  useV2Actions?: boolean
  comments?: UserMessageComment[]
}) {
  const data = useData()
  const dialog = useDialog()
  const i18n = useI18n()
  const [state, setState] = createStore({
    copied: false,
    busy: false,
  })
  const copied = () => state.copied
  const busy = () => state.busy

  const textPart = createMemo(
    () => props.parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined,
  )

  const text = createMemo(() => textPart()?.text || "")

  const files = createMemo(() => (props.parts?.filter((p) => p.type === "file") as FilePart[]) ?? [])

  const attachments = createMemo(() => files().filter(attached))

  const messageComments = createMemo(() => (newLayout() ? (props.comments ?? []) : []))

  const inlineFiles = createMemo(() => files().filter(inline))

  const agents = createMemo(() => (props.parts?.filter((p) => p.type === "agent") as AgentPart[]) ?? [])

  const skills = createMemo(() => (props.parts?.filter((p) => p.type === "skill") as SkillPart[]) ?? [])

  const model = createMemo(() => {
    const providerID = props.message.model?.providerID
    const modelID = props.message.model?.modelID
    if (!providerID || !modelID) return ""
    const match = data.store.provider?.all?.get(providerID)
    return match?.models?.[modelID]?.name ?? modelID
  })
  const timefmt = createMemo(() => new Intl.DateTimeFormat(i18n.locale(), { timeStyle: "short" }))

  const stamp = createMemo(() => {
    const created = props.message.time?.created
    if (typeof created !== "number") return ""
    return timefmt().format(created)
  })

  const metaHead = createMemo(() => {
    const agent = props.message.agent
    const items = [agent ? agent[0]?.toUpperCase() + agent.slice(1) : "", model()]
    return items.filter((x) => !!x).join("\u00A0\u00B7\u00A0")
  })

  const metaTail = stamp

  const openImagePreview = (url: string, alt?: string) => {
    dialog.show(() => <ImagePreview src={url} alt={alt} />)
  }

  const handleCopy = async () => {
    const content = text()
    if (!content) return
    if (await writeClipboard(content)) {
      setState("copied", true)
      setTimeout(() => setState("copied", false), 2000)
    }
  }

  const revert = () => {
    const act = props.actions?.revert
    if (!act || busy()) return
    setState("busy", true)
    void Promise.resolve()
      .then(() =>
        act({
          sessionID: props.message.sessionID,
          messageID: props.message.id,
        }),
      )
      .finally(() => setState("busy", false))
  }

  const renderAttachments = () => (
    <Show when={attachments().length > 0}>
      <div data-slot="user-message-attachments">
        <For each={attachments()}>
          {(file) => {
            const type = kind(file)
            const name = file.filename ?? i18n.t("ui.message.attachment.alt")

            return (
              <Show
                when={newLayout() && type === "file"}
                fallback={
                  <div
                    data-slot="user-message-attachment"
                    data-type={type}
                    data-clickable={type === "image" ? "true" : undefined}
                    title={type === "file" ? name : undefined}
                    onClick={() => {
                      if (type === "image") openImagePreview(file.url, name)
                    }}
                  >
                    <Show
                      when={type === "image"}
                      fallback={
                        <div data-slot="user-message-attachment-file">
                          <FileIcon node={{ path: name, type: "file" }} />
                          <span data-slot="user-message-attachment-name">{name}</span>
                        </div>
                      }
                    >
                      <img data-slot="user-message-attachment-image" src={file.url} alt={name} />
                    </Show>
                  </div>
                }
              >
                <AttachmentCardV2
                  title={getFilename(name)}
                  hover={name}
                  clickable={!!props.actions?.openAttachment}
                  onClick={() => props.actions?.openAttachment?.(file)}
                >
                  {typeLabel(name, file.mime)}
                </AttachmentCardV2>
              </Show>
            )
          }}
        </For>
      </div>
    </Show>
  )

  return (
    <div data-component="user-message" data-timeline-part-id={textPart()?.id}>
      <Show when={!props.useV2Actions}>{renderAttachments()}</Show>
      <Show
        when={text() || skills().length > 0}
        fallback={
          <Show when={messageComments().length > 0}>
            <UserMessageComments comments={messageComments()} bounded={false} />
          </Show>
        }
      >
        <div data-slot="user-message-body">
          <For each={skills()}>
            {(skill) => (
              <BasicTool
                icon="brain"
                status="completed"
                trigger={
                  <div data-slot="basic-tool-tool-info-structured">
                    <div data-slot="basic-tool-tool-info-main">
                      <AmicoSkillChip kind={i18n.t("ui.tool.skill")} name={skill.name} status="completed" />
                    </div>
                  </div>
                }
              >
                <Show when={skill.content}>
                  <div class="amc-skill-file" data-component="tool-output" data-scrollable>
                    <Markdown text={skillBody(skill.content)} />
                  </div>
                </Show>
              </BasicTool>
            )}
          </For>
          <div data-slot="user-message-text" data-comments={messageComments().length > 0 ? "true" : undefined}>
            <HighlightedText text={text()} references={inlineFiles()} agents={agents()} />
            <Show when={messageComments().length > 0}>
              <UserMessageComments comments={messageComments()} bounded />
            </Show>
          </div>
        </div>
      </Show>
      <Show when={props.useV2Actions}>{renderAttachments()}</Show>
      <Show when={text() || skills().length > 0 || (props.useV2Actions && messageComments().length > 0)}>
        <div data-slot="user-message-copy-wrapper">
          <Show when={metaHead() || metaTail()}>
            <span data-slot="user-message-meta-wrap">
              <Show when={metaHead()}>
                <span data-slot="user-message-meta" class="text-12-regular text-text-weak cursor-default">
                  {metaHead()}
                </span>
              </Show>
              <Show when={metaHead() && metaTail()}>
                <span data-slot="user-message-meta-sep" class="text-12-regular text-text-weak cursor-default">
                  {"\u00A0\u00B7\u00A0"}
                </span>
              </Show>
              <Show when={metaTail()}>
                <span data-slot="user-message-meta-tail" class="text-12-regular text-text-weak cursor-default">
                  {metaTail()}
                </span>
              </Show>
            </span>
          </Show>
          <Show when={props.actions?.revert}>
            <MessageActionButton
              icon="reset"
              label={i18n.t("ui.message.revertMessage")}
              useV2={props.useV2Actions}
              disabled={!!busy()}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                revert()
              }}
              aria-label={i18n.t("ui.message.revertMessage")}
            />
          </Show>
          <Show when={text()}>
            <MessageActionButton
              icon={copied() ? "check" : "copy"}
              label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
              useV2={props.useV2Actions}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                void handleCopy()
              }}
              aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copyMessage")}
            />
          </Show>
        </div>
      </Show>
    </div>
  )
}

type HighlightSegment = { text: string; type?: "file" | "agent" }

function HighlightedText(props: { text: string; references: FilePart[]; agents: AgentPart[] }) {
  const segments = createMemo(() => {
    const text = props.text

    const allRefs: { start: number; end: number; type: "file" | "agent" }[] = [
      ...props.references
        .filter((r) => r.source?.text?.start !== undefined && r.source?.text?.end !== undefined)
        .map((r) => ({ start: r.source!.text!.start, end: r.source!.text!.end, type: "file" as const })),
      ...props.agents
        .filter((a) => a.source?.start !== undefined && a.source?.end !== undefined)
        .map((a) => ({ start: a.source!.start, end: a.source!.end, type: "agent" as const })),
    ].sort((a, b) => a.start - b.start)

    const result: HighlightSegment[] = []
    let lastIndex = 0

    for (const ref of allRefs) {
      if (ref.start < lastIndex) continue

      if (ref.start > lastIndex) {
        result.push({ text: text.slice(lastIndex, ref.start) })
      }

      result.push({ text: text.slice(ref.start, ref.end), type: ref.type })
      lastIndex = ref.end
    }

    if (lastIndex < text.length) {
      result.push({ text: text.slice(lastIndex) })
    }

    return result
  })

  return <For each={segments()}>{(segment) => <span data-highlight={segment.type}>{segment.text}</span>}</For>
}

export function Part(props: MessagePartProps) {
  const component = createMemo(() => PART_MAPPING[props.part.type])
  return (
    <Show when={component()}>
      <Dynamic
        component={component()}
        part={props.part}
        message={props.message}
        hideDetails={props.hideDetails}
        defaultOpen={props.defaultOpen}
        toolOpen={props.toolOpen}
        onToolOpenChange={props.onToolOpenChange}
        deferToolContent={props.deferToolContent}
        virtualizeDiff={props.virtualizeDiff}
        onContentRendered={props.onContentRendered}
        showAssistantCopyPartID={props.showAssistantCopyPartID}
        turnDurationMs={props.turnDurationMs}
        useV2Actions={props.useV2Actions}
        count={props.count}
      />
    </Show>
  )
}

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  sessionID?: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  virtualizeDiff?: boolean
  onContentRendered?: () => void
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>

const state: Record<
  string,
  {
    name: string
    render?: ToolComponent
  }
> = {}

export function registerTool(input: { name: string; render?: ToolComponent }) {
  state[input.name] = input
  return input
}

export function getTool(name: string) {
  return state[name === "apply_patch" ? "patch" : name === "bash" ? "shell" : name]?.render
}

export const ToolRegistry = {
  register: registerTool,
  render: getTool,
}

function ToolFileAccordion(props: { path: string; actions?: JSX.Element; children: JSX.Element }) {
  const value = createMemo(() => props.path || "tool-file")

  return (
    <Accordion
      multiple
      data-scope="apply-patch"
      style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
      defaultValue={[value()]}
    >
      <Accordion.Item value={value()}>
        <StickyAccordionHeader>
          <Accordion.Trigger>
            <div data-slot="apply-patch-trigger-content">
              <div data-slot="apply-patch-file-info">
                <FileIcon node={{ path: props.path, type: "file" }} />
                <div data-slot="apply-patch-file-name-container">
                  <Show when={props.path.includes("/")}>
                    <span data-slot="apply-patch-directory">{`\u202A${getDirectory(props.path)}\u202C`}</span>
                  </Show>
                  <span data-slot="apply-patch-filename">{getFilename(props.path)}</span>
                </div>
              </div>
              <div data-slot="apply-patch-trigger-actions">
                {props.actions}
                <Icon name="chevron-grabber-vertical" size="small" />
              </div>
            </div>
          </Accordion.Trigger>
        </StickyAccordionHeader>
        <Accordion.Content>{props.children}</Accordion.Content>
      </Accordion.Item>
    </Accordion>
  )
}

PART_MAPPING["tool"] = function ToolPartDisplay(props) {
  const data = useData()
  const i18n = useI18n()
  const part = () => props.part as ToolPart
  if (part().tool === "todowrite") return null

  const hideQuestion = createMemo(
    () => part().tool === "question" && (part().state.status === "pending" || part().state.status === "running"),
  )

  const emptyInput: Record<string, any> = {}
  const emptyMetadata: Record<string, any> = {}

  const input = () => part().state?.input ?? emptyInput
  // @ts-expect-error
  const partMetadata = () => part().state?.metadata ?? emptyMetadata
  const taskId = createMemo(() => {
    if (part().tool !== "task") return
    const value = partMetadata().sessionId
    if (typeof value === "string" && value) return value
  })
  const taskHref = createMemo(() => {
    if (part().tool !== "task") return
    return sessionLink(taskId(), data.sessionHref)
  })
  const taskSubtitle = createMemo(() => {
    if (part().tool !== "task") return undefined
    const value = input().description
    if (typeof value === "string" && value) return value
    return taskId()
  })

  // amicode: L2 renderer slot — amicode_* tools get the Amicode card (sole stock-code touch)
  const render = createMemo(() =>
    /^amicode_/.test(part().tool) ? AmicodeToolCard : (ToolRegistry.render(part().tool) ?? GenericTool),
  )
  const controlledOpen = () => (props.onToolOpenChange ? (props.toolOpen ?? props.defaultOpen) : undefined)
  const handleToolOpenChange = (open: boolean) => props.onToolOpenChange?.(open)

  // amicode: hovering the row glances at its node on the brain's map
  const brainRef = createMemo(() => amicoBrainRef(part().tool, input()))
  return (
    <Show when={!hideQuestion()}>
      <div
        data-component="tool-part-wrapper"
        data-timeline-part-id={part().id}
        onMouseEnter={() => emitAmicoBrainHover(brainRef())}
      >
        <Switch>
          <Match when={part().state.status === "error" && (part().state as any).error}>
            {(error) => {
              const cleaned = error().replace("Error: ", "")
              if (part().tool === "question" && cleaned.includes("dismissed this question")) {
                return (
                  <div style="width: 100%; display: flex; justify-content: flex-end;">
                    <span class="text-13-regular text-text-weak cursor-default">
                      {i18n.t("ui.messagePart.questions.dismissed")}
                    </span>
                  </div>
                )
              }
              return (
                <ToolErrorCard
                  tool={part().tool}
                  error={error()}
                  title={part().tool === "websearch" ? webSearchProviderLabel(partMetadata().provider) : undefined}
                  defaultOpen={props.defaultOpen}
                  open={controlledOpen()}
                  onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
                  subtitle={taskSubtitle()}
                  href={taskHref()}
                  onSubtitleClick={(event) => {
                    if (!data.navigateToSession) return
                    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
                    const id = taskId()
                    if (!id) return
                    event.preventDefault()
                    data.navigateToSession(id)
                  }}
                />
              )
            }}
          </Match>
          <Match when={true}>
            <Dynamic
              component={render()}
              input={input()}
              tool={part().tool}
              // amicode: L2 family — ask-card staleness guard needs the part's message id
              messageID={part().messageID}
              sessionID={part().sessionID}
              metadata={partMetadata()}
              // @ts-expect-error
              output={part().state.output}
              status={part().state.status}
              hideDetails={props.hideDetails}
              defaultOpen={props.defaultOpen}
              open={controlledOpen()}
              onOpenChange={props.onToolOpenChange ? handleToolOpenChange : undefined}
              deferContent={props.deferToolContent}
              virtualizeDiff={props.virtualizeDiff}
              onContentRendered={props.onContentRendered}
              // amicode: collapsed-run count (../amicode/receipt-runs.ts); only
              // AmicodeToolCard reads this, every other tool component ignores it
              count={props.count}
            />
          </Match>
        </Switch>
      </div>
    </Show>
  )
}

export function MessageDivider(props: { label: string }) {
  return (
    <div data-component="compaction-part">
      <div data-slot="compaction-part-divider">
        <span data-slot="compaction-part-line" />
        <span data-slot="compaction-part-label" class="text-12-regular text-text-weak">
          {props.label}
        </span>
        <span data-slot="compaction-part-line" />
      </div>
    </div>
  )
}

PART_MAPPING["compaction"] = function CompactionPartDisplay() {
  const i18n = useI18n()
  return <MessageDivider label={i18n.t("ui.messagePart.compaction")} />
}

PART_MAPPING["text"] = function TextPartDisplay(props) {
  const data = useData()
  const part = () => props.part as TextPart

  const streaming = createMemo(() => {
    if (props.message.role !== "assistant") return false
    const message = props.message as AssistantMessage
    // Message is complete → not streaming
    if (typeof message.time.completed === "number") return false
    // If subsequent parts exist after this text part, the model has moved on
    // (e.g. to a tool call) — the text content is finalized, flush the tail
    // so it renders before the tool row appears (#265).
    const allParts = data.store.part?.[props.message.id] ?? []
    const myIndex = allParts.findIndex((p) => p?.id === part().id)
    if (myIndex >= 0 && myIndex < allParts.length - 1) return false
    return true
  })
  const text = () => readPartText(data.store.part_text_accum_delta, part())

  return (
    <Show when={text()}>
      <div data-component="text-part" data-timeline-part-id={part().id}>
        <div data-slot="text-part-body">
          {/* Prose ALWAYS renders as chunks — each fragment Amico relays is
              its own bordered card, a message within the chat (Kate
              2026-08-25), and history must split identically so the cards
              are consistent across reloads. While streaming, only settled
              chunks show (no typing reveal, no waiting for the whole reply);
              each new chunk mounts once with its entrance, ledgered per part
              so remounts never re-animate. */}
          <ChunkedStreamMarkdown text={text()} done={!streaming()} cacheKey={part().id} />
        </div>
      </div>
    </Show>
  )
}

PART_MAPPING["reasoning"] = function ReasoningPartDisplay(props) {
  const data = useData()
  const part = () => props.part as ReasoningPart
  const streaming = createMemo(
    () => props.message.role === "assistant" && typeof (props.message as AssistantMessage).time.completed !== "number",
  )
  const text = () => readPartText(data.store.part_text_accum_delta, part())

  return (
    <Show when={text()}>
      <div data-component="reasoning-part" data-timeline-part-id={part().id}>
        <Show when={streaming()} fallback={<Markdown text={text()} cacheKey={part().id} streaming={false} />}>
          <PacedMarkdown text={text()} cacheKey={part().id} streaming={streaming()} />
        </Show>
      </div>
    </Show>
  )
}

// AMICODE: the filename in an edit/write trigger opens the file in the editor
// via the bridge (the chat iframe can't). stopPropagation so the tool body's
// expand/collapse doesn't fire alongside.
function OpenableFilename(props: { filename: string; path: string }) {
  return (
    <Show when={props.path} fallback={<span data-slot="message-part-title-filename">{props.filename}</span>}>
      <button
        type="button"
        data-slot="message-part-title-filename"
        data-clickable="true"
        title={props.path}
        onClick={(event) => {
          event.preventDefault()
          event.stopPropagation()
          openFileInEditor(props.path)
        }}
      >
        {props.filename}
      </button>
    </Show>
  )
}

ToolRegistry.register({
  name: "read",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.offset) args.push("offset=" + props.input.offset)
    if (props.input.limit) args.push("limit=" + props.input.limit)
    const loaded = createMemo(() => {
      if (props.status !== "completed") return []
      const value = props.metadata.loaded
      if (!value || !Array.isArray(value)) return []
      return value.filter((p): p is string => typeof p === "string")
    })
    return (
      <>
        <BasicTool
          {...props}
          icon="glasses"
          trigger={{
            title: i18n.t("ui.tool.read"),
            subtitle: props.input.filePath ? getFilename(props.input.filePath) : "",
            args,
          }}
        />
        <For each={loaded()}>
          {(filepath) => (
            <button
              type="button"
              data-component="tool-loaded-file"
              data-clickable="true"
              title={filepath}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                openFileInEditor(filepath)
              }}
            >
              <Icon name="enter" size="small" />
              <span>
                {i18n.t("ui.tool.loaded")} {relativizeProjectPath(filepath, data.directory)}
              </span>
            </button>
          )}
        </For>
      </>
    )
  },
})

ToolRegistry.register({
  name: "list",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="bullet-list"
        trigger={{ title: i18n.t("ui.tool.list"), subtitle: getDirectory(props.input.path || "/") }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "glob",
  render(props) {
    const i18n = useI18n()
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.glob"),
          subtitle: getDirectory(props.input.path || "/"),
          args: props.input.pattern ? ["pattern=" + props.input.pattern] : [],
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "grep",
  render(props) {
    const i18n = useI18n()
    const args: string[] = []
    if (props.input.pattern) args.push("pattern=" + props.input.pattern)
    if (props.input.include) args.push("include=" + props.input.include)
    return (
      <BasicTool
        {...props}
        icon="magnifying-glass-menu"
        trigger={{
          title: i18n.t("ui.tool.grep"),
          subtitle: getDirectory(props.input.path || "/"),
          args,
        }}
      >
        <Show when={props.output}>
          <div
            data-component="tool-output"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <Markdown text={props.output!} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "webfetch",
  render(props) {
    const i18n = useI18n()
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const url = createMemo(() => {
      const value = props.input.url
      if (typeof value !== "string") return ""
      return value
    })
    return (
      <BasicTool
        {...props}
        hideDetails
        icon="window-cursor"
        trigger={
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <span data-pending={pending() ? "true" : "false"}>{i18n.t("ui.tool.webfetch")}</span>
              </span>
              <Show when={!pending() && url()}>
                <a
                  data-slot="basic-tool-tool-subtitle"
                  class="clickable subagent-link"
                  href={url()}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => event.stopPropagation()}
                >
                  {url()}
                </a>
              </Show>
            </div>
            <Show when={!pending() && url()}>
              <div data-component="tool-action">
                <Icon name="square-arrow-top-right" size="small" />
              </div>
            </Show>
          </div>
        }
      />
    )
  },
})

ToolRegistry.register({
  name: "websearch",
  render(props) {
    const query = createMemo(() => {
      const value = props.input.query
      if (typeof value !== "string") return ""
      return value
    })
    const title = createMemo(() => webSearchProviderLabel(props.metadata.provider))

    return (
      <BasicTool
        {...props}
        icon="window-cursor"
        trigger={{
          title: title(),
          subtitle: query(),
          subtitleClass: "exa-tool-query",
        }}
      >
        <ExaOutput output={props.output} />
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "task",
  render(props) {
    const data = useData()
    const i18n = useI18n()
    const childSessionId = createMemo(() => {
      const value = props.metadata.sessionId
      if (typeof value === "string" && value) return value
      return taskSession(props.input, data.sessionID, data.store.session, data.store.agent)
    })
    const agent = createMemo(() => taskAgent(props.input.subagent_type, data.store.agent))
    const title = createMemo(() => agent().name ?? i18n.t("ui.tool.agent.default"))
    const tone = createMemo(() => agent().color)
    const v2Tone = createMemo(() => agent().v2Color)
    const subtitle = createMemo(() => {
      const value =
        typeof props.input.description === "string" && props.input.description
          ? props.input.description
          : childSessionId()
      if (!value) return value
      if (props.metadata.background === true) return `${value} (background)`
      return value
    })
    const running = createMemo(() => props.status === "pending" || props.status === "running")

    const href = createMemo(() => sessionLink(childSessionId(), data.sessionHref))
    const clickable = createMemo(() => !!(childSessionId() && (data.navigateToSession || href())))

    const open = () => {
      const id = childSessionId()
      if (!id) return
      data.navigateToSession?.(id)
    }

    const navigate = (event: MouseEvent) => {
      if (!data.navigateToSession) return
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      open()
    }
    const navigateKey = (event: KeyboardEvent) => {
      if (!clickable() || href()) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      open()
    }

    const trigger = () => (
      <div
        data-component="task-tool-card"
        style={{
          "--task-agent-color": v2Tone(),
          "--task-agent-legacy-color": tone(),
        }}
      >
        <div data-component="task-tool-surface">
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <Show
                when={running()}
                fallback={
                  <Show when={newLayout()}>
                    <span data-component="task-tool-icon">
                      <Icon name="subagent" size="small" />
                    </span>
                  </Show>
                }
              >
                <span data-component="task-tool-spinner" style={{ color: tone() ?? "var(--icon-interactive-base)" }}>
                  {/* amicode: H-glyph at the legacy spinner site (patch #10 sweep);
                      SessionProgressIndicatorV2 kept for the v2 task card */}
                  <Show when={newLayout()} fallback={<AmicoSpinner style={{ width: "16px", height: "14px" }} />}>
                    <SessionProgressIndicatorV2
                      style={{ color: v2Tone() ?? "light-dark(var(--v2-text-text-base), #ffffff)" }}
                    />
                  </Show>
                </span>
              </Show>
              <span data-component="task-tool-title">{title()}</span>
              <Show when={subtitle()}>
                <span data-slot="basic-tool-tool-subtitle">{subtitle()}</span>
              </Show>
            </div>
          </div>
        </div>
        <Show when={clickable()}>
          <div data-component="task-tool-action">
            <Icon name="square-arrow-top-right" size="small" />
          </div>
        </Show>
      </div>
    )

    return (
      <BasicTool
        icon="task"
        status={props.status}
        trigger={trigger()}
        hideDetails
        triggerAsLink
        triggerHref={href()}
        clickable={clickable()}
        onTriggerClick={navigate}
        onTriggerKeyDown={navigateKey}
      />
    )
  },
})

ToolRegistry.register({
  name: "shell",
  render(props) {
    const i18n = useI18n()
    const pending = () => props.status === "pending" || props.status === "running"
    const sawPending = pending()
    const text = createMemo(() => {
      const cmd = props.input.command ?? props.metadata.command ?? ""
      const out = stripAnsi(props.output || props.metadata.output || "").replace(/\r\n?/g, "\n")
      return `$ ${cmd}${out ? "\n\n" + out : ""}`
    })
    const [copied, setCopied] = createSignal(false)

    const handleCopy = async () => {
      const content = text()
      if (!content) return
      if (await writeClipboard(content)) {
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }
    }

    return (
      <BasicTool
        {...props}
        icon="console"
        allowOpenWhilePending
        trigger={(open) => (
          <div data-slot="basic-tool-tool-info-structured">
            <div data-slot="basic-tool-tool-info-main">
              <span data-slot="basic-tool-tool-title">
                <span data-pending={pending() ? "true" : "false"}>{i18n.t("ui.tool.shell")}</span>
              </span>
              <Show when={!open() && props.input.command}>
                <ShellSubmessage text={props.input.command} animate={sawPending} />
              </Show>
            </div>
          </div>
        )}
      >
        <div data-component="bash-output">
          <div data-slot="bash-copy">
            <TooltipV2 value={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")} placement="top">
              <IconButtonV2
                icon={<IconV2 name={copied() ? "check" : "outline-copy"} size="small" />}
                size="normal"
                variant="ghost-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleCopy}
                aria-label={copied() ? i18n.t("ui.message.copied") : i18n.t("ui.message.copy")}
              />
            </TooltipV2>
          </div>
          <div
            data-slot="bash-scroll"
            data-scrollable
            tabIndex={0}
            role="region"
            aria-label={i18n.t("ui.scrollView.ariaLabel")}
          >
            <pre data-slot="bash-pre">
              <code>{text()}</code>
            </pre>
          </div>
        </div>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "edit",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.metadata?.filediff?.file || props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    const diffSource = createMemo(
      () => {
        const filediff = props.metadata?.filediff
        if (!filediff) return
        return {
          file: filediff.file || props.input.filePath || "",
          patch: typeof filediff.patch === "string" ? filediff.patch : undefined,
          before: typeof filediff.before === "string" ? filediff.before : undefined,
          after: typeof filediff.after === "string" ? filediff.after : undefined,
        }
      },
      undefined,
      {
        equals: (a, b) =>
          a?.file === b?.file && a?.patch === b?.patch && a?.before === b?.before && a?.after === b?.after,
      },
    )

    const fileCompProps = createMemo(() => {
      try {
        const source = diffSource()
        if (source) {
          const fileDiff = resolveFileDiff(source)
          if (fileDiff) return { fileDiff, hunkSeparators: fileDiff.isPartial ? "simple" : "line-info-basic" }
        }
      } catch {}

      return {
        before: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.before || props.input.oldString || "",
        },
        after: {
          name: props.metadata?.filediff?.file || props.input.filePath,
          contents: props.metadata?.filediff?.after || props.input.newString || "",
        },
      }
    })

    return (
      <div data-component="edit-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="edit-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <span data-pending={pending() ? "true" : "false"}>{i18n.t("ui.messagePart.title.edit")}</span>
                  </span>
                  <Show when={!pending()}>
                    <OpenableFilename filename={filename()} path={path()} />
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff} />
                </Show>
              </div>
            </div>
          }
        >
          <Show when={path()}>
            <ToolFileAccordion
              path={path()}
              actions={
                <Show when={!pending() && props.metadata.filediff}>
                  <DiffChanges changes={props.metadata.filediff!} />
                </Show>
              }
            >
              <div data-component="edit-content">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  onRendered={props.onContentRendered}
                  {...fileCompProps()}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "write",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const diagnostics = createMemo(() => getDiagnostics(props.metadata.diagnostics, props.input.filePath))
    const path = createMemo(() => props.input.filePath || "")
    const filename = () => getFilename(props.input.filePath ?? "")
    const pending = () => props.status === "pending" || props.status === "running"
    return (
      <div data-component="write-tool">
        <BasicTool
          {...props}
          icon="code-lines"
          defer={props.deferContent !== false}
          trigger={
            <div data-component="write-trigger">
              <div data-slot="message-part-title-area">
                <div data-slot="message-part-title">
                  <span data-slot="message-part-title-text">
                    <span data-pending={pending() ? "true" : "false"}>{i18n.t("ui.messagePart.title.write")}</span>
                  </span>
                  <Show when={!pending()}>
                    <OpenableFilename filename={filename()} path={path()} />
                  </Show>
                </div>
                <Show when={!pending() && props.input.filePath?.includes("/")}>
                  <div data-slot="message-part-path">
                    <span data-slot="message-part-directory">{getDirectory(props.input.filePath!)}</span>
                  </div>
                </Show>
              </div>
              <div data-slot="message-part-actions">{/* <DiffChanges diff={diff} /> */}</div>
            </div>
          }
        >
          <Show when={props.input.content && path()}>
            <ToolFileAccordion path={path()}>
              <div data-component="write-content">
                <Dynamic
                  component={fileComponent}
                  mode="text"
                  file={{
                    name: props.input.filePath,
                    contents: props.input.content,
                    cacheKey: checksum(props.input.content),
                  }}
                  overflow="scroll"
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </Show>
          <DiagnosticsDisplay diagnostics={diagnostics()} />
        </BasicTool>
      </div>
    )
  },
})

ToolRegistry.register({
  name: "patch",
  render(props) {
    const i18n = useI18n()
    const fileComponent = useFileComponent()
    const files = createMemo(() => patchFiles(props.metadata.files))
    const pending = createMemo(() => props.status === "pending" || props.status === "running")
    const single = createMemo(() => {
      const list = files()
      if (list.length !== 1) return
      return list[0]
    })
    const [expanded, setExpanded] = createSignal<string[]>([])
    let seeded = false

    createEffect(() => {
      const list = files()
      if (list.length === 0) return
      if (seeded) return
      seeded = true
      setExpanded(list.filter((f) => f.type !== "delete").map((f) => f.filePath))
    })

    const subtitle = createMemo(() => {
      const count = files().length
      if (count === 0) return ""
      return `${count} ${i18n.t(count > 1 ? "ui.common.file.other" : "ui.common.file.one")}`
    })

    return (
      <Show
        when={single()}
        fallback={
          <div data-component="apply-patch-tool">
            <BasicTool
              {...props}
              icon="code-lines"
              defer={props.deferContent !== false}
              trigger={{
                title: i18n.t("ui.tool.patch"),
                subtitle: subtitle(),
              }}
            >
              <Show when={files().length > 0}>
                <Accordion
                  multiple
                  data-scope="apply-patch"
                  style={{ "--sticky-accordion-offset": "calc(32px + var(--tool-content-gap))" }}
                  value={expanded()}
                  onChange={(value) => setExpanded(Array.isArray(value) ? value : value ? [value] : [])}
                >
                  <For each={files()}>
                    {(file) => {
                      const active = createMemo(() => expanded().includes(file.filePath))
                      const [visible, setVisible] = createSignal(false)

                      createEffect(() => {
                        if (!active()) {
                          setVisible(false)
                          return
                        }

                        requestAnimationFrame(() => {
                          if (!active()) return
                          setVisible(true)
                        })
                      })

                      return (
                        <Accordion.Item value={file.filePath} data-type={file.type}>
                          <StickyAccordionHeader>
                            <Accordion.Trigger>
                              <div data-slot="apply-patch-trigger-content">
                                <div data-slot="apply-patch-file-info">
                                  <FileIcon node={{ path: file.relativePath, type: "file" }} />
                                  <div data-slot="apply-patch-file-name-container">
                                    <Show when={file.relativePath.includes("/")}>
                                      <span data-slot="apply-patch-directory">{`\u202A${getDirectory(file.relativePath)}\u202C`}</span>
                                    </Show>
                                    <span data-slot="apply-patch-filename">{getFilename(file.relativePath)}</span>
                                  </div>
                                </div>
                                <div data-slot="apply-patch-trigger-actions">
                                  <Switch>
                                    <Match when={file.type === "add"}>
                                      <span data-slot="apply-patch-change" data-type="added">
                                        {i18n.t("ui.patch.action.created")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "delete"}>
                                      <span data-slot="apply-patch-change" data-type="removed">
                                        {i18n.t("ui.patch.action.deleted")}
                                      </span>
                                    </Match>
                                    <Match when={file.type === "move"}>
                                      <span data-slot="apply-patch-change" data-type="modified">
                                        {i18n.t("ui.patch.action.moved")}
                                      </span>
                                    </Match>
                                    <Match when={true}>
                                      <DiffChanges changes={{ additions: file.additions, deletions: file.deletions }} />
                                    </Match>
                                  </Switch>
                                  <Icon name="chevron-grabber-vertical" size="small" />
                                </div>
                              </div>
                            </Accordion.Trigger>
                          </StickyAccordionHeader>
                          <Accordion.Content>
                            <Show when={props.deferContent === false || visible()}>
                              <div data-component="apply-patch-file-diff">
                                <Dynamic
                                  component={fileComponent}
                                  mode="diff"
                                  virtualize={props.virtualizeDiff}
                                  fileDiff={file.view.fileDiff}
                                  hunkSeparators={file.view.fileDiff.isPartial ? "simple" : "line-info-basic"}
                                  onRendered={props.onContentRendered}
                                />
                              </div>
                            </Show>
                          </Accordion.Content>
                        </Accordion.Item>
                      )
                    }}
                  </For>
                </Accordion>
              </Show>
            </BasicTool>
          </div>
        }
      >
        <div data-component="apply-patch-tool">
          <BasicTool
            {...props}
            icon="code-lines"
            defer={props.deferContent !== false}
            trigger={
              <div data-component="edit-trigger">
                <div data-slot="message-part-title-area">
                  <div data-slot="message-part-title">
                    <span data-slot="message-part-title-text">
                      <span data-pending={pending() ? "true" : "false"}>{i18n.t("ui.tool.patch")}</span>
                    </span>
                    <Show when={!pending()}>
                      <span data-slot="message-part-title-filename">{getFilename(single()!.relativePath)}</span>
                    </Show>
                  </div>
                  <Show when={!pending() && single()!.relativePath.includes("/")}>
                    <div data-slot="message-part-path">
                      <span data-slot="message-part-directory">{getDirectory(single()!.relativePath)}</span>
                    </div>
                  </Show>
                </div>
                <div data-slot="message-part-actions">
                  <Show when={!pending()}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Show>
                </div>
              </div>
            }
          >
            <ToolFileAccordion
              path={single()!.relativePath}
              actions={
                <Switch>
                  <Match when={single()!.type === "add"}>
                    <span data-slot="apply-patch-change" data-type="added">
                      {i18n.t("ui.patch.action.created")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "delete"}>
                    <span data-slot="apply-patch-change" data-type="removed">
                      {i18n.t("ui.patch.action.deleted")}
                    </span>
                  </Match>
                  <Match when={single()!.type === "move"}>
                    <span data-slot="apply-patch-change" data-type="modified">
                      {i18n.t("ui.patch.action.moved")}
                    </span>
                  </Match>
                  <Match when={true}>
                    <DiffChanges changes={{ additions: single()!.additions, deletions: single()!.deletions }} />
                  </Match>
                </Switch>
              }
            >
              <div data-component="apply-patch-file-diff">
                <Dynamic
                  component={fileComponent}
                  mode="diff"
                  virtualize={props.virtualizeDiff}
                  fileDiff={single()!.view.fileDiff}
                  onRendered={props.onContentRendered}
                />
              </div>
            </ToolFileAccordion>
          </BasicTool>
        </div>
      </Show>
    )
  },
})

ToolRegistry.register({
  name: "todowrite",
  render(props) {
    const i18n = useI18n()
    const todos = createMemo(() => {
      const meta = props.metadata?.todos
      if (Array.isArray(meta)) return meta

      const input = props.input.todos
      if (Array.isArray(input)) return input

      return []
    })

    const subtitle = createMemo(() => {
      const list = todos()
      if (list.length === 0) return ""
      return `${list.filter((t: Todo) => t.status === "completed").length}/${list.length}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen
        icon="checklist"
        trigger={{
          title: i18n.t("ui.tool.todos"),
          subtitle: subtitle(),
        }}
      >
        <Show when={todos().length}>
          <div data-component="todos">
            <For each={todos()}>
              {(todo: Todo) => (
                <Checkbox readOnly checked={todo.status === "completed"}>
                  <span
                    data-slot="message-part-todo-content"
                    data-completed={todo.status === "completed" ? "completed" : undefined}
                  >
                    {todo.content}
                  </span>
                </Checkbox>
              )}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "question",
  render(props) {
    const i18n = useI18n()
    const questions = createMemo(() => (props.input.questions ?? []) as QuestionInfo[])
    const answers = createMemo(() => (props.metadata.answers ?? []) as QuestionAnswer[])
    const completed = createMemo(() => answers().length > 0)

    const subtitle = createMemo(() => {
      const count = questions().length
      if (count === 0) return ""
      if (completed()) return i18n.t("ui.question.subtitle.answered", { count })
      return `${count} ${i18n.t(count > 1 ? "ui.common.question.other" : "ui.common.question.one")}`
    })

    return (
      <BasicTool
        {...props}
        defaultOpen={completed()}
        icon="bubble-5"
        trigger={{
          title: i18n.t("ui.tool.questions"),
          subtitle: subtitle(),
        }}
      >
        <Show when={completed()}>
          <div data-component="question-answers">
            <For each={questions()}>
              {(q, i) => {
                const answer = () => answers()[i()] ?? []
                return (
                  <div data-slot="question-answer-item">
                    <div data-slot="question-text">{q.question}</div>
                    <div data-slot="answer-text">{answer().join(", ") || i18n.t("ui.question.answer.none")}</div>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </BasicTool>
    )
  },
})

ToolRegistry.register({
  name: "skill",
  render(props) {
    const i18n = useI18n()
    // AMICODE: label the kind, then name it. `ui.tool.skill` used to be reachable only as a
    // fallback for a missing input.name — which never happens — so an activated skill rendered
    // as a bare word ("brainstorming") indistinguishable from any other tool. The kind now
    // always renders, with the skill's own name beside it.
    const name = createMemo(() => props.input.name?.trim() || "")
    const body = createMemo(() => skillBody(props.output))
    // AMICODE: the skill tool result carries its base dir in metadata — the chip
    // links to the SKILL.md source file (opens in the editor via the bridge).
    const skillPath = createMemo(() => {
      const dir = props.metadata?.dir
      return typeof dir === "string" && dir !== "" ? `${dir}/SKILL.md` : undefined
    })

    const trigger = () => (
      <div data-slot="basic-tool-tool-info-structured">
        <div data-slot="basic-tool-tool-info-main">
          <AmicoSkillChip kind={i18n.t("ui.tool.skill")} name={name()} status={props.status} path={skillPath()} />
        </div>
      </div>
    )

    return (
      <BasicTool icon="brain" status={props.status} trigger={trigger()}>
        <Show when={body()}>
          {/* AMICODE: an opened skill is a FILE, not more conversation. tool-output carries no
              surface of its own, so the instructions flowed as bare prose; amc-skill-file gives
              them a bounded, tinted panel. The chip above stays flush with the other Amico chips
              — shared left alignment is the transcript's spine, and indenting the row broke it. */}
          <div class="amc-skill-file" data-component="tool-output" data-scrollable>
            <Markdown text={body()} />
          </div>
        </Show>
      </BasicTool>
    )
  },
})

import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import type { SelectedLineRange } from "@pierre/diffs"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { mediaKindFromPath } from "../../pierre/media"
import { cloneSelectedLineRange, previewSelectedLines } from "../../pierre/selection-bridge"
import { copyTextToClipboard } from "../../util/clipboard"
import type { FileContent, SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Dynamic } from "solid-js/web"
import { normalize, text, type ViewDiff } from "../../components/session-diff"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "../../components/session-review"
import type { SessionReviewExpandMode } from "./session-review-v2"
import { createLineCommentControllerV2 } from "./line-comment-annotations-v2"
import { shouldVirtualizeReviewDiff } from "./session-review-file-preview-v2-virtualize"
import { LineCommentV2OverflowIcon } from "@opencode-ai/ui/v2/line-comment-v2"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { EditableDiffView } from "./editable-diff-view"
import type { DiffEditorHandle } from "./editable-diff-view-core"
import { Markdown } from "../../components/markdown"
import { preprocessMarkdown } from "./markdown-utils"
import "./session-review-v2.css"

type ReviewDiff = (SnapshotFileDiff & { file: string }) | FileDiffInfo | VcsFileDiff

export type SessionReviewFilePreviewV2Props = {
  file: string
  diff: ReviewDiff
  diffStyle: SessionReviewDiffStyle
  expandMode?: SessionReviewExpandMode
  readFile?: (path: string) => Promise<FileContent | undefined>
  filePicker?: (pickerProps: { onSelect: (path: string) => void }) => JSX.Element
  onSelectFile?: (file: string) => void
  onRefresh?: () => void
  /** Server base URL for /file/write saves. */
  serverUrl?: string
  /** Write a file to disk via the SDK (handles auth). */
  writeFile?: (path: string, content: string) => Promise<void>
  /** Whether the agent is currently busy (locks editing). */
  isAgentBusy?: boolean
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
}

function statusLabel(status: ViewDiff["status"]) {
  if (status === "added") return "A"
  if (status === "deleted") return "D"
  return "M"
}

function statusTooltip(status: ViewDiff["status"]) {
  if (status === "added") return "Added"
  if (status === "deleted") return "Deleted"
  return "Modified"
}

function statusType(status: ViewDiff["status"]) {
  if (status === "added") return "added"
  if (status === "deleted") return "deleted"
  return "modified"
}

function selectionSide(range: SelectedLineRange) {
  return range.endSide ?? range.side ?? "additions"
}

function selectionPreview(diff: ViewDiff, range: SelectedLineRange) {
  const side = selectionSide(range)
  const contents = text(diff, side)
  if (contents.length === 0) return undefined
  return previewSelectedLines(contents, range)
}

function ReviewCommentMenuV2(props: {
  labels: SessionReviewCommentActions
  onEdit: VoidFunction
  onDelete: VoidFunction
}) {
  return (
    <div onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      <MenuV2 gutter={4}>
        <MenuV2.Trigger
          as="button"
          type="button"
          data-slot="line-comment-v2-overflow"
          aria-label={props.labels.moreLabel}
        >
          <LineCommentV2OverflowIcon />
        </MenuV2.Trigger>
        <MenuV2.Portal>
          <MenuV2.Content>
            <MenuV2.Item onSelect={props.onEdit}>{props.labels.editLabel}</MenuV2.Item>
            <MenuV2.Item onSelect={props.onDelete}>{props.labels.deleteLabel}</MenuV2.Item>
          </MenuV2.Content>
        </MenuV2.Portal>
      </MenuV2>
    </div>
  )
}

export function SessionReviewFilePreviewV2(props: SessionReviewFilePreviewV2Props) {
  const i18n = useI18n()
  const fileComponent = useFileComponent()
  let scrollRef: HTMLDivElement | undefined
  let editorHandle: DiffEditorHandle | null = null
  let focusToken = 0

  const [store, setStore] = createStore({
    selection: null as SelectedLineRange | null,
    commenting: null as SelectedLineRange | null,
    opened: null as string | null,
  })

  const view = createMemo(() => ({
    ...normalize(props.diff),
    preloaded: "preloaded" in props.diff ? props.diff.preloaded : undefined,
  }))
  const diffCanRender = createMemo(() => view().additions !== 0 || view().deletions !== 0)
  const mediaKind = createMemo(() => mediaKindFromPath(props.file))
  const comments = createMemo(() => (props.comments ?? []).filter((comment) => comment.file === props.file))
  const commentedLines = createMemo(() => comments().map((comment) => comment.selection))
  const lineCommentsEnabled = () => props.onLineComment != null

  const commentsUi = createLineCommentControllerV2<SessionReviewComment>({
    comments,
    label: i18n.t("ui.lineComment.submit"),
    draftKey: () => props.file,
    state: {
      opened: () => store.opened,
      setOpened: (id) => setStore("opened", id),
      selected: () => store.selection,
      setSelected: (range) => setStore("selection", range),
      commenting: () => store.commenting,
      setCommenting: (range) => setStore("commenting", range),
    },
    getSide: selectionSide,
    onSubmit: ({ comment, selection }) => {
      props.onLineComment?.({
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(view(), selection),
      })
    },
    onUpdate: ({ id, comment, selection }) => {
      props.onLineCommentUpdate?.({
        id,
        file: props.file,
        selection,
        comment,
        preview: selectionPreview(view(), selection),
      })
    },
    onDelete: (comment) => {
      props.onLineCommentDelete?.({
        id: comment.id,
        file: props.file,
      })
    },
    editSubmitLabel: props.lineCommentActions?.saveLabel,
    renderCommentActions: props.lineCommentActions
      ? (comment, controls) => (
          <ReviewCommentMenuV2 labels={props.lineCommentActions!} onEdit={controls.edit} onDelete={controls.remove} />
        )
      : undefined,
  })

  onCleanup(() => {
    focusToken++
  })

  createEffect(() => {
    const focus = props.focusedComment
    if (!focus) return
    if (focus.file !== props.file) {
      // The focused file has no mounted preview (e.g. not in the current diff
      // set); clear the focus anyway so it cannot hijack a later diff refresh.
      // V1 clears unconditionally the same way.
      untrack(() => {
        const token = focusToken
        requestAnimationFrame(() => {
          if (token !== focusToken) return
          props.onFocusedCommentChange?.(null)
        })
      })
      return
    }

    untrack(() => {
      setStore("opened", focus.id)

      const comment = (props.comments ?? []).find((item) => item.file === focus.file && item.id === focus.id)
      if (comment) setStore("selection", cloneSelectedLineRange(comment.selection))

      // The diff renders asynchronously, so poll for the comment anchor before
      // scrolling; clear the focus once handled so revisiting the file does not
      // re-open a stale comment (mirrors the v1 review behavior).
      focusToken++
      const token = focusToken
      const scrollTo = (attempt: number) => {
        if (token !== focusToken) return
        const anchor = scrollRef?.querySelector(`[data-comment-id="${focus.id}"]`)
        if (anchor instanceof HTMLElement) {
          anchor.scrollIntoView({ block: "center" })
          return
        }
        if (attempt >= 120) return
        requestAnimationFrame(() => scrollTo(attempt + 1))
      }
      requestAnimationFrame(() => scrollTo(0))
      requestAnimationFrame(() => {
        if (token !== focusToken) return
        props.onFocusedCommentChange?.(null)
      })
    })
  })

  const expandUnchanged = () => props.expandMode === "expand"

  // ─── Save logic (explicit Cmd/Ctrl+S only, no autosave — #837) ───────────

  type SaveStatus = "idle" | "saving" | "error"
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>("idle")
  let errorTimer: ReturnType<typeof setTimeout> | undefined
  let latestContent: string | null = null
  let contentAtSaveTime: string | null = null
  const isPreviewMd = () => props.diffStyle === "preview" && /\.md$/i.test(props.file)
  const isDeleted = () => view().status === "deleted"
  const isEditable = () => !isPreviewMd() && !isDeleted()
  const isReadOnly = () => !isEditable()

  // ─── Zoom state (preview mode only) ────────────────────────────────────
  const [zoom, setZoom] = createSignal(100)
  const zoomIn = () => setZoom((z) => Math.min(z + 10, 500))
  const zoomOut = () => setZoom((z) => Math.max(z - 10, 50))
  const onZoomChange = (value: number) => setZoom(Math.round(Math.min(Math.max(value, 50), 500)))

  // ─── Auto-hide zoom pill on idle ──────────────────────────────────────
  // Pill starts visible (initial reveal), then fades after 2s of no mouse
  // activity. Mouse movement/enter on the preview area resets the timer.
  // Hovering over the pill itself pauses the timer.
  const [showZoomPill, setShowZoomPill] = createSignal(true)
  let zoomIdleTimer: ReturnType<typeof setTimeout> | undefined
  let pillHovered = false

  const startZoomIdleTimer = () => {
    if (zoomIdleTimer) clearTimeout(zoomIdleTimer)
    zoomIdleTimer = setTimeout(() => {
      if (!pillHovered) setShowZoomPill(false)
    }, 2000)
  }

  const handlePreviewMouseEnter = () => {
    setShowZoomPill(true)
    startZoomIdleTimer()
  }
  const handlePreviewMouseMove = () => {
    if (!showZoomPill()) setShowZoomPill(true)
    startZoomIdleTimer()
  }
  const handlePreviewMouseLeave = () => {
    if (zoomIdleTimer) clearTimeout(zoomIdleTimer)
    if (!pillHovered) setShowZoomPill(false)
  }
  const handlePillMouseEnter = () => {
    pillHovered = true
    if (zoomIdleTimer) clearTimeout(zoomIdleTimer)
  }
  const handlePillMouseLeave = () => {
    pillHovered = false
    startZoomIdleTimer()
  }

  // Start the initial auto-hide timer
  startZoomIdleTimer()

  // ─── Pinch / wheel zoom ──────────────────────────────────────────────
  // Trackpad pinch fires as WheelEvent with ctrlKey: true in Chromium.
  // Shift+scroll is the mouse-wheel equivalent. Both trigger continuous
  // zoom. Must use addEventListener with passive: false to preventDefault.
  let previewWrapperRef: HTMLDivElement | undefined

  const handleWheelZoom = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.shiftKey) return   // normal scroll — pass through
    e.preventDefault()
    const delta = e.deltaY || e.deltaX
    if (delta === 0) return
    const oldZoom = zoom()
    const factor = Math.exp(-delta * 0.003)
    const next = Math.round(Math.min(Math.max(oldZoom * factor, 50), 500))
    if (next === oldZoom) return
    onZoomChange(next)
    setShowZoomPill(true)
    startZoomIdleTimer()
  }

  createEffect(() => {
    const el = previewWrapperRef
    if (!el) return
    el.addEventListener("wheel", handleWheelZoom, { passive: false })
    onCleanup(() => el.removeEventListener("wheel", handleWheelZoom))
  })

  /** Write a file to disk via the SDK-based writeFile prop. */
  const saveFile = (path: string, content: string) => {
    if (!props.writeFile) return

    setSaveStatus("saving")
    props.writeFile(path, content)
      .then(() => {
        // Race guard: only clear dirty state if no edits arrived during the save
        if (latestContent === contentAtSaveTime) {
          setHasEdits(false)
        }
        setSaveStatus("idle")
        props.onRefresh?.()
      })
      .catch(() => {
        setSaveStatus("error")
        if (errorTimer) clearTimeout(errorTimer)
        errorTimer = setTimeout(() => setSaveStatus("idle"), 2000)
      })
  }

  /** Cmd/Ctrl+S handler — explicit save with race guard. */
  const handleImmediateSave = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault()
      if (!hasEdits() || latestContent === null) return
      contentAtSaveTime = latestContent
      saveFile(props.file, contentAtSaveTime)
    }
  }

  onCleanup(() => {
    if (errorTimer) clearTimeout(errorTimer)
    // Safety net: save on unmount if the user has unsaved edits (file switch)
    if (hasEdits() && latestContent !== null) {
      props.writeFile?.(props.file, latestContent).catch(() => {})
    }
  })

  // ─── Revert + concurrent edit detection (#770) ───────────────────────────

  const [hasEdits, setHasEdits] = createSignal(false)
  const [externalChange, setExternalChange] = createSignal(false)
  let prevDiffRef: string | null = null

  // Track when user makes edits — updates dirty state only, no save trigger
  const handleChangeWithTracking = (content: string) => {
    if (isReadOnly()) return
    setHasEdits(true)
    latestContent = content
  }

  // Detect external changes (agent modifying the same file)
  createEffect(() => {
    const currentDiff = JSON.stringify(view().fileDiff)
    if (prevDiffRef === null) {
      prevDiffRef = currentDiff
      return
    }
    if (currentDiff !== prevDiffRef) {
      prevDiffRef = currentDiff
      if (hasEdits()) {
        setExternalChange(true)
      }
    }
  })

  const handleReload = () => {
    setExternalChange(false)
    setHasEdits(false)
    // The editor will re-render with updated props
  }

  const handleKeep = () => {
    setExternalChange(false)
    // User keeps their edits — original reference stays at initial value
  }

  const handleRevert = () => {
    if (!props.writeFile) return
    const original = text(view(), "additions")

    setSaveStatus("saving")
    props.writeFile(props.file, original)
      .then(() => {
        editorHandle?.revert(original)
        setSaveStatus("idle")
        setHasEdits(false)
        latestContent = null
        props.onRefresh?.()
      })
      .catch(() => {
        setSaveStatus("error")
        if (errorTimer) clearTimeout(errorTimer)
        errorTimer = setTimeout(() => setSaveStatus("idle"), 2000)
      })
  }

  // ─── Diff viewer (CM6 EditableDiffView or legacy fallback for D files) ──
  //
  // IMPORTANT: diffViewer is called as {diffViewer()} inside a <Show>, which
  // makes it a reactive computation in SolidJS. If the function body reads
  // signals directly (view(), props.diffStyle), any change to those signals
  // re-runs the ENTIRE function, destroying and recreating the DOM tree —
  // including EditableDiffView, which loses scroll position and editor state.
  //
  // To prevent this, all branching uses declarative <Show> instead of
  // imperative if/else. The function runs ONCE, returns a single JSX tree,
  // and SolidJS patches it in-place when reactive values update. The
  // EditableDiffView stays mounted across view() changes; its internal
  // createEffect only fires when the actual text content changes.

  const fileExtension = () => {
    const parts = props.file.split(".")
    return parts.length > 1 ? parts[parts.length - 1] : "txt"
  }

  const diffViewer = () => {
    return (
      <>
        {/* Branch 1: Markdown preview mode for .md files */}
        <Show when={isPreviewMd()}>
          <div
            ref={previewWrapperRef}
            style={{ position: "relative", height: "100%" }}
            onMouseEnter={handlePreviewMouseEnter}
            onMouseMove={handlePreviewMouseMove}
            onMouseLeave={handlePreviewMouseLeave}
          >
            {/* Floating zoom overlay — top-right of content area */}
            <div
              onMouseEnter={handlePillMouseEnter}
              onMouseLeave={handlePillMouseLeave}
              style={{
                position: "absolute",
                top: "8px",
                right: "14px",
                "z-index": "20",
                display: "flex",
                "align-items": "center",
                height: "28px",
                "border-radius": "6px",
                border: "1px solid var(--border-base)",
                "box-shadow": "0 1px 3px rgba(0,0,0,0.08)",
                background: "color-mix(in srgb, var(--background-base) 80%, transparent)",
                "backdrop-filter": "blur(4px)",
                overflow: "hidden",
                "font-size": "12px",
                opacity: showZoomPill() ? "1" : "0",
                "pointer-events": showZoomPill() ? "auto" : "none",
                transition: "opacity 200ms ease",
              }}
            >
              {/* Editable zoom percentage input */}
              <input
                type="text"
                value={`${zoom()}%`}
                style={{
                  width: "44px",
                  height: "100%",
                  "text-align": "center",
                  "font-size": "12px",
                  color: "var(--text-base)",
                  background: "transparent",
                  border: "none",
                  outline: "none",
                }}
                onFocus={(e) => {
                  e.currentTarget.value = `${zoom()}`
                  e.currentTarget.select()
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur()
                  else if (e.key === "Escape") {
                    e.currentTarget.value = `${zoom()}`
                    e.currentTarget.blur()
                  }
                }}
                onBlur={(e) => {
                  const val = parseInt(e.currentTarget.value)
                  if (!isNaN(val)) onZoomChange(val)
                  e.currentTarget.value = `${zoom()}%`
                }}
              />
              {/* Reset to 100% */}
              <button
                type="button"
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  width: "24px",
                  height: "100%",
                  "border-left": "1px solid var(--border-base)",
                  background: "none",
                  "border-top": "none",
                  "border-bottom": "none",
                  "border-right": "none",
                  cursor: "pointer",
                  color: "var(--text-weak)",
                  padding: "0",
                }}
                onClick={() => onZoomChange(100)}
                aria-label="Reset zoom"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
              {/* Vertical +/- stepper */}
              <div style={{ display: "flex", "flex-direction": "column", "border-left": "1px solid var(--border-base)" }}>
                <button
                  type="button"
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "20px",
                    height: "14px",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-weak)",
                    "font-size": "10px",
                    "font-weight": "500",
                    "line-height": "1",
                    padding: "0",
                  }}
                  onClick={zoomIn}
                  aria-label="Zoom in"
                >+</button>
                <button
                  type="button"
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    width: "20px",
                    height: "14px",
                    background: "none",
                    border: "none",
                    "border-top": "1px solid var(--border-base)",
                    cursor: "pointer",
                    color: "var(--text-weak)",
                    "font-size": "10px",
                    "font-weight": "500",
                    "line-height": "1",
                    padding: "0",
                  }}
                  onClick={zoomOut}
                  aria-label="Zoom out"
                >−</button>
              </div>
            </div>
            <div
              data-slot="session-review-v2-markdown-preview"
              style={{
                padding: "16px",
                overflow: "auto",
                height: "100%",
                "transform-origin": "top left",
                transform: `scale(${zoom() / 100})`,
                width: `${10000 / zoom()}%`,
              }}
            >
              <Markdown text={preprocessMarkdown(text(view(), "additions"))} />
            </div>
          </div>
        </Show>

        {/* Branch 2: Deleted files — legacy read-only renderer */}
        <Show when={!isPreviewMd() && isDeleted()}>
          <Dynamic
            component={fileComponent}
            mode="diff"
            fileDiff={view().fileDiff}
            preloadedDiff={view().preloaded}
            diffStyle={props.diffStyle === "preview" ? "split" : props.diffStyle}
            expandUnchanged={expandUnchanged()}
            virtualize={shouldVirtualizeReviewDiff({
              additionLines: view().fileDiff.additionLines.length,
              deletionLines: view().fileDiff.deletionLines.length,
            })}
            hunkSeparators={view().fileDiff.isPartial ? "simple" : "line-info-basic"}
            enableLineSelection={lineCommentsEnabled()}
            enableGutterUtility={lineCommentsEnabled()}
            onLineSelected={(range: SelectedLineRange | null) => {
              if (!lineCommentsEnabled()) return
              commentsUi.onLineSelected(range)
            }}
            onLineSelectionEnd={(range: SelectedLineRange | null) => {
              if (!lineCommentsEnabled()) return
              commentsUi.onLineSelectionEnd(range)
            }}
            onLineNumberSelectionEnd={commentsUi.onLineNumberSelectionEnd}
            annotations={commentsUi.annotations()}
            renderAnnotation={commentsUi.renderAnnotation}
            renderGutterUtility={lineCommentsEnabled() ? commentsUi.renderGutterUtility : undefined}
            selectedLines={store.selection}
            commentedLines={commentedLines()}
            media={{
              mode: "auto",
              path: props.file,
              deleted: true,
              readFile: undefined,
            }}
          />
        </Show>

        {/* Branch 3: Added/Modified files — editable CM6 diff view.
            This <Show> keeps EditableDiffView mounted across view() updates;
            props update reactively without tearing down the editor. */}
        <Show when={isEditable()}>
          <div onKeyDown={handleImmediateSave} style={{ height: "100%" }}>
            <Show when={externalChange()}>
              <div
                data-slot="session-review-v2-external-change-banner"
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "space-between",
                  padding: "6px 12px",
                  "background-color": "var(--amc-warning, #ffc107)",
                  color: "var(--amc-bg, #000)",
                  "font-size": "12px",
                  "border-radius": "4px",
                  margin: "4px 0",
                }}
              >
                <span>This file was changed by the agent.</span>
                <span style={{ display: "flex", gap: "8px" }}>
                  <button
                    type="button"
                    onClick={handleReload}
                    style={{
                      border: "1px solid currentColor",
                      background: "transparent",
                      color: "inherit",
                      padding: "2px 8px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-size": "11px",
                    }}
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={handleKeep}
                    style={{
                      border: "1px solid currentColor",
                      background: "transparent",
                      color: "inherit",
                      padding: "2px 8px",
                      "border-radius": "3px",
                      cursor: "pointer",
                      "font-size": "11px",
                    }}
                  >
                    Keep
                  </button>
                </span>
              </div>
            </Show>
            <EditableDiffView
              original={text(view(), "deletions")}
              modified={text(view(), "additions")}
              language={fileExtension()}
              diffStyle={props.diffStyle === "preview" ? "split" : props.diffStyle}
              readOnly={!!props.isAgentBusy}
              onChange={handleChangeWithTracking}
              onRevert={handleRevert}
              editorRef={(h) => { editorHandle = h }}
            />
          </div>
        </Show>
      </>
    )
  }

  return (
    <>
      <div data-slot="session-review-v2-file-header">
        <Show when={props.onRefresh}>
          {(handler) => (
            <TooltipV2 openDelay={500} value="Refresh">
              <button
                type="button"
                aria-label="Refresh"
                onClick={handler()}
                style={{
                  display: "flex",
                  "align-items": "center",
                  "justify-content": "center",
                  width: "10px",
                  height: "10px",
                  padding: "0",
                  margin: "0 -4px 0 0",
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--icon-base)",
                  "flex-shrink": "0",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--icon-hover, var(--icon-base))")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--icon-base)")}
              >
                <Icon name="refresh" size="small" />
              </button>
            </TooltipV2>
          )}
        </Show>
        <MenuV2.Context>
          <MenuV2.Context.Trigger
            as="div"
            data-slot="session-review-v2-file-title"
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              "min-width": "0",
              flex: "1 1 0",
            }}
          >
            <TooltipV2 openDelay={500} value={statusTooltip(view().status)}>
              <div data-slot="session-review-v2-file-status" data-type={statusType(view().status)}>
                {statusLabel(view().status)}
              </div>
            </TooltipV2>
            <FileIcon node={{ path: props.file, type: "file" }} />
            <FileNameWithPicker
              file={props.file}
              filePicker={props.filePicker}
              onSelectFile={props.onSelectFile}
              dirty={isEditable() && hasEdits()}
            />
          </MenuV2.Context.Trigger>
          <MenuV2.Context.Portal>
            <MenuV2.Context.Content>
              <MenuV2.Item onSelect={() => copyTextToClipboard(props.file)}>Copy full path</MenuV2.Item>
              <MenuV2.Item onSelect={() => copyTextToClipboard(getFilename(props.file))}>Copy filename</MenuV2.Item>
            </MenuV2.Context.Content>
          </MenuV2.Context.Portal>
        </MenuV2.Context>
        <div
          data-slot="session-review-v2-file-diff"
          style={{
            display: "flex",
            "align-items": "center",
            "flex-shrink": "0",
          }}
        >
          <DiffChanges changes={view()} />
          <Show when={isEditable() && hasEdits()}>
            <TooltipV2 openDelay={300} value="Revert to agent's version">
              <button
                type="button"
                aria-label="Revert"
                data-slot="session-review-v2-revert-button"
                onClick={handleRevert}
                style={{
                  display: "inline-flex",
                  "align-items": "center",
                  "justify-content": "center",
                  width: "16px",
                  height: "16px",
                  padding: "0",
                  "margin-left": "6px",
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                  color: "var(--amc-text-muted, var(--icon-base))",
                  "flex-shrink": "0",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = "var(--amc-danger, #f44336)")}
                onMouseLeave={(e) => (e.currentTarget.style.color = "var(--amc-text-muted, var(--icon-base))")}
              >
                <Icon name="reset" size="small" />
              </button>
            </TooltipV2>
          </Show>
          {/* Error-only save feedback — shown for 2s on save failure.
              Uses position: relative + z-index: 1 (via CSS) to escape the ::after occlusion. */}
          <Show when={isEditable() && saveStatus() === "error"}>
            <span
              data-slot="session-review-v2-save-error"
              style={{
                "font-size": "11px",
                "margin-left": "8px",
                "white-space": "nowrap",
                color: "var(--amc-danger, #f44336)",
              }}
            >
              Save failed
            </span>
          </Show>
        </div>
      </div>
      <Show when={props.isAgentBusy}>
        <div style={{ position: "relative", height: 0, "z-index": 10 }}>
          <div data-slot="session-review-v2-lock-indicator">
            <Icon name="lock" />
          </div>
        </div>
      </Show>
      <div
        ref={(el) => {
          scrollRef = el
        }}
        data-slot="session-review-v2-diff-scroll"
      >
        <Show
          when={diffCanRender() || mediaKind()}
          fallback={
            <div data-slot="session-review-v2-empty">
              <span class="text-12-regular text-text-weak">{i18n.t("ui.fileMedia.binary.title")}</span>
            </div>
          }
        >
          {diffViewer()}
        </Show>
      </div>
    </>
  )
}

/** Renders the filename + directory path. When a filePicker render prop is
 *  provided, clicking the name opens a dropdown with the picker content. */
function FileNameWithPicker(props: {
  file: string
  filePicker?: (pickerProps: { onSelect: (path: string) => void }) => JSX.Element
  onSelectFile?: (file: string) => void
  /** Show the dirty dot (●) between filename and path. */
  dirty?: boolean
}) {
  const [open, setOpen] = createSignal(false)
  let triggerRef: HTMLButtonElement | undefined
  const hasFilePicker = () => !!props.filePicker && !!props.onSelectFile

  const onSelect = (file: string) => {
    setOpen(false)
    props.onSelectFile?.(file)
  }

  const toggle = (e: MouseEvent) => {
    e.stopPropagation()
    setOpen(!open())
  }

  // Close on outside click
  createEffect(() => {
    if (!open()) return
    const onPointerDown = (e: PointerEvent) => {
      if (triggerRef?.contains(e.target as Node)) return
      const dropdown = document.querySelector(".session-review-v2-file-picker-dropdown")
      if (dropdown?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true))
  })

  return (
    <Show
      when={hasFilePicker()}
      fallback={
        <>
          <TooltipV2 value={props.file}>
            <span data-slot="session-review-v2-file-name">{getFilename(props.file)}</span>
          </TooltipV2>
          <Show when={props.dirty}>
            <TooltipV2 openDelay={300} value="Unsaved changes (Cmd+S to save)">
              <span
                data-slot="session-review-v2-dirty-dot"
                style={{
                  "flex-shrink": "0",
                  "font-size": "14px",
                  "line-height": "1",
                  color: "var(--v2-text-text-muted, var(--amc-text-muted))",
                }}
                aria-label="Unsaved changes"
              >
                ●
              </span>
            </TooltipV2>
          </Show>
          <Show when={props.file.includes("/")}>
            <TooltipV2 value={props.file}>
              <span data-slot="session-review-v2-file-path">{getDirectory(props.file)}</span>
            </TooltipV2>
          </Show>
        </>
      }
    >
      <div class="session-review-v2-file-picker-wrapper">
        <button
          ref={triggerRef}
          type="button"
          class="session-review-v2-file-picker-trigger"
          onClick={toggle}
        >
          <span data-slot="session-review-v2-file-name" data-clickable="">
            {getFilename(props.file)}
          </span>
        </button>
        <Show when={props.dirty}>
          <TooltipV2 openDelay={300} value="Unsaved changes (Cmd+S to save)">
            <span
              data-slot="session-review-v2-dirty-dot"
              style={{
                "flex-shrink": "0",
                "font-size": "14px",
                "line-height": "1",
                color: "var(--v2-text-text-muted, var(--amc-text-muted))",
              }}
              aria-label="Unsaved changes"
            >
              ●
            </span>
          </TooltipV2>
        </Show>
        <Show when={props.file.includes("/")}>
          <TooltipV2 value={props.file}>
            <span data-slot="session-review-v2-file-path">
              {getDirectory(props.file)}
            </span>
          </TooltipV2>
        </Show>
        <Show when={open()}>
          <div
            ref={(el) => {
              requestAnimationFrame(() => {
                const left = el.getBoundingClientRect().left
                const available = window.innerWidth - left - 16
                el.style.maxWidth = `${Math.max(200, available)}px`
              })
            }}
            class="session-review-v2-file-picker-dropdown"
          >
            <div class="session-review-v2-file-picker-scroll-inner">
              {props.filePicker!({ onSelect })}
            </div>
          </div>
        </Show>
      </div>
    </Show>
  )
}

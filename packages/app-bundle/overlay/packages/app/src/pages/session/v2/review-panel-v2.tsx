import { createMemo, createResource, createSignal, Show, type JSX } from "solid-js"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import {
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX,
  SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN,
  SessionReviewV2,
  SessionReviewV2Sidebar,
} from "@opencode-ai/session-ui/v2/session-review-v2"
import { SessionReviewFilePreviewV2, type SessionReviewFilePreviewV2Props } from "@opencode-ai/session-ui/v2/session-review-file-preview-v2"
import { DiffChanges } from "@opencode-ai/ui/v2/diff-changes-v2"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import type {
  SessionReviewComment,
  SessionReviewCommentActions,
  SessionReviewCommentDelete,
  SessionReviewCommentUpdate,
  SessionReviewDiffStyle,
  SessionReviewFocus,
  SessionReviewLineComment,
} from "@opencode-ai/session-ui/session-review"
import FileTreeV2 from "@/components/file-tree-v2"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import {
  filterRenderableDiff,
  filterReviewFiles,
  reviewDiffKinds,
  reviewDiffNeedsLoad,
  type RenderDiff,
} from "@/pages/session/v2/review-diff-kinds"
import type { ReviewPanelV2State } from "@/pages/session/v2/review-panel-v2-state"
import { applyFileListKeyDown, SessionFileListV2 } from "@/pages/session/v2/session-file-list-v2"

type ReviewDiff = FileDiffInfo | SnapshotFileDiff | VcsFileDiff

export type ReviewPanelV2Props = {
  title?: JSX.Element
  empty?: JSX.Element
  diffs: () => ReviewDiff[]
  diffsReady: () => boolean
  diffVersion?: number
  loadDiff?: (path: string, version?: number) => Promise<RenderDiff | undefined>
  activeFile?: string
  onSelectFile: (path: string) => void
  diffStyle: SessionReviewDiffStyle
  onDiffStyleChange?: (style: SessionReviewDiffStyle) => void
  serverUrl?: string
  state: ReviewPanelV2State
  isAgentBusy?: boolean
  onRefresh?: () => void
  onLineComment?: (comment: SessionReviewLineComment) => void
  onLineCommentUpdate?: (comment: SessionReviewCommentUpdate) => void
  onLineCommentDelete?: (comment: SessionReviewCommentDelete) => void
  lineCommentActions?: SessionReviewCommentActions
  comments?: SessionReviewComment[]
  focusedComment?: SessionReviewFocus | null
  onFocusedCommentChange?: (focus: SessionReviewFocus | null) => void
}

export function ReviewPanelV2(props: ReviewPanelV2Props) {
  const sdk = useSDK()

  const diffs = createMemo(() => props.diffs().filter(filterRenderableDiff))
  const filteredFiles = createMemo(() =>
    filterReviewFiles(
      diffs().map((diff) => diff.file),
      props.state.filter(),
    ),
  )
  const searching = createMemo(() => props.state.filter().trim().length > 0)
  const kinds = createMemo(() => reviewDiffKinds(diffs()))
  // Changes-only trees omit "M" — every row is already a change; A/D stay visible.
  const treeKinds = createMemo(() => new Map([...kinds()].filter(([, kind]) => kind !== "mix")))
  const activeDiff = createMemo(() => {
    // A focused comment takes over the preview until the preview applies it and
    // clears the focus; the owner then persists the file as the active selection.
    const focus = props.focusedComment
    if (focus && diffs().some((diff) => diff.file === focus.file)) return focus.file
    const active = props.activeFile
    if (searching()) return active
    const files = filteredFiles()
    if (active && files.includes(active)) return active
    // During agent turns, keep the user's selection even when the file has
    // briefly dropped from the diff list (the ~1s blind window between tool
    // completion and server diff refetch). Without this, activeDiff falls
    // through to files[0], the keyed <Show> sees a different key, and the
    // preview component remounts — losing scroll position and editor state.
    if (active && props.isAgentBusy) return active
    return files[0]
  })
  const sourceActiveItem = createMemo(() => diffs().find((diff) => diff.file === activeDiff()))
  const detailSource = createMemo(() => {
    const diff = sourceActiveItem()
    const load = props.loadDiff
    if (!diff || !load || !reviewDiffNeedsLoad(diff)) return
    return { diff, load, version: props.diffVersion }
  })
  const [loadedDiff] = createResource(detailSource, async ({ diff, load, version }) => {
    const value = await load(diff.file, version)
    if (value?.file !== diff.file) return
    return { source: diff, version, value }
  })

  const activeItem = createMemo(() => {
    const source = sourceActiveItem()
    if (loadedDiff.state !== "ready") return source
    const loaded = loadedDiff()
    if (loaded && loaded.source === source && loaded.version === props.diffVersion) return loaded.value
    return source
  })

  // Latch the active file and diff during agent turns so the <Show> wrappers
  // don't unmount SessionReviewFilePreviewV2 during the ~1s blind window
  // between a tool completion and the server diff refetch. Without this,
  // the component is destroyed and recreated, losing scroll position and
  // editor state every time the agent edits a file.
  const stableActiveDiff = createMemo<string | undefined>((prev) => {
    const current = activeDiff()
    if (!current && prev && props.isAgentBusy) return prev
    return current
  })
  const stableActiveItem = createMemo<ReviewDiff | undefined>((prev) => {
    const current = activeItem()
    if (!current && prev && props.isAgentBusy) return prev
    return current
  })

  const readFile = async (path: string) =>
    sdk()
      .client.file.read({ path })
      .then((x) => x.data)
      .catch((error) => {
        console.debug("[session-review-v2] failed to read file", { path, error })
        return undefined
      })

  return (
    <SessionReviewV2
      title={props.title}
      stats={<DiffChanges changes={diffs()} />}
      empty={props.empty}
      sidebarOpen={props.state.sidebarOpened()}
      sidebar={
        // Always mounted: the sidebar header hosts the changes-mode dropdown,
        // which must stay reachable when the current mode has zero diffs.
        <ReviewPanelV2Sidebar
          title={props.title}
          state={props.state}
          diffsReady={props.diffsReady}
          onSelectFile={props.onSelectFile}
          diffs={diffs}
          filteredFiles={filteredFiles}
          searching={searching}
          kinds={treeKinds}
          activeDiff={activeDiff}
        />
      }
      activeFile={stableActiveDiff()}
      files={filteredFiles()}
      onSelectFile={props.onSelectFile}
      diffStyle={props.diffStyle}
      onDiffStyleChange={props.onDiffStyleChange}
      expandMode={props.state.expandMode()}
      onExpandModeChange={props.state.setExpandMode}
      hasDiffs={diffs().length > 0}
      preview={
        // Key on the file path, not the diff object identity, so refreshed diff data
        // updates the mounted preview instead of remounting the whole viewer.
        // Use stable (latched) values so the component survives brief falsy
        // gaps during the agent's turn (the ~1s blind window between tool
        // completion and server diff refetch).
        <Show when={stableActiveDiff()} keyed>
          {(file) => (
            <Show when={stableActiveItem()}>
              {(diff) => (
                <SessionReviewFilePreviewV2
                  file={file}
                  diff={diff() as SessionReviewFilePreviewV2Props["diff"]}
                  diffStyle={props.diffStyle}
                  expandMode={props.state.expandMode()}
                  readFile={readFile}
                  serverUrl={props.serverUrl}
                  isAgentBusy={props.isAgentBusy}
                  onRefresh={props.onRefresh}
                  filePicker={({ onSelect }) => {
                    const files = filteredFiles()

                    // Compute common root directory
                    const segments = files.map((f) => f.split("/").slice(0, -1))
                    const minLen = Math.min(...segments.map((s) => s.length))
                    const common: string[] = []
                    for (let i = 0; i < minLen; i++) {
                      const seg = segments[0][i]
                      if (segments.every((s) => s[i] === seg)) common.push(seg)
                      else break
                    }
                    const root = common.join("/")

                    // Shorten root for display: last 2 segments with .../
                    const rootLabel = root
                      ? (common.length > 2
                          ? ".../" + common.slice(-2).join("/") + "/"
                          : root + "/")
                      : undefined

                    // Build collapsed flat tree
                    const relFiles = root ? files.map((f) => f.slice(root.length + 1)) : files
                    const rows = buildCollapsedTree(relFiles, file ? (root ? file.slice(root.length + 1) : file) : undefined)

                    return (
                      <>
                        {rootLabel && (
                          <div data-slot="session-review-v2-file-picker-root">{rootLabel}</div>
                        )}
                        {rows.map((row) => {
                          const guides = row.guides.map((guideDepth) => (
                            <span
                              data-slot="session-review-v2-file-picker-indent-guide"
                              style={{ left: `${guideDepth * 16 + 8 + 7}px` }}
                            />
                          ))

                          return row.type === "dir" ? (
                            <div
                              data-slot="session-review-v2-file-picker-dir"
                              style={{ "padding-left": `${row.depth * 16 + 8}px` }}
                            >
                              {guides}
                              {row.label}
                            </div>
                          ) : (
                            <button
                              type="button"
                              data-slot="session-review-v2-file-picker-item"
                              data-active={row.path === (root ? file.slice(root.length + 1) : file) ? "" : undefined}
                              style={{ "padding-left": `${row.depth * 16 + 8}px` }}
                              onClick={() => {
                                const fullPath = root ? root + "/" + row.path! : row.path!
                                onSelect(fullPath)
                              }}
                            >
                              {guides}
                              <FileIcon node={{ path: row.path!, type: "file" }} />
                              <span data-slot="session-review-v2-file-picker-item-name">
                                {row.label}
                              </span>
                            </button>
                          )
                        })}
                      </>
                    )
                  }}
                  onSelectFile={props.onSelectFile}
                  onLineComment={props.onLineComment}
                  onLineCommentUpdate={props.onLineCommentUpdate}
                  onLineCommentDelete={props.onLineCommentDelete}
                  lineCommentActions={props.lineCommentActions}
                  comments={props.comments}
                  focusedComment={props.focusedComment}
                  onFocusedCommentChange={props.onFocusedCommentChange}
                />
              )}
            </Show>
          )}
        </Show>
      }
    />
  )
}

function ReviewPanelV2Sidebar(props: {
  title?: JSX.Element
  state: ReviewPanelV2State
  diffsReady: () => boolean
  onSelectFile: (path: string) => void
  diffs: () => RenderDiff[]
  filteredFiles: () => string[]
  searching: () => boolean
  kinds: () => ReturnType<typeof reviewDiffKinds>
  activeDiff: () => string | undefined
}) {
  const language = useLanguage()
  const [explicitHighlight, setExplicitHighlight] = createSignal<string | undefined>()
  const highlightedPath = createMemo(() => {
    if (!props.searching()) return undefined
    const files = props.filteredFiles()
    if (files.length === 0) return undefined
    const explicit = explicitHighlight()
    if (explicit && files.includes(explicit)) return explicit
    return files[0]
  })

  const onFilterKeyDown = (event: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (!props.searching()) return
    applyFileListKeyDown(event, props.filteredFiles(), highlightedPath(), {
      onHighlight: setExplicitHighlight,
      onSelect: props.onSelectFile,
    })
  }

  return (
    <SessionReviewV2Sidebar
      open={props.state.sidebarOpened()}
      transition={props.state.sidebarTransition()}
      title={props.title}
      stats={<DiffChanges changes={props.diffs()} />}
      filter={props.state.filter()}
      onFilterChange={props.state.setFilter}
      onFilterKeyDown={onFilterKeyDown}
      width={props.state.sidebarWidth()}
      onWidthChange={props.state.resizeSidebar}
      minWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN}
      maxWidth={SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX}
    >
      <Show
        when={props.diffsReady()}
        fallback={
          <div class="px-2 py-2 text-12-regular text-text-weak">
            {language.t("common.loading")}
            {language.t("common.loading.ellipsis")}
          </div>
        }
      >
        <Show
          when={props.searching()}
          fallback={
            <FileTreeV2
              allowed={props.filteredFiles()}
              kinds={props.kinds()}
              draggable={false}
              active={props.activeDiff()}
              onFileClick={(node) => props.onSelectFile(node.path)}
            />
          }
        >
          <Show
            when={props.filteredFiles().length > 0}
            fallback={<div class="px-2 py-2 text-12-regular text-text-weak">{language.t("palette.empty")}</div>}
          >
            <SessionFileListV2
              files={props.filteredFiles()}
              kinds={props.kinds()}
              active={props.activeDiff()}
              highlighted={highlightedPath()}
              onFileClick={(path) => {
                setExplicitHighlight(path)
                props.onSelectFile(path)
              }}
            />
          </Show>
        </Show>
      </Show>
    </SessionReviewV2Sidebar>
  )
}

type CollapsedRow = {
  type: "dir" | "file"
  label: string
  path?: string
  depth: number
  /** Depth levels where a vertical guide line should be drawn (ancestor has more siblings) */
  guides: number[]
}

/** Build a flat list of rows from file paths, collapsing single-child directory
 *  chains into combined labels (e.g. "src/v2/components" instead of three levels). */
function buildCollapsedTree(files: string[], _active?: string): CollapsedRow[] {
  type TreeNode = { children: Map<string, TreeNode>; files: string[] }
  const root: TreeNode = { children: new Map(), files: [] }

  for (const file of files) {
    const parts = file.split("/")
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { children: new Map(), files: [] })
      }
      node = node.children.get(parts[i])!
    }
    node.files.push(file)
  }

  const rows: CollapsedRow[] = []

  function walk(node: TreeNode, depth: number, prefix: string, inheritedGuides: number[]) {
    const dirs = [...node.children.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const nodeFiles = [...node.files].sort((a, b) => {
      const nameA = a.split("/").pop()!
      const nameB = b.split("/").pop()!
      return nameA.localeCompare(nameB)
    })

    const children: Array<{ type: "dir"; name: string; node: TreeNode } | { type: "file"; file: string }> = [
      ...dirs.map(([name, child]) => ({ type: "dir" as const, name, node: child })),
      ...nodeFiles.map((file) => ({ type: "file" as const, file })),
    ]

    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const isLast = i === children.length - 1
      // This row's guides: inherited from parent + current depth if NOT last sibling
      const rowGuides = [...inheritedGuides]
      // Guides for children of this row
      const childGuides = isLast ? [...inheritedGuides] : [...inheritedGuides, depth]

      if (child.type === "dir") {
        let collapsed = child.name
        let current = child.node
        while (current.children.size === 1 && current.files.length === 0) {
          const [nextName, nextChild] = [...current.children.entries()][0]
          collapsed += "/" + nextName
          current = nextChild
        }

        let label = collapsed
        const collapsedParts = collapsed.split("/")
        if (collapsedParts.length > 3) {
          label = collapsedParts[0] + "/.../" + collapsedParts[collapsedParts.length - 1]
        }

        rows.push({ type: "dir", label: label + "/", depth, guides: rowGuides })
        walk(current, depth + 1, prefix + collapsed + "/", childGuides)
      } else {
        const filename = child.file.split("/").pop()!
        rows.push({ type: "file", label: filename, path: child.file, depth, guides: rowGuides })
      }
    }
  }

  walk(root, 0, "", [])
  return rows
}

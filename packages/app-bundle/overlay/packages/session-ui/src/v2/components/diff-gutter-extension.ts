/**
 * Custom CM6 gutter extension for unified diff mode (#769).
 *
 * Diffs `original` vs the current editor document and renders:
 * - Gutter markers: green (added), red (removed), yellow (changed)
 * - Inline deleted-line widgets: faded red text showing removed content
 *
 * Updates on a debounced basis (~300ms) after each edit.
 * Uses the `diff` npm package (already a session-ui dependency) for
 * line-level diffing.
 *
 * @module
 */

import {
  type Extension,
  StateField,
  StateEffect,
  RangeSet,
  type EditorState,
  type Range,
} from "@codemirror/state"
import {
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  Decoration,
  WidgetType,
  type ViewUpdate,
  type DecorationSet,
} from "@codemirror/view"
import { diffLines, type Change } from "diff"

// ---------------------------------------------------------------------------
// Marker kinds and GutterMarker subclasses
// ---------------------------------------------------------------------------

export enum DiffGutterMarkerKind {
  Added = "added",
  Removed = "removed",
  Changed = "changed",
}

class DiffMarker extends GutterMarker {
  constructor(readonly kind: DiffGutterMarkerKind) {
    super()
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div")
    el.className = `cm-diff-gutter-marker cm-diff-gutter-${this.kind}`
    el.style.width = "4px"
    el.style.height = "100%"
    el.style.borderRadius = "1px"

    switch (this.kind) {
      case DiffGutterMarkerKind.Added:
        el.style.backgroundColor = "var(--v2-state-fg-success, var(--text-on-success-base, #4caf50))"
        break
      case DiffGutterMarkerKind.Removed:
        el.style.backgroundColor = "var(--v2-state-fg-danger, var(--text-on-critical-base, #f44336))"
        break
      case DiffGutterMarkerKind.Changed:
        el.style.backgroundColor = "var(--v2-state-fg-warning, var(--border-warning-base, #ffc107))"
        break
    }

    return el
  }
}

const addedMarker = new DiffMarker(DiffGutterMarkerKind.Added)
const removedMarker = new DiffMarker(DiffGutterMarkerKind.Removed)
const changedMarker = new DiffMarker(DiffGutterMarkerKind.Changed)

// ---------------------------------------------------------------------------
// Deleted-line widget — renders removed text as faded read-only lines
// ---------------------------------------------------------------------------

class DeletedLinesWidget extends WidgetType {
  constructor(readonly lines: string[]) {
    super()
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("div")
    wrapper.className = "cm-deleted-line-widget"
    wrapper.style.fontFamily = "var(--font-mono, ui-monospace, monospace)"
    wrapper.style.fontSize = "13px"
    wrapper.style.lineHeight = "1.5"
    wrapper.style.pointerEvents = "none"
    wrapper.style.userSelect = "none"
    wrapper.setAttribute("aria-hidden", "true")

    for (const line of this.lines) {
      const row = document.createElement("div")
      row.className = "cm-deleted-line-row"
      row.style.backgroundColor = "var(--v2-state-bg-danger, rgba(244, 67, 54, 0.06))"
      row.style.color = "var(--v2-state-fg-danger, var(--text-on-critical-base, #f44336))"
      row.style.opacity = "0.7"
      row.style.textDecoration = "line-through"
      row.style.padding = "0 4px"
      row.style.whiteSpace = "pre-wrap"
      row.style.wordBreak = "break-all"
      // Prefix with minus sign like a diff
      row.textContent = `- ${line}`
      wrapper.appendChild(row)
    }

    return wrapper
  }

  eq(other: DeletedLinesWidget): boolean {
    return (
      this.lines.length === other.lines.length &&
      this.lines.every((l, i) => l === other.lines[i])
    )
  }

  get estimatedHeight(): number {
    // ~20px per line (13px font * 1.5 line-height)
    return this.lines.length * 20
  }

  ignoreEvent(): boolean {
    return true
  }
}

// ---------------------------------------------------------------------------
// State effects and fields
// ---------------------------------------------------------------------------

const setDiffMarkers = StateEffect.define<RangeSet<DiffMarker>>()
const setDeletedDecorations = StateEffect.define<DecorationSet>()

const diffMarkersField = StateField.define<RangeSet<DiffMarker>>({
  create() {
    return RangeSet.empty
  },
  update(markers, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDiffMarkers)) {
        return effect.value
      }
    }
    return markers
  },
})

const deletedDecorationsField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(decos, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setDeletedDecorations)) {
        return effect.value
      }
    }
    // Map through document changes so positions stay valid
    return decos.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ---------------------------------------------------------------------------
// Diff computation
// ---------------------------------------------------------------------------

interface LineMarker {
  line: number
  kind: DiffGutterMarkerKind
}

/** Where to insert a deleted-lines widget: after `line` in the current doc. */
interface DeletedBlock {
  afterLine: number
  lines: string[]
}

interface DiffResult {
  markers: LineMarker[]
  deletedBlocks: DeletedBlock[]
}

function computeDiff(original: string, current: string): DiffResult {
  const changes = diffLines(original, current)
  const markers: LineMarker[] = []
  const deletedBlocks: DeletedBlock[] = []

  let currentLine = 1

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]
    const lineCount = change.count ?? 0

    if (change.removed) {
      const removedText = (change.value ?? "").replace(/\n$/, "")
      const removedLines = removedText.split("\n")

      // Check if the next change is an addition (replacement)
      if (i + 1 < changes.length && changes[i + 1].added) {
        const nextChange = changes[i + 1]
        const nextCount = nextChange.count ?? 0
        // This is a replacement — mark added lines as "changed"
        for (let j = 0; j < nextCount; j++) {
          markers.push({
            line: currentLine + j,
            kind: DiffGutterMarkerKind.Changed,
          })
        }
        // Show the deleted lines above the changed lines
        deletedBlocks.push({
          afterLine: Math.max(0, currentLine - 1),
          lines: removedLines,
        })
        currentLine += nextCount
        i++ // Skip the next (added) change since we handled it
      } else {
        // Pure removal — show deleted lines at the current position
        markers.push({
          line: Math.max(1, currentLine),
          kind: DiffGutterMarkerKind.Removed,
        })
        deletedBlocks.push({
          afterLine: Math.max(0, currentLine - 1),
          lines: removedLines,
        })
      }
      // Removed-only: currentLine doesn't advance
    } else if (change.added) {
      // Pure addition (not a replacement — those are handled above)
      for (let j = 0; j < lineCount; j++) {
        markers.push({
          line: currentLine + j,
          kind: DiffGutterMarkerKind.Added,
        })
      }
      currentLine += lineCount
    } else {
      // Unchanged lines
      currentLine += lineCount
    }
  }

  return { markers, deletedBlocks }
}

function markersToRangeSet(
  markers: LineMarker[],
  state: EditorState,
): RangeSet<DiffMarker> {
  const builder: { from: number; marker: DiffMarker }[] = []

  for (const m of markers) {
    if (m.line < 1 || m.line > state.doc.lines) continue

    const lineStart = state.doc.line(m.line).from
    const marker =
      m.kind === DiffGutterMarkerKind.Added
        ? addedMarker
        : m.kind === DiffGutterMarkerKind.Removed
          ? removedMarker
          : changedMarker

    builder.push({ from: lineStart, marker })
  }

  builder.sort((a, b) => a.from - b.from)

  return RangeSet.of(
    builder.map((b) => b.marker.range(b.from)),
  )
}

function deletedBlocksToDecorations(
  blocks: DeletedBlock[],
  state: EditorState,
): DecorationSet {
  const widgets: Range<Decoration>[] = []

  for (const block of blocks) {
    if (block.lines.length === 0) continue

    // Position: after the specified line, or at doc start if afterLine is 0
    let pos: number
    if (block.afterLine <= 0) {
      pos = 0
    } else if (block.afterLine >= state.doc.lines) {
      pos = state.doc.length
    } else {
      pos = state.doc.line(block.afterLine).to
    }

    const widget = Decoration.widget({
      widget: new DeletedLinesWidget(block.lines),
      block: true,
      side: 1, // After the line
    })

    widgets.push(widget.range(pos))
  }

  // Sort by position (required by RangeSet)
  widgets.sort((a, b) => a.from - b.from)

  return Decoration.set(widgets)
}

// ---------------------------------------------------------------------------
// View plugin: debounced diff recomputation
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 300

function createDiffPlugin(original: string) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null
      private original: string

      constructor(private view: EditorView) {
        this.original = original
        // Defer initial diff computation — can't dispatch during construction
        this.timer = setTimeout(() => {
          this.timer = null
          this.computeAndApply()
        }, 0)
      }

      update(update: ViewUpdate) {
        if (update.docChanged) {
          this.scheduleCompute()
        }
      }

      private scheduleCompute() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
        }
        this.timer = setTimeout(() => {
          this.timer = null
          this.computeAndApply()
        }, DEBOUNCE_MS)
      }

      private computeAndApply() {
        const current = this.view.state.doc.toString()
        const { markers, deletedBlocks } = computeDiff(this.original, current)
        const markerSet = markersToRangeSet(markers, this.view.state)
        const decoSet = deletedBlocksToDecorations(deletedBlocks, this.view.state)
        this.view.dispatch({
          effects: [
            setDiffMarkers.of(markerSet),
            setDeletedDecorations.of(decoSet),
          ],
        })
      }

      destroy() {
        if (this.timer !== null) {
          clearTimeout(this.timer)
        }
      }
    },
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a CM6 extension that shows diff gutter markers + inline
 * deleted-line widgets comparing the editor content against `original`.
 * Markers and widgets update 300ms after the last edit.
 */
export function diffGutterExtension(original: string): Extension {
  return [
    diffMarkersField,
    deletedDecorationsField,
    gutter({
      class: "cm-diff-gutter",
      markers: (view) => view.state.field(diffMarkersField),
    }),
    createDiffPlugin(original),
    // Gutter styling
    EditorView.baseTheme({
      ".cm-diff-gutter": {
        width: "6px",
        minWidth: "6px",
        marginRight: "2px",
      },
    }),
  ]
}

/**
 * Read the current diff markers from an EditorState.
 * Useful for testing — avoids relying on DOM rendering.
 */
export function getDiffMarkers(state: EditorState): RangeSet<GutterMarker> {
  return state.field(diffMarkersField)
}

/**
 * Read the current deleted-line decorations from an EditorState.
 * Useful for testing.
 */
export function getDeletedLineDecorations(state: EditorState): DecorationSet {
  return state.field(deletedDecorationsField)
}

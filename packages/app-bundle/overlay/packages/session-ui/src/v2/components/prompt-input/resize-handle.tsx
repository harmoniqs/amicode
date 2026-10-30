import { createSignal, onCleanup, onMount, type Accessor } from "solid-js"
import {
  COMPOSER_MIN_HEIGHT,
  composerMaxHeight,
  composerStorage,
  createComposerResizer,
  type ComposerResizer,
} from "./resize"

// Solid glue for the composer drag-to-resize handle (amicode#612). Shared by
// the legacy `PromptInput` (app package) and `PromptInputV2`; all behavior
// lives in ./resize.ts, this file is signals + markup only.

export type ComposerResize = {
  /** User-chosen text-area height in px, or undefined for the stock auto height. */
  height: Accessor<number | undefined>
  /** Largest height the handle allows right now; tracks the window size. */
  maxHeight: Accessor<number>
  resizer: ComposerResizer
}

/** Default accessible name / tooltip; the legacy composer overrides both via `language.t`. */
export const COMPOSER_RESIZE_LABEL = "Resize message box"
export const COMPOSER_RESIZE_TITLE = "Drag to resize · double-click to reset"

export function createComposerResize(measure: () => number | undefined): ComposerResize {
  const [height, setHeight] = createSignal<number | undefined>(undefined)
  const viewport = () => (typeof window === "undefined" ? 800 : window.innerHeight)
  const [maxHeight, setMaxHeight] = createSignal(composerMaxHeight(viewport()))
  const resizer = createComposerResizer({
    measure: () => measure() ?? COMPOSER_MIN_HEIGHT,
    viewport,
    storage: composerStorage(),
    onChange: setHeight,
  })
  setHeight(resizer.height())

  onMount(() => {
    const refit = () => {
      setMaxHeight(composerMaxHeight(viewport()))
      resizer.refit()
    }
    window.addEventListener("resize", refit)
    onCleanup(() => window.removeEventListener("resize", refit))
  })

  return { height, maxHeight, resizer }
}

/** Inline style that pins the text area to the user's chosen height. */
export function composerHeightStyle(height: number | undefined) {
  if (height === undefined) return undefined
  return { "min-height": `${height}px`, "max-height": `${height}px` }
}

/**
 * The pointer/keyboard wiring of the handle, separated from the markup so it
 * can be exercised directly. `setDragging` mirrors the drag state into the grip.
 */
export function composerResizeHandlers(resizer: () => ComposerResizer, setDragging: (dragging: boolean) => void) {
  const finish = () => {
    resizer().end()
    setDragging(false)
  }
  return {
    onPointerDown: (event: PointerEvent & { currentTarget: HTMLElement }) => {
      if (event.button !== 0) return
      event.preventDefault()
      // Capture keeps move/up events flowing when the pointer leaves the 8px strip.
      event.currentTarget.setPointerCapture?.(event.pointerId)
      resizer().begin(event.clientY)
      setDragging(true)
    },
    onPointerMove: (event: PointerEvent) => resizer().move(event.clientY),
    onPointerUp: finish,
    onPointerCancel: finish,
    onLostPointerCapture: finish,
    onDblClick: () => resizer().reset(),
    onKeyDown: (event: KeyboardEvent) => {
      if (resizer().key(event.key)) event.preventDefault()
    },
  }
}

export function ComposerResizeHandle(props: {
  resize: ComposerResize
  /** Accessible name; defaults to the English copy (v2 composer has no i18n context). */
  label?: string
  /** Tooltip; defaults to the English copy. */
  title?: string
  /** Colour classes for the grip pill; the pill is only visible on hover/focus/drag. */
  gripClass?: string
}) {
  const [dragging, setDragging] = createSignal(false)
  const handlers = composerResizeHandlers(() => props.resize.resizer, setDragging)

  return (
    <div
      data-component="composer-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={props.label ?? COMPOSER_RESIZE_LABEL}
      aria-valuemin={COMPOSER_MIN_HEIGHT}
      aria-valuemax={props.resize.maxHeight()}
      aria-valuenow={props.resize.height()}
      tabindex="0"
      title={props.title ?? COMPOSER_RESIZE_TITLE}
      // The form clips its overflow, so the focus ring is drawn inset (negative offset).
      class="group/resize absolute inset-x-0 top-0 z-30 flex h-[var(--space-2)] cursor-ns-resize touch-none select-none items-start justify-center focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-v2-border-border-focus"
      {...handlers}
    >
      <div
        class={`mt-[var(--space-1)] h-[var(--space-1)] w-[var(--space-8)] rounded-[var(--radius-full)] transition-opacity ${props.gripClass ?? "bg-v2-text-text-muted"}`}
        classList={{
          "opacity-0": !dragging(),
          "group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100": !dragging(),
          "opacity-100": dragging(),
        }}
      />
    </div>
  )
}

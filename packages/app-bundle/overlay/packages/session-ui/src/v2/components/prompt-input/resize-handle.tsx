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
  resizer: ComposerResizer
}

export function createComposerResize(measure: () => number | undefined): ComposerResize {
  const [height, setHeight] = createSignal<number | undefined>(undefined)
  const viewport = () => (typeof window === "undefined" ? 800 : window.innerHeight)
  const resizer = createComposerResizer({
    measure: () => measure() ?? COMPOSER_MIN_HEIGHT,
    viewport,
    storage: composerStorage(),
    onChange: setHeight,
  })
  setHeight(resizer.height())

  onMount(() => {
    const refit = () => resizer.refit()
    window.addEventListener("resize", refit)
    onCleanup(() => window.removeEventListener("resize", refit))
  })

  return { height, resizer }
}

/** Inline style that pins the text area to the user's chosen height. */
export function composerHeightStyle(height: number | undefined) {
  if (height === undefined) return undefined
  return { "min-height": `${height}px`, "max-height": `${height}px` }
}

export function ComposerResizeHandle(props: {
  resize: ComposerResize
  label?: string
  /** Colour classes for the grip pill; the pill is only visible on hover/focus/drag. */
  gripClass?: string
}) {
  const resizer = () => props.resize.resizer
  const [dragging, setDragging] = createSignal(false)
  const finish = () => {
    resizer().end()
    setDragging(false)
  }

  return (
    <div
      data-component="composer-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={props.label ?? "Resize message box"}
      aria-valuemin={COMPOSER_MIN_HEIGHT}
      aria-valuemax={composerMaxHeight(typeof window === "undefined" ? 800 : window.innerHeight)}
      aria-valuenow={props.resize.height()}
      tabindex="0"
      title="Drag to resize · double-click to reset"
      class="group/resize absolute inset-x-0 top-0 z-30 flex h-2 cursor-ns-resize touch-none select-none items-start justify-center outline-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        resizer().begin(event.clientY)
        setDragging(true)
      }}
      onPointerMove={(event) => resizer().move(event.clientY)}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onDblClick={() => resizer().reset()}
      onKeyDown={(event) => {
        if (resizer().key(event.key)) event.preventDefault()
      }}
    >
      <div
        class={`mt-0.5 h-1 w-10 rounded-full transition-opacity ${props.gripClass ?? "bg-current"}`}
        classList={{
          "opacity-0": !dragging(),
          "group-hover/resize:opacity-40 group-focus-visible/resize:opacity-40": !dragging(),
          "opacity-60": dragging(),
        }}
      />
    </div>
  )
}

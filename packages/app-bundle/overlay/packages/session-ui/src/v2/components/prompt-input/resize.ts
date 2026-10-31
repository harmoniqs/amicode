// Drag-to-resize state for the chat composer (amicode#612).
//
// Pure and dependency-free so both composers (the legacy `PromptInput` in the
// app package and `PromptInputV2` here) share ONE behavior and the logic is
// testable without a DOM. The components own only the markup + a Solid signal;
// this module owns clamping, the drag math, keyboard steps, and persistence.
//
// Semantics: the stored number is the editor's *visible text-area height* in
// px. `undefined` means "never resized" — the composer keeps its stock
// auto-grow-up-to-a-cap behavior, byte-identical to before.

export const COMPOSER_HEIGHT_KEY = "amicode.composer.height"
/** Smallest height the handle can shrink the text area to. */
export const COMPOSER_MIN_HEIGHT = 60
/** Largest height as a fraction of the viewport, so the timeline stays visible. */
export const COMPOSER_MAX_VIEWPORT_FRACTION = 0.6
/** Pixels moved per ArrowUp / ArrowDown press on the focused handle. */
export const COMPOSER_KEY_STEP = 24

export type ComposerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function composerMaxHeight(viewportHeight: number): number {
  const max = Math.floor(viewportHeight * COMPOSER_MAX_VIEWPORT_FRACTION)
  return Math.max(COMPOSER_MIN_HEIGHT, Number.isFinite(max) ? max : COMPOSER_MIN_HEIGHT)
}

export function clampComposerHeight(height: number, viewportHeight: number): number {
  if (!Number.isFinite(height)) return COMPOSER_MIN_HEIGHT
  return Math.round(Math.min(composerMaxHeight(viewportHeight), Math.max(COMPOSER_MIN_HEIGHT, height)))
}

/** Dragging the TOP edge up (smaller clientY) makes the composer taller. */
export function dragComposerHeight(startHeight: number, startY: number, currentY: number, viewportHeight: number) {
  return clampComposerHeight(startHeight + (startY - currentY), viewportHeight)
}

export function readComposerHeight(storage: ComposerStorage | undefined): number | undefined {
  if (!storage) return undefined
  try {
    const raw = storage.getItem(COMPOSER_HEIGHT_KEY)
    if (raw === null) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value) || value <= 0) return undefined
    return Math.round(value)
  } catch {
    return undefined
  }
}

export function writeComposerHeight(storage: ComposerStorage | undefined, height: number | undefined) {
  if (!storage) return
  try {
    if (height === undefined) storage.removeItem(COMPOSER_HEIGHT_KEY)
    else storage.setItem(COMPOSER_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // Storage can be unavailable or full (private mode, webview quota); the
    // resize still works for this session.
  }
}

export function composerStorage(): ComposerStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

export type ComposerResizeOptions = {
  /** Current rendered height of the text area, used as the drag origin. */
  measure: () => number
  viewport: () => number
  storage?: ComposerStorage
  /** Fired whenever the height (or its absence) changes. */
  onChange: (height: number | undefined) => void
}

export type ComposerResizer = {
  height: () => number | undefined
  /** Re-clamp against the current viewport (call on window resize). */
  refit: () => void
  begin: (clientY: number) => void
  move: (clientY: number) => void
  end: () => void
  dragging: () => boolean
  /** ArrowUp/ArrowDown on the focused handle; returns true when handled. */
  key: (key: string) => boolean
  /** Back to the stock auto-height (double-click on the handle). */
  reset: () => void
}

export function createComposerResizer(options: ComposerResizeOptions): ComposerResizer {
  let height = readComposerHeight(options.storage)
  let dragging = false
  let startY = 0
  let startHeight = 0

  const apply = (next: number | undefined, persist: boolean) => {
    if (next === height) return
    height = next
    if (persist) writeComposerHeight(options.storage, next)
    options.onChange(next)
  }

  const current = () => (height === undefined ? options.measure() : clampComposerHeight(height, options.viewport()))

  return {
    height: () => (height === undefined ? undefined : clampComposerHeight(height, options.viewport())),
    refit: () => {
      if (height === undefined) return
      const next = clampComposerHeight(height, options.viewport())
      // Display-only clamp: keep the user's preferred value in storage so a
      // bigger window restores it.
      options.onChange(next)
    },
    begin: (clientY) => {
      dragging = true
      startY = clientY
      startHeight = current()
    },
    move: (clientY) => {
      if (!dragging) return
      apply(dragComposerHeight(startHeight, startY, clientY, options.viewport()), false)
    },
    end: () => {
      if (!dragging) return
      dragging = false
      // Persist once, on release, not on every pointermove.
      if (height !== undefined) writeComposerHeight(options.storage, height)
    },
    dragging: () => dragging,
    key: (key) => {
      if (key !== "ArrowUp" && key !== "ArrowDown") return false
      const delta = key === "ArrowUp" ? COMPOSER_KEY_STEP : -COMPOSER_KEY_STEP
      apply(clampComposerHeight(current() + delta, options.viewport()), true)
      return true
    },
    reset: () => {
      dragging = false
      apply(undefined, true)
    },
  }
}

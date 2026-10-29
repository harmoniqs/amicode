/**
 * #1248 — composer focus/caret restore on a session tab switch.
 *
 * Clicking a session tab moves focus to the tab button, and the composer is
 * not remounted (non-keyed Show), so nothing gives it focus back. The decision
 * of whether to refocus, and where to put the caret, lives here as a pure
 * function so it can be tested without mounting the session page.
 *
 * The guards mirror the page's type-to-focus path (`handleKeyDown` in
 * session.tsx): no refocus for a child session, a blocked composer, an open
 * dialog, or while focus sits inside `[data-prevent-autofocus]` or in another
 * text-entry surface (the terminal's xterm textarea, a CM6 editor, any input).
 * Unlike type-to-focus, a focused BUTTON does not block: the tab the user just
 * clicked is a button, and taking focus off it is the point.
 */

export type ComposerRefocusInput = {
  /** Session key after the switch. */
  key: string | undefined
  /** Session key before the switch. */
  prevKey: string | undefined
  childSession: boolean
  composerBlocked: boolean
  dialogActive: boolean
  /** The (shadow-piercing) active element when the refocus would run. */
  active: Element | null | undefined
  /** The composer's editor element. */
  composer: HTMLElement | null | undefined
  /**
   * The session's saved caret offset — `prompt.cursor()`, which the composer
   * writes on blur, so it holds where the user left the caret in that session.
   */
  saved: number | undefined
  /** Prompt length (`promptLength(prompt.current())`) — the end-of-text fallback. */
  length: number
}

/** True when `el` is a text-entry surface whose focus must not be stolen. */
export function isTextEntry(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable
}

/** Caret offset to restore: the saved per-session offset (clamped), else the end. */
export function composerCaretOffset(saved: number | undefined, length: number): number {
  if (saved === undefined || !Number.isFinite(saved)) return length
  return Math.max(0, Math.min(saved, length))
}

/**
 * Returns the caret offset to restore after refocusing the composer, or
 * `undefined` when the composer must not be refocused.
 */
export function composerRefocusOffset(input: ComposerRefocusInput): number | undefined {
  if (!input.key || !input.prevKey || input.key === input.prevKey) return undefined
  if (!input.composer) return undefined
  if (input.childSession || input.composerBlocked || input.dialogActive) return undefined
  const active = input.active
  if (active && active !== input.composer && !input.composer.contains(active)) {
    if (active.closest("[data-prevent-autofocus]")) return undefined
    if (isTextEntry(active)) return undefined
  }
  return composerCaretOffset(input.saved, input.length)
}

/**
 * PdfFindPill — the find UI for a Preview PDF pane (S1).
 *
 * Mirrors the upstream FileSearchBar layout (magnifier, input, n/m counter,
 * prev/next chevrons, close) but rendered INSIDE the pane's floating
 * controls ([data-preview-controls]) rather than a Portal — the pill is one
 * of the pane's pills, sharing the h-7 / border / blur surface tokens, and
 * it is EXEMPT from the 2s idle auto-hide that governs the other floating
 * controls (the parent gates that on `findOpen`).
 *
 * Keyboard: Enter / Shift+Enter step, Esc closes. Cmd+G / Shift+Cmd+G are
 * handled at the command-registry level and route through the same
 * onNext/onPrev.
 *
 * @module
 */

import { Icon } from "@opencode-ai/ui/icon"

export function PdfFindPill(props: {
  query: () => string
  /** 0-based index of the current match; display adds 1. */
  index: () => number
  /** Total match count. */
  count: () => number
  /** False when the PDF has no searchable text layer. */
  hasText: () => boolean
  setInput: (el: HTMLInputElement) => void
  onInput: (value: string) => void
  onKeyDown: (event: KeyboardEvent) => void
  onClose: () => void
  onPrev: () => void
  onNext: () => void
}) {
  return (
    <div
      data-pdf-find-pill
      class="shrink-0 flex items-center h-7 rounded-md border border-border-base overflow-hidden shadow-sm"
      style={{
        background: "color-mix(in srgb, var(--background-base) 80%, transparent)",
        "backdrop-filter": "blur(4px)",
      }}
      // Keep the pane's wrapper mouse handlers from treating pill interaction
      // as idle — the parent exempts the pill from auto-hide while open.
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span class="pl-2 flex items-center text-text-weak" aria-hidden="true">
        <Icon name="magnifying-glass" size="small" />
      </span>
      <input
        ref={props.setInput}
        data-pdf-find-input
        type="text"
        placeholder="Find"
        aria-label="Find in PDF"
        value={props.query()}
        class="w-36 h-full px-1.5 text-12-regular text-text-base bg-transparent outline-none placeholder:text-text-weak"
        onInput={(event) => props.onInput(event.currentTarget.value)}
        onKeyDown={(event) => props.onKeyDown(event as unknown as KeyboardEvent)}
      />
      <div
        data-pdf-find-count
        class="shrink-0 text-12-regular text-text-weak tabular-nums text-right pr-1.5"
        style={{ width: "10ch" }}
        role="status"
        aria-live="polite"
      >
        {!props.hasText()
          ? "No searchable text in this PDF"
          : props.count() > 0
            ? `${props.index() + 1}/${props.count()}`
            : props.query()
              ? "0/0"
              : ""}
      </div>
      <div class="flex items-center border-l border-border-base">
        <button
          type="button"
          class="flex items-center justify-center w-6 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.count() === 0}
          aria-label="Previous match"
          onClick={props.onPrev}
        >
          <Icon name="chevron-right" size="small" class="-rotate-90" />
        </button>
        <button
          type="button"
          class="flex items-center justify-center w-6 h-full text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          disabled={props.count() === 0}
          aria-label="Next match"
          onClick={props.onNext}
        >
          <Icon name="chevron-right" size="small" class="rotate-90" />
        </button>
      </div>
      <button
        type="button"
        class="flex items-center justify-center w-6 h-full border-l border-border-base text-text-weak hover:text-text-base hover:bg-background-stronger transition-colors"
        aria-label="Close find"
        onClick={props.onClose}
      >
        <Icon name="close-small" size="small" />
      </button>
    </div>
  )
}

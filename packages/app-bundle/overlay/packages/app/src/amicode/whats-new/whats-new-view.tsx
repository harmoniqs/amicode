import type { JSX } from "solid-js"
import type { CardView } from "./whats-new-model"

// amicode#2020: the What's-new page's markup. A fixed frame — pinned header,
// ONE scrolling region holding the cards, pinned footer with Continue — so the
// Continue button can never hide at the bottom of a long scroll.
//
// Plain markup on purpose — no Show/For/classList — so the DOM test can render
// it without Solid's DOM transform (whats-new-view.test.tsx). What the cards
// SHOW (expanded, clamped, ordering, New-for-you placement) is decided in
// whats-new-model.ts; the controller (whats-new.tsx) owns the signals and
// re-renders a card when its state changes. Geometry/colour come from the
// amicode design-system tokens (design-polish.css): --radius-*, --space via the
// 4px grid, --v2-* surfaces, and the single-yellow accent (black-on-yellow
// CTA; soft accent fill for "New for you"; never yellow ink on light).

const fmtDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`)
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : d
}

/** Focus lands on Continue when the page opens. */
export function focusContinue(root: ParentNode) {
  ;(root.querySelector('[data-action="whats-new-continue"]') as HTMLElement | null)?.focus()
}

const FOCUS =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--v2-border-border-focus)]"

export function WhatsNewFrame(props: {
  title: string
  version: string
  summary: string
  notesHref: string | null
  onContinue: () => void
  onOpenNotes: (href: string) => void
  children?: JSX.Element
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="What's new in Amicode"
      data-component="amicode-whats-new"
      class="fixed inset-0 z-[200] flex justify-center bg-background-base"
    >
      <div class="flex h-full w-full max-w-[640px] flex-col">
        <div
          data-slot="whats-new-header"
          class="flex shrink-0 flex-col gap-1 border-b border-[var(--v2-border-border-muted)] px-6 pt-6 pb-4"
        >
          <div class="flex items-baseline justify-between gap-2">
            <div class="text-16-medium text-text-strong">{props.title}</div>
            <div class="text-12-regular text-text-weak">Version {props.version}</div>
          </div>
          <div data-slot="whats-new-summary" class="text-13-regular text-text-base">
            {props.summary}
          </div>
        </div>
        <div data-slot="whats-new-scroll" class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          <div class="flex flex-col gap-3">{props.children}</div>
        </div>
        <div
          data-slot="whats-new-footer"
          class="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--v2-border-border-base)] bg-background-base px-6 py-3"
        >
          {props.notesHref ? (
            <a
              data-slot="whats-new-notes"
              class={`rounded-[var(--radius-sm)] text-12-regular text-text-weak underline hover:text-text-base ${FOCUS}`}
              href={props.notesHref}
              target="_blank"
              rel="noreferrer"
              onClick={(e: MouseEvent) => {
                e.preventDefault()
                props.onOpenNotes(props.notesHref!)
              }}
            >
              Release notes
            </a>
          ) : null}
          <button
            type="button"
            data-action="whats-new-continue"
            class={`ml-auto h-8 cursor-pointer rounded-[var(--radius-md)] border border-[var(--accent-edge-ink)] bg-[var(--accent)] px-4 text-13-medium text-[var(--accent-ink)] transition-opacity hover:opacity-90 ${FOCUS}`}
            onClick={props.onContinue}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

export function WhatsNewWelcome() {
  return (
    <div
      data-slot="whats-new-welcome"
      class="flex flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)] p-4"
    >
      <div class="text-14-medium text-text-strong">Conversational research, in your editor</div>
      <div class="text-13-regular leading-5 text-text-base">
        Start a session and describe what you want to explore. Amicode connects your vaults, models and compute, and
        runs the work where you can watch it. This page comes back after each update with what changed.
      </div>
    </div>
  )
}

function Chevron(props: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      class={`shrink-0 text-text-weak ${props.open ? "" : "-rotate-90"}`}
    >
      <path d="M6.6665 8.33325L9.99984 11.6666L13.3332 8.33325" stroke="currentColor" stroke-linecap="square" />
    </svg>
  )
}

export function WhatsNewCardView(props: {
  card: CardView
  onToggleCard: (version: string) => void
  onToggleMore: (key: string) => void
}) {
  const c = props.card
  return (
    <div
      data-slot="whats-new-card"
      data-version={c.version}
      data-expanded={c.expanded ? "true" : "false"}
      class="flex flex-col rounded-[var(--radius-lg)] border border-[var(--v2-border-border-base)] bg-[var(--v2-background-bg-layer-01)]"
    >
      <button
        type="button"
        data-slot="whats-new-card-toggle"
        aria-expanded={c.expanded ? "true" : "false"}
        aria-label={`${c.expanded ? "Collapse" : "Expand"} ${c.version}`}
        class={`flex w-full cursor-pointer items-center gap-2 rounded-[var(--radius-lg)] px-4 py-3 text-left hover:bg-[var(--accent-fill-soft)] ${FOCUS}`}
        onClick={() => props.onToggleCard(c.version)}
      >
        <Chevron open={c.expanded} />
        <span class="min-w-0 flex-1 text-14-medium text-text-strong">{c.version}</span>
        {c.expanded ? null : (
          <span class="text-12-regular text-text-weak">
            {c.highlightCount} {c.highlightCount === 1 ? "highlight" : "highlights"}
          </span>
        )}
        <span class="text-12-regular text-text-weak">{fmtDate(c.date)}</span>
      </button>
      {c.expanded ? (
        <div data-slot="whats-new-card-body" class="flex flex-col gap-4 px-4 pt-1 pb-4">
          {c.newForYou.length > 0 ? (
            <div
              data-slot="new-for-you"
              class="flex flex-col gap-1 rounded-[var(--radius-md)] border border-[var(--accent-edge)] bg-[var(--accent-fill-soft)] p-3"
            >
              <div class="text-12-medium text-text-strong">New for you</div>
              <div class="text-12-regular text-text-base">Models now available to your account:</div>
              {c.newForYou.map((m) => (
                <div class="text-13-regular text-text-strong">
                  {m.model} <span class="text-text-weak">· {m.provider}</span>
                </div>
              ))}
            </div>
          ) : null}
          {c.highlights.map((h) => (
            <div data-slot="whats-new-highlight" class="flex items-start gap-3">
              <span
                data-slot="whats-new-marker"
                aria-hidden="true"
                class="mt-[7px] size-1.5 shrink-0 rounded-[var(--radius-full)] bg-[var(--v2-text-text-muted)]"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <div data-slot="whats-new-highlight-title" class="text-14-medium text-text-strong">
                  {h.title}
                </div>
                {h.body ? (
                  <div
                    data-slot="whats-new-highlight-body"
                    class={`text-13-regular leading-5 text-text-base whitespace-pre-line ${h.clamped ? "line-clamp-2" : ""}`}
                  >
                    {h.body}
                  </div>
                ) : null}
                {h.canToggle ? (
                  <button
                    type="button"
                    data-slot="whats-new-more"
                    data-key={h.key}
                    aria-expanded={h.clamped ? "false" : "true"}
                    class={`cursor-pointer self-start rounded-[var(--radius-sm)] text-12-medium text-text-weak underline hover:text-text-base ${FOCUS}`}
                    onClick={() => props.onToggleMore(h.key)}
                  >
                    {h.clamped ? "Show more" : "Show less"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {c.body ? (
            <div class="flex flex-col gap-1">
              <div
                data-slot="whats-new-card-text"
                class={`text-13-regular leading-5 text-text-weak whitespace-pre-line ${c.bodyClamped ? "line-clamp-2" : ""}`}
              >
                {c.body}
              </div>
              {c.bodyCanToggle ? (
                <button
                  type="button"
                  data-slot="whats-new-more"
                  data-key={c.bodyKey}
                  aria-expanded={c.bodyClamped ? "false" : "true"}
                  class={`cursor-pointer self-start rounded-[var(--radius-sm)] text-12-medium text-text-weak underline hover:text-text-base ${FOCUS}`}
                  onClick={() => props.onToggleMore(c.bodyKey)}
                >
                  {c.bodyClamped ? "Show more" : "Show less"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

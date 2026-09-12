import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { Portal } from "solid-js/web"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"

// AMICODE: overture Stage 7 — the studio walkthrough. The onboarding score
// emits one question card per tour beat with a verbatim "Tour · <Surface>"
// header; this module maps those headers onto whichever chrome element carries
// the matching data-tour-target attribute and rings it while the card is up.
// Degrades to nothing when the header is unknown or the element is absent —
// the card in the chat still reads on its own.

export const TOUR_HEADER_PREFIX = "Tour · "

/** Which question inside the current card is showing. The whole tour rides in a
 *  SINGLE multi-question card so stepping between beats costs no model round
 *  trip — the dock publishes its active tab here and the spotlight follows. */
const [tourQuestionIndex, setTourQuestionIndex] = createSignal(0)
export { setTourQuestionIndex }

/** Header suffix → the data-tour-target candidates for that beat, best first.
 *  A beat may name a precise control that only exists in some states: the
 *  Pulse Inspector and Preview live in the side panel's own menu, which is not
 *  mounted until the panel is open, so they fall back to the panel toggle that
 *  is always there. The first candidate actually on screen wins. */
const anchor = (key: string) => `[data-tour-target="${key}"]`

const TOUR_TARGETS: Record<string, readonly string[]> = {
  // The real input first, so the ring traces the composer itself; the dock
  // column is the fallback for layouts where the input is not mounted.
  Composer: ['[data-component="prompt-input-v2"]', anchor("composer")],
  Tabs: [anchor("tabs")],
  "New chat": [anchor("new-chat")],
  Sessions: [anchor("sessions")],
  Context: [anchor("context-ring")],
  // One stop for the whole panel: the Pulse Inspector, Preview and the file
  // list all live behind it, and separate stops re-lit the identical button.
  "Side panel": [anchor("side-panel")],
  Status: [anchor("status")],
  Profile: [anchor("profile")],
  Settings: [anchor("settings")],
}

/** The data-tour-target candidates for a question request, or undefined when
 *  the request is not a recognized tour beat. Pure — unit-tested. */
export function tourTargetKeys(
  request: Pick<QuestionRequest, "questions"> | undefined,
  index = 0,
): readonly string[] | undefined {
  const header = request?.questions?.[index]?.header
  if (!header?.startsWith(TOUR_HEADER_PREFIX)) return undefined
  return TOUR_TARGETS[header.slice(TOUR_HEADER_PREFIX.length)]
}

/** True when this card is a tour stop. The tour narrates; it does not ask, so
 *  it must not block the composer the way a real question does — the Composer
 *  stop has to have a composer on screen to ring. Pure. */
export function isTourRequest(request: Pick<QuestionRequest, "questions"> | undefined): boolean {
  return !!request?.questions?.some((q) => q.header?.startsWith(TOUR_HEADER_PREFIX))
}

/** First candidate element that is actually rendered with a size. A surface can
 *  be in the DOM more than once (a compact and a full variant, say) with only
 *  one of them showing, so size — not mere presence — decides. */
function resolveTourElement(selectors: readonly string[]): Element | undefined {
  for (const selector of selectors) {
    for (const el of document.querySelectorAll(selector)) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) return el
    }
  }
  return undefined
}

// The ring traces the element's own edges — no inset, no halo of dead space,
// so it reads as the component itself being lit.
const RING_PAD = 0

type SpotRect = { top: number; left: number; width: number; height: number }

/** The spotlight overlay: a ring around the element the current stop names.
 *  Purely decorative (aria-hidden, pointer-events none) — the narration lives
 *  in the walkthrough card in the chat. */
export function SessionTourSpotlight(props: { request: QuestionRequest | undefined }) {
  // Compare by VALUE. The measure poll runs a few times a second and would
  // otherwise hand back a fresh object every tick, retriggering everything
  // downstream — which restarted the ring's pulse on every tick and read as a
  // rapid blink rather than a slow breath.
  const sameRect = (a: SpotRect | undefined, b: SpotRect | undefined) =>
    a === b ||
    (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

  const [rect, setRect] = createSignal<SpotRect | undefined>(undefined, { equals: sameRect })
  // The walkthrough card's own box — the second hole in the scrim, so the thing
  // doing the explaining stays as sharp as the thing being explained.
  const [cardRect, setCardRect] = createSignal<SpotRect | undefined>(undefined, { equals: sameRect })

  /** Full-viewport rect minus the two holes, even-odd so the inner subpaths
   *  punch through. Plain rectangles: the ring's 4px corners sit on top of the
   *  hole's corners, so the difference is not visible. */
  const scrimPath = (target: SpotRect, card: SpotRect | undefined) => {
    const hole = (r: SpotRect) =>
      ` M${r.left},${r.top} H${r.left + r.width} V${r.top + r.height} H${r.left} Z`
    const outer = `M0,0 H${window.innerWidth} V${window.innerHeight} H0 Z`
    return `path(evenodd, "${outer}${hole(target)}${card ? hole(card) : ""}")`
  }

  createEffect(() => {
    const keys = tourTargetKeys(props.request, tourQuestionIndex())
    setRect(undefined)
    setCardRect(undefined)
    if (!keys) return
    const measure = () => {
      const card = document.querySelector('[data-component="session-question-dock"]')?.getBoundingClientRect()
      setCardRect(card ? { top: card.top, left: card.left, width: card.width, height: card.height } : undefined)
      const r = resolveTourElement(keys)?.getBoundingClientRect()
      if (!r) {
        setRect(undefined)
        return
      }
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height })
    }
    measure()
    // The chrome can move under the overlay (tab churn, panel opens, window
    // resize); a slow poll plus the cheap listeners keeps the ring honest
    // without observing every layout container.
    const interval = setInterval(measure, 300)
    window.addEventListener("resize", measure)
    window.addEventListener("scroll", measure, true)
    onCleanup(() => {
      clearInterval(interval)
      window.removeEventListener("resize", measure)
      window.removeEventListener("scroll", measure, true)
    })
  })

  // NOT keyed: a keyed Show tears the overlay down and builds it again whenever
  // the rect changes, which restarts the CSS animation. Un-keyed, the nodes
  // persist for the whole stop and only their style updates, so the pulse runs
  // its full slow cycle uninterrupted.
  //
  // The ring is the whole marker. There is no label: the stop's own text names
  // the surface, so a floating name would only repeat it and cover whatever it
  // was placed over.
  return (
    <Show when={rect()}>
      <Portal>
        <div data-component="amc-tour-spotlight" aria-hidden="true">
          <div class="amc-tour-scrim" style={{ "clip-path": scrimPath(rect()!, cardRect()) }} />
          {/* Keyed on the STOP, so the arrive animation replays once when the
              highlight lands on a new element — and not on every measure tick,
              which is what made an earlier version strobe. Position still
              updates in place; only a stop change rebuilds. */}
          <Show when={tourQuestionIndex() + 1} keyed>
            <div
              class="amc-tour-ring"
              style={{
                top: `${rect()!.top - RING_PAD}px`,
                left: `${rect()!.left - RING_PAD}px`,
                width: `${rect()!.width + RING_PAD * 2}px`,
                height: `${rect()!.height + RING_PAD * 2}px`,
              }}
            />
          </Show>
        </div>
      </Portal>
    </Show>
  )
}

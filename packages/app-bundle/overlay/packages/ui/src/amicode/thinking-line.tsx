import { createSignal, onCleanup, onMount, Show, type ComponentProps } from "solid-js"
import { shuffledWordAt, SHUFFLED_WORDS, formatElapsed, formatTokens } from "./thinking"
import { AmicoWave } from "./amico-wave"

// AMICODE: the "thinking" working indicator — a two-row block shown while a
// reply streams (app TimelineThinkingRow; session-ui lane in message-part.tsx).
// Row 1: harmonic wave (amico-wave.tsx) + the cycling gerund. Row 2:
// the live meta line (elapsed · tokens · esc), starting under the wave.
// Pure bits (word rotation, label formatting) live in ./thinking for testing.
//
// Layout invariants (earned the hard way — the CSS side lives in amicode.css):
//  - the meta can NEVER wrap mid-phrase — the old flex row once let a greedy
//    sibling heading squeeze it until "↑ 8.7k tokens" shattered across three
//    lines and baseline alignment scattered the mark/wave/verb;
//  - the verb reserves the longest gerund's width, so word rotation never
//    shifts the layout around it;
//  - the meta row renders from mount (elapsed always ticks), so the block's
//    height is constant whether or not tokens/hints are present.
//
// DOM order is word-first on purpose: a grid container's first baseline comes
// from its first grid item, and putting the word first makes the block's
// baseline the VERB's baseline — so the sibling activity heading
// (session-turn-thinking, align-items: baseline) aligns with the verb, not the
// mark's bottom edge. Explicit grid placement keeps the visual order.
//
// Motion: the wave animates continuously (CSS, amicode.css) and the word swaps
// on a ~2s timer, with no shimmer. Under prefers-reduced-motion the word is
// static ("Thinking…"); the elapsed counter still advances regardless (it's
// information, not decoration). Timers clear onCleanup so a finished turn stops
// ticking.
//
// a11y: the ticking parts are aria-hidden and a single sr-only role=status
// announces the working state ONCE — the old aria-live="polite" wrapper
// re-announced every word rotation every 2s.

const WORD_MS = 2000
const TICK_MS = 1000

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

export function ThinkingLine(props: {
  /** streamed token count so far; when omitted the tokens chip is hidden */
  tokens?: number
  /** show the "esc to interrupt" hint — only pass when the mount site wires esc */
  interruptible?: boolean
  /** @deprecated no-op — the H-mark was removed (wave+verb is the indicator now); kept for compat */
  mark?: boolean
  class?: string
  style?: ComponentProps<"span">["style"]
}) {
  const still = reducedMotion()
  const [elapsedMs, setElapsedMs] = createSignal(0)
  // Random start so each turn/mount opens on a different verb; the module-level
  // shuffle already decorrelates reloads, this decorrelates simultaneous mounts.
  const [tick, setTick] = createSignal(Math.floor(Math.random() * SHUFFLED_WORDS.length))

  onMount(() => {
    const start = Date.now()
    const clock = setInterval(() => setElapsedMs(Date.now() - start), TICK_MS)
    onCleanup(() => clearInterval(clock))
    if (!still) {
      const words = setInterval(() => setTick((n) => n + 1), WORD_MS)
      onCleanup(() => clearInterval(words))
    }
  })

  const word = () => (still ? "Thinking" : shuffledWordAt(tick()))

  return (
    <span
      class={`amc-thinking${props.class ? " " + props.class : ""}`}
      data-slot="amc-thinking"
      style={props.style}
    >
      <span class="sr-only" role="status">
        Amico is thinking…
      </span>
      {/* word first in DOM (baseline — see header); grid places it visually */}
      <span class="amc-thinking-word" aria-hidden="true">
        {word()}…
      </span>
      <AmicoWave />
      <span class="amc-thinking-meta" aria-hidden="true">
        <span class="amc-thinking-elapsed">{formatElapsed(elapsedMs())}</span>
        <Show when={props.tokens != null}>
          <span class="amc-thinking-sep">·</span>
          <span class="amc-thinking-tokens">↑ {formatTokens(props.tokens!)} tokens</span>
        </Show>
        <Show when={props.interruptible}>
          <span class="amc-thinking-sep">·</span>
          <span class="amc-thinking-hint">esc to interrupt</span>
        </Show>
      </span>
    </span>
  )
}

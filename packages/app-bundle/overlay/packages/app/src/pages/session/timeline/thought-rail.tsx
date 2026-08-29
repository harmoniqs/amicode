// AMICODE: the thought rail — a vertical spine down a turn's assistant steps,
// ported from the website's /amicode animation (harmoniqs-ai
// app/components/demo/parts.jsx, `Step`).
//
// The active (running) dot is a spherical-harmonic morphing indicator
// (HarmonicDot) that replaces the old breathing box-shadow ring. It grows
// from 7px (done size) to 13px when in flight, centered on LINE_X.
//
// Six geometry rules — keep them together, they are the whole rail. A
// standalone, framework-agnostic snippet is at the bottom of this header.
//
// 1. Per-row segments, not a container border. Forced by virtualization:
//    @tanstack/solid-virtual renders every row as an absolutely-positioned
//    box; consecutive rows share no ancestor except the height spacer, so
//    border-left on a wrapper is structurally impossible. Each row draws
//    its own 1px span and they meet. The site arrived at the same per-row
//    approach independently, which is why the port is cheap.
//
// 2. Segments reach up through the gap above them. TimelineRowFrame
//    (message-timeline.tsx) puts `pt-3` on every step after the first, and
//    the rail's positioning ancestor — the inner `session-turn` div — sits
//    INSIDE that padding. A segment anchored at `top: 0` therefore starts
//    12px below where the previous one ended and you get a dashed column.
//    Fix is `top: calc(var(--space-3) * -1)` (NEG_STEP_GAP). Most "rounding"
//    reports are this gap, not rounding.
//
// 3. Caps land on the dot centre. dotCentre defaults to 11px (the centre of
//    a 22px first text line starting at the row's top — what prose and
//    rail-label rows produce) and is MEASURED per row by TimelineRowFrame
//    for content that opens with a card, so the dot always sits on the
//    text it coincides with. First segment starts there, last stops there:
//    the tail is `height = STEP_GAP + dotCentre` from NEG_STEP_GAP (so its
//    bottom is dotCentre), and the first mid segment is `top: dotCentre`.
//    Segments and dot share the one value, so alignment can never detach
//    the spine from its dots. PR #242 fixed the 1–2px stub that peeked past
//    the dot from the old inline math plus the 0.5px centring in
//    LINE_X = GUTTER + NODE/2 - 0.5. Lone first+last is zero-height by
//    intent — see shouldRenderRail.
//
// 4. "Done" is adjacency, not lifecycle. A step is finished once a
//    successor exists. Tools complete out of order and run in parallel, so
//    asking each row "am I done?" lets a filled dot sit above a hollow one
//    and destroys the rail's grammar. Adjacency makes the sequence monotonic
//    by construction — exactly what the website does (a step flips no later
//    than when the next one appears). Hollow therefore means RUNNING — the
//    tail of a turn still in flight — never "planned". The site never
//    previews future steps either (gated on `t >= from`); a plan source
//    would be score stages, a later step.
//
// 5. Two details worth keeping:
//    - Gutter, not flush. GUTTER=8, NODE=7, content clears at pl-6 (24px).
//      GUTTER+NODE=15px stays inside the inset and leaves ~9px dot-to-content
//      breath (pl-4 left a 1px glue). Flush at left:0 clips the live ring
//      below the md breakpoint where the message column has no padding and
//      begins at the viewport edge.
//    - The rail is one INK stroke (Kate 2026-08-24). Line and done dots both
//      take text-base — the fg, literal black on light, near-white on dark —
//      the way the site's Step draws its dots (border-fg + bg-fg). Muted
//      grey read as washed out; an accent line was invisible on light
//      (#FFE614 ≈ 1.3:1 on white) and made a running spine read as
//      disconnected floating dots. Yellow marks ONLY the active node
//      (--accent / --accent-edge — the ink ring defines it on light, where
//      the fill alone is ~1.2:1). Never border-border-strong for any of it:
//      white@20% on the dark ground composites to #4C4C4C = 1.92:1, under
//      the 3:1 a UI mark needs.
//
// 6. shouldRenderRail is polish: a lone COMPLETED step renders nothing (one
//    dot is decoration, not a sequence). A lone RUNNING step DOES rail —
//    its dot is the turn's only "working" signal (card sig / Livedot are
//    gone) and first steps are often the longest, so waiting for step two
//    left the opening with no status. The lone live dot draws no line
//    (0px) — every spine must end at a dot, so a single dot has no dangling
//    half-spine above or below. A one-step completion still reads as "dot
//    fills".
//
// Other implementation: the harness StepFrame rail on PR #216 slices by SDK
// step-start/step-finish markers instead of assistant-part turns — different
// segmentation model, same geometry problem. Portable math if you need it:
//
//   const NODE = 7, DOT_TOP = 7.5, GUTTER = 8, LINE_X = GUTTER + NODE/2 - 0.5
//   const STEP_GAP = "var(--space-3)", NEG = `calc(${STEP_GAP} * -1)`
//   const dotCentre = DOT_TOP + NODE/2
//   // mid:  { top: first ? dotCentre : NEG, bottom: 0 }
//   // tail: { top: first ? "0px" : NEG, height: first ? "0px" : `calc(${STEP_GAP} + ${dotCentre}px)` }


import { createSignal, onCleanup, Show } from "solid-js"
import { HarmonicDot, HARMONIC_SIZE } from "@opencode-ai/ui/amicode-harmonic-dot"
import { formatElapsed, formatTokens } from "@opencode-ai/ui/amicode-thinking"

const NODE = 7 // dot diameter, px — matches the site's Step

/** Where a row's dot centre sits when nothing measures it: 11px — the centre
 *  of a 22px first text line starting at the row's top, which is what prose
 *  and rail-label rows produce. Rows whose content opens with a CARD (a tool
 *  chip, a group header, a widget preview) start their first text line lower
 *  — measured 16px for a chip row, 26.5px for a widget preview — so
 *  TimelineRowFrame measures the actual first line and passes `dotCentre`
 *  (Kate 2026-08-24: dots must line up with the text they coincide with).
 *  Segment caps derive from the same value, so alignment can never detach
 *  the spine from its dots. */
export const DEFAULT_DOT_CENTRE = 11

// The rail sits in a gutter carved out of the row's own left inset, NOT flush
// against the row edge. Flush was wrong: below the md breakpoint the message
// column has no horizontal padding, so the turn box begins at the scroll
// viewport's edge and a dot at left:0 lands hard against it — with the live
// node's ring clipped away entirely. GUTTER + NODE (15px) stays inside
// THOUGHT_RAIL_INSET, so the rail never pushes content around.
const GUTTER = 8
const LINE_X = GUTTER + NODE / 2 - 0.5 // 1px line centred under the dot

// TimelineRowFrame (message-timeline.tsx) puts `pt-3` on every step after the
// first, and the rail's positioning ancestor — the inner `session-turn` div —
// sits INSIDE that padding. So a segment anchored at top:0 begins 12px below
// where the previous segment ended, and the line reads as a dotted column of
// dashes rather than a spine. Each segment therefore reaches up through the gap
// above it. Same value as the frame's `pt-3`; if that spacing changes, this
// follows it.
const STEP_GAP = "var(--space-3)"
const NEG_STEP_GAP = `calc(${STEP_GAP} * -1)`

export function ThoughtRail(props: {
  /** first step of the turn — the line must not run above the dot */
  first: boolean
  /** last step of the turn — the line must not run below the dot */
  last: boolean
  /** the turn is still working, so this tail step is in flight */
  running: boolean
  /** measured centre of the row's first text line (px from the row's top);
   *  defaults to DEFAULT_DOT_CENTRE for unmeasured/prose rows */
  dotCentre?: number
  /** true once the first measurement has landed — gates the CSS transition
   *  so the initial mount uses the grow animation alone (#265) */
  settled?: boolean
  /** epoch-ms when the user message was created — anchors the tooltip timer */
  turnStartedAt?: number
  /** streamed token count for this turn — shown in the tooltip */
  tokens?: number
}) {
  // Only the tail of a still-running turn is hollow. Everything above it has,
  // by definition, been succeeded. (Rule 4 — adjacency.)
  const isRunning = () => props.last && props.running
  // Rule 3 — cap at dot centre; Rule 2 — NEG_STEP_GAP bridges the pt-3 gap.
  const dotCentre = () => props.dotCentre ?? DEFAULT_DOT_CENTRE
  const dotTop = () => dotCentre() - NODE / 2
  // A lone running step is a single dot with no spine — every line must end
  // AT a dot at both ends. A lone dot has no line, so a one-step completion
  // is just "dot fills" with no dangling half-spine above or below. The
  // morphing harmonic dot is the turn's only "working" signal.
  const isLoneRunning = () => props.first && props.last && props.running
  return (
    <>
      {/* Rail line BEHIND the dot — the SVG's internal background circle
          masks the line within the ring's interior. The line reaches dotCentre
          geometrically to connect with harmonic shapes that extend inward. */}
      <span
        aria-hidden="true"
        data-slot="thought-rail-line"
        class="pointer-events-none absolute w-px"
        style={{
          left: `${LINE_X}px`,
          // Always INK, full strength — yellow belongs to the active node
          // only, and the muted grey read as washed out (Kate 2026-08-24).
          // text-base is the fg: literal black on light, near-white on dark.
          background: "var(--v2-text-text-base)",
          ...(isLoneRunning()
            ? // lone running step — no line, just the breathing dot (0px, like PR 242)
              { top: "0px", height: "0px" }
            : props.last
              ? // tail: capped at the dot centre, never below (Rule 3) — +1px overlap guarantees no 12px dash on subpixel rounding
                {
                  top: props.first ? "0px" : `calc(${NEG_STEP_GAP} - 1px)`,
                  height: props.first ? "0px" : `calc(${STEP_GAP} + ${dotCentre()}px + 1px)`,
                }
              : // mid-run: from dot centre (first) or gap (others) down to row bottom — 1px upward overlap closes the pt-3 seam
                { top: props.first ? `${dotCentre()}px` : `calc(${NEG_STEP_GAP} - 1px)`, bottom: "0px" }),
        }}
      />
      {isRunning() ? (
        // RUNNING: spherical-harmonic morphing dot — 13px SVG centred on LINE_X.
        // The grow animation (7→13px) is a CSS @keyframes on mount; the morph
        // cycles Y_l^m silhouettes via SMIL; slow rotation via CSS on the <g>.
        // The settled class gates the top transition (#265): after the first
        // measurement, subsequent dotCentre changes slide smoothly.
        // Tooltip on hover shows elapsed time + token count (#625).
        <DotWithTooltip
          dotCentre={dotCentre()}
          settled={props.settled}
          turnStartedAt={props.turnStartedAt}
          tokens={props.tokens}
        />
      ) : (
        // DONE: 7px ink circle — the rail is one ink stroke (Rule 5).
        // text-base is the fg: literal black on light, near-white on dark,
        // matching the line so dot + spine read as a single mark.
        // Never border-border-strong: white@20% on dark composites to
        // #4C4C4C = 1.92:1, under the 3:1 a UI mark needs.
        <span
          aria-hidden="true"
          data-slot="thought-rail-dot"
          data-state="done"
          class="pointer-events-none absolute rounded-full"
          style={{
            top: `${dotTop()}px`,
            left: `${GUTTER}px`,
            width: `${NODE}px`,
            height: `${NODE}px`,
            border: "1px solid var(--v2-text-text-base)",
             background: "var(--v2-text-text-base)",
          }}
        />
      )}
    </>
  )
}

/** Running dot with a hover tooltip showing elapsed time + tokens (#625).
 *  The tooltip only renders while hovered to keep DOM cost near zero. The
 *  timer ticks from `turnStartedAt` (the user message's `time.created`), so
 *  it survives component remount across session switches. */
function DotWithTooltip(props: {
  dotCentre: number
  settled?: boolean
  turnStartedAt?: number
  tokens?: number
}) {
  const [hovered, setHovered] = createSignal(false)
  const [elapsedMs, setElapsedMs] = createSignal(0)

  // Tick the timer only while hovered — no cost when tooltip is hidden
  let clock: ReturnType<typeof setInterval> | undefined
  const startTicking = () => {
    if (props.turnStartedAt == null) return
    setElapsedMs(Date.now() - props.turnStartedAt)
    clock = setInterval(() => setElapsedMs(Date.now() - props.turnStartedAt!), 1000)
  }
  const stopTicking = () => {
    if (clock != null) clearInterval(clock)
    clock = undefined
  }
  onCleanup(stopTicking)

  return (
    <span
      class="absolute"
      style={{
        top: `${props.dotCentre - HARMONIC_SIZE / 2}px`,
        left: `${LINE_X - HARMONIC_SIZE / 2}px`,
      }}
      onMouseEnter={() => { setHovered(true); startTicking() }}
      onMouseLeave={() => { setHovered(false); stopTicking() }}
    >
      <HarmonicDot
        class={`pointer-events-none thought-rail-dot--harmonic${props.settled ? " thought-rail-dot--settled" : ""}`}
      />
      <Show when={hovered() && props.turnStartedAt != null}>
        <span
          class="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] tracking-[0.01em] tabular-nums bg-v2-background-bg-elevated text-v2-text-text-faint shadow-sm border border-v2-border-border-base z-50"
          role="status"
        >
          {formatElapsed(elapsedMs())}
          <Show when={props.tokens != null}>
            <span class="mx-1 opacity-55">·</span>
            {formatTokens(props.tokens!)} tokens
          </Show>
        </span>
      </Show>
    </span>
  )
}

/**
 * Eyebrow naming a step's action, for rows whose content doesn't open with its
 * own title (assistant prose, reasoning). Sits on the dot's line so the rail
 * reads as a labelled list of actions; tool cards and group headers are their
 * own labels. Mono, uppercase, faint — the same voice as the timeline's other
 * structural furniture, quieter than the content it introduces.
 */
export function ThoughtRailLabel(props: { label: string }) {
  return (
    <span
      data-slot="thought-rail-label"
      class="block font-mono text-[10px] font-medium uppercase tracking-[0.08em] leading-[22px] text-v2-text-text-faint select-none"
    >
      {props.label}
    </span>
  )
}

/** The gutter a rail occupies, so content clears it. GUTTER + NODE ends at
 *  15px; pl-6 (24px) leaves the same ~9px dot-to-content breath the website's
 *  Step has — pl-4 left a 1px gap and labels read as glued to their dots. (Rule 5) */
export const THOUGHT_RAIL_INSET = "pl-6"

/**
 * Rule 6 — lone COMPLETED steps render nothing (one dot is decoration). A
 * RUNNING turn rails from its very first step, though — the live dot is the
 * timeline's only "working" mark (the card's pulsing sig and Livedot are
 * gone), and a turn's first step is often its longest, so waiting for step
 * two meant the whole opening had no status signal. The lone live dot draws
 * no line — every line must end at a dot at both ends, so a single dot has
 * no dangling half — and a one-step completion still reads as "dot fills".
 */
export function shouldRenderRail(_input: {
  previousAssistantPart: boolean
  lastAssistantPart: boolean
  turnRunning: boolean
}) {
  // The Thinking row is always the first rail node, so every AssistantPart
  // always has at least one other node above it — the rail always renders.
  return true
}

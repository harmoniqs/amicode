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


import { createSignal, onCleanup } from "solid-js"
import { HarmonicDot, HARMONIC_SIZE } from "@opencode-ai/ui/amicode-harmonic-dot"
import { formatElapsed, formatTokens } from "@opencode-ai/ui/amicode-thinking"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
export { DEFAULT_DOT_CENTRE, dotCentreForGroup, shouldRenderRail } from "./thought-rail-pure"

const NODE = 7 // dot diameter, px — matches the site's Step

// The bottom-anchored dot on prose rows sits with its centre at the last
// text line's vertical centre — approximately: card bottom-padding (10px) +
// half body line-height (~11px) = 21px from the row's bottom edge. This is
// a fixed offset, so the dot never jumps — it just rides down as the row grows.
const PROSE_DOT_BOTTOM_INSET = 21

// DEFAULT_DOT_CENTRE, dotCentreForGroup, shouldRenderRail are re-exported
// from ./thought-rail-pure (extracted for test isolation from Kobalte SSR).
import { DEFAULT_DOT_CENTRE } from "./thought-rail-pure"

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
  /** true for prose/text rows (growing content) — dot bottom-anchors.
   *  false for Thinking/tool/shell rows (status cards) — dot at dotCentre. */
  prose: boolean
  /** measured centre of the row's first text line (px from the row's top);
   *  used for done-dot alignment and status-row running dot */
  dotCentre?: number
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
          masks the line within the ring's interior. */}
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
            : props.last && isRunning() && props.prose
              ? // running prose tail: line extends to the dot's vertical centre
                {
                  top: props.first ? "0px" : `calc(${NEG_STEP_GAP} - 1px)`,
                  bottom: `${PROSE_DOT_BOTTOM_INSET}px`,
                }
              : props.last
                ? // completed tail OR running status row: capped at the dot centre
                  {
                    top: props.first ? "0px" : `calc(${NEG_STEP_GAP} - 1px)`,
                    height: props.first ? "0px" : `calc(${STEP_GAP} + ${dotCentre()}px + 1px)`,
                  }
                : // mid-run: from dot centre (first) or gap (others) down to row bottom
                  { top: props.first ? `${dotCentre()}px` : `calc(${NEG_STEP_GAP} - 1px)`, bottom: "0px" }),
        }}
      />
      {isRunning() ? (
        // RUNNING: spherical-harmonic morphing dot.
        // - Prose rows (growing text content): bottom-anchored. As content
        //   grows above it, the row's height increases and the dot rides down
        //   passively — no transitions, no re-renders.
        // - Status rows (Thinking, Shell, Edit, etc.): centred on dotCentre
        //   so the dot aligns with the label text.
        // Tooltip on hover shows elapsed time + token count (#625).
        <DotWithTooltip
          bottomAnchored={props.prose}
          dotCentre={dotCentre()}
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
 *  Two positioning modes:
 *  - bottomAnchored=true: sits at the bottom edge of the row, rides down as
 *    content grows above it. Used for AssistantPart content rows.
 *  - bottomAnchored=false: sits at dotCentre (first-line aligned). Used for
 *    the Thinking row and status rows where the dot signals "working" beside
 *    a fixed label, not below growing content.
 *  Uses TooltipV2 (placement="bottom") so the popup renders below the dot and
 *  never occludes the rail or chat content above. The timer ticks from
 *  `turnStartedAt` (the user message's `time.created`), so it survives
 *  component remount across session switches. */
function DotWithTooltip(props: {
  bottomAnchored: boolean
  dotCentre: number
  turnStartedAt?: number
  tokens?: number
}) {
  // Tick elapsed time every second while this component is mounted.
  // Only one running dot exists at a time, so the cost is trivial.
  const [elapsedMs, setElapsedMs] = createSignal(
    props.turnStartedAt != null ? Date.now() - props.turnStartedAt : 0,
  )
  const clock = setInterval(() => {
    if (props.turnStartedAt != null) setElapsedMs(Date.now() - props.turnStartedAt)
  }, 1000)
  onCleanup(() => clearInterval(clock))

  const tooltipValue = () => {
    if (props.turnStartedAt == null) return undefined
    return (
      <span class="whitespace-nowrap tabular-nums">
        {formatElapsed(elapsedMs())}
        {props.tokens != null && (
          <>
            <span class="mx-1 opacity-55">{"\u00B7"}</span>
            {"\u2191"} {formatTokens(props.tokens!)} tokens
          </>
        )}
      </span>
    )
  }

  return (
    <span
      class="absolute"
      data-slot="thought-rail-dot"
      data-state="running"
      style={{
        top: props.bottomAnchored ? undefined : `${props.dotCentre - HARMONIC_SIZE / 2}px`,
        bottom: props.bottomAnchored ? `${PROSE_DOT_BOTTOM_INSET - HARMONIC_SIZE / 2}px` : undefined,
        left: `${GUTTER + NODE / 2 - HARMONIC_SIZE / 2}px`,
        width: `${HARMONIC_SIZE}px`,
        height: `${HARMONIC_SIZE}px`,
      }}
    >
      <TooltipV2
        placement="bottom"
        value={tooltipValue()}
        inactive={props.turnStartedAt == null}
        openDelay={200}
      >
        <HarmonicDot
          class="thought-rail-dot--harmonic"
        />
      </TooltipV2>
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

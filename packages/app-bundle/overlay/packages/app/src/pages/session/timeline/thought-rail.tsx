// AMICODE: the thought rail — a vertical spine down a turn's assistant steps,
// ported from the website's /amicode animation (harmoniqs-ai
// app/components/demo/parts.jsx, `Step`).
//
// TWO THINGS THAT LOOK LIKE MISTAKES AND ARE NOT:
//
// 1. The rail is drawn as a PER-ROW SEGMENT, not as a border-left on a shared
//    container. It has to be. The timeline is virtualised (@tanstack/solid-virtual):
//    every row is an absolutely-positioned box and consecutive rows share no
//    ancestor except the total-height spacer, so a container spine is structurally
//    impossible here. The site independently arrived at the same per-row approach,
//    which is why the port is cheap. Segments meet because each one reaches UP
//    through the 12px `pt-3` the frame puts above its row — see STEP_GAP below.
//    Anchoring at top:0 alone leaves a 12px break in the line, because the rail's
//    positioning ancestor sits inside that padding rather than around it.
//
// 2. "done" is decided by ADJACENCY — a step is finished once a successor exists —
//    not by that step's own tool lifecycle. Tools can complete out of order or run
//    in parallel, so asking each row "are you finished?" would let a filled dot sit
//    above a hollow one and destroy the rail's grammar. Adjacency makes the
//    sequence monotonic by construction. It is also exactly what the website does:
//    a step flips filled no later than the moment the next one appears.
//
// Hollow therefore means RUNNING (the tail of a turn still in flight), never
// "planned". The website does not preview future steps either — its scenes gate
// every entry on `t >= from`, so an unstarted step is never in the DOM. Showing
// the path ahead needs a real plan source (score stages), which is a later step.


const NODE = 7 // dot diameter, px — matches the site's Step
const DOT_TOP = 7.5 // px from the row's top edge to the dot's top

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
}) {
  // Only the tail of a still-running turn is hollow. Everything above it has,
  // by definition, been succeeded.
  const isRunning = () => props.last && props.running
  // Cap the rail precisely at the dot centre so the first and last segments do
  // not peek past the dot (the previous math left a 1–2px stub due to rounding
  // and the 0.5px centring offset). Continuity is kept by letting each mid-
  // segment reach through the 12px pt-3 gap (NEG_STEP_GAP) so adjacent rows
  // meet without a dotted break.
  const dotCentre = DOT_TOP + NODE / 2
  return (
    <>
      <span
        aria-hidden="true"
        data-slot="thought-rail-line"
        class="pointer-events-none absolute w-px"
        style={{
          left: `${LINE_X}px`,
          background: isRunning() ? "var(--accent)" : "var(--v2-icon-icon-muted)",
          ...(
          props.last
            ? // tail: capped at the dot centre, never below
              {
                top: props.first ? "0px" : NEG_STEP_GAP,
                height: props.first ? "0px" : `calc(${STEP_GAP} + ${dotCentre}px)`,
              }
            : // mid-run: from dot centre (first) or gap (others) down to row bottom
              { top: props.first ? `${dotCentre}px` : NEG_STEP_GAP, bottom: "0px" }),
        }}
      />
      <span
        aria-hidden="true"
        data-slot="thought-rail-dot"
        data-state={isRunning() ? "running" : "done"}
        classList={{
          "pointer-events-none absolute rounded-full": true,
          // hollow + pulsing while in flight, solid once succeeded
          "thought-rail-dot--running": isRunning(),
        }}
        style={{
          top: `${DOT_TOP}px`,
          left: `${GUTTER}px`,
          width: `${NODE}px`,
          height: `${NODE}px`,
          // LIVE is the brand yellow; DONE is icon weight, not border weight.
          //
          // --accent-edge is doing real work on the live node: it resolves to ink
          // on light and to a yellow mix on dark, which is exactly the rule the
          // accent system states — #FFE614 is ~1.2:1 on a light ground, so on
          // light the dot is *defined* by its ink ring, never by the fill. On dark
          // the fill carries it and the edge just tightens the shape.
          //
          // Done dots take icon-icon-muted rather than border-border-strong: the
          // latter is white at 20% on the dark ground, compositing to #4C4C4C =
          // 1.92:1, under the 3:1 a UI mark needs. icon-icon-muted measures
          // 4.58:1 dark and 5.74:1 light.
          border: isRunning() ? "1px solid var(--accent-edge)" : "1px solid var(--v2-icon-icon-muted)",
          background: isRunning() ? "var(--accent)" : "var(--v2-icon-icon-muted)",
        }}
      />
    </>
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
 *  Step has — pl-4 left a 1px gap and labels read as glued to their dots. */
export const THOUGHT_RAIL_INSET = "pl-6"

/**
 * A lone COMPLETED step is not a sequence: one dot on its own reads as
 * decoration, so a finished single-part turn gets nothing. A RUNNING turn rails
 * from its very first step, though — the live dot is the timeline's only
 * "working" mark (the card's pulsing sig and Livedot are gone), and a turn's
 * first step is often its longest, so waiting for step two meant the turn's
 * whole opening had no status signal at all. The lone live dot carries no line
 * (first && last draws zero-height segments), so nothing retracts visibly when
 * a one-step turn completes: the dot simply fills, then yields the row.
 */
export function shouldRenderRail(input: {
  previousAssistantPart: boolean
  lastAssistantPart: boolean
  turnRunning: boolean
}) {
  const isOnlyStep = !input.previousAssistantPart && input.lastAssistantPart
  return !isOnlyStep || input.turnRunning
}

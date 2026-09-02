// packages/ui/src/amicode/harmonic-dot.tsx
// AMICODE: the spherical-harmonic morphing dot — shown on the thought rail's active
// (running) node. Cycles through Y_l^m silhouettes with a pulse rhythm:
// sphere → shape → sphere → shape → ... (the sphere is home base).
//
// DONUT PATH: A single filled path using fill-rule="evenodd" — the outer contour
// draws the harmonic shape clockwise, an inner contour draws a circle counter-
// clockwise to punch the hole. When the inner radius is 0, the hole collapses
// and the shape is solid. SMIL interpolates between donut (ring) and solid
// (harmonic) point-by-point — the ring smoothly closes as the shape blooms.
//
// A background circle sits BEHIND the donut path (but inside the SVG) to mask
// the rail line that runs behind the SVG element. Without it, the line would
// show through the evenodd hole. The circle matches INNER_R so it exactly fills
// the ring's interior during the sphere state and shrinks with it during morphs.
//
// DETERMINISTIC: the sequence is level-ordered (l=1→l=4, pill first within each
// level) with fixed rotation angles — no randomization. Every mount plays the
// same animation. Under prefers-reduced-motion the SMIL animates are hidden —
// static ring.

import { type ComponentProps } from "solid-js"
import {
  HARMONIC_SIZE,
  INNER_R,
  CIRCLE_DONUT_PATH,
  SMIL,
  smilBeginOffset,
} from "./harmonic-geometry"

export function HarmonicDot(props: {
  class?: string
  style?: ComponentProps<"svg">["style"]
}) {
  // Phase-lock: compute once at creation so SMIL picks up the global morph
  // phase instead of restarting from the ring on every remount.
  const begin = smilBeginOffset()
  return (
    <svg
      data-component="harmonic-dot"
      class={`harmonic-dot${props.class ? " " + props.class : ""}`}
      width={HARMONIC_SIZE}
      height={HARMONIC_SIZE}
      viewBox={`0 0 ${HARMONIC_SIZE} ${HARMONIC_SIZE}`}
      shape-rendering="geometricPrecision"
      aria-hidden="true"
      style={props.style}
    >
      {/* Background disc — masks the rail line behind the SVG. Sits behind
          the donut path so it fills the evenodd hole with the page background.
          Radius matches INNER_R; animates to 0 in sync with the donut's inner
          contour so it disappears when the shape goes solid. */}
      <circle
        cx={HARMONIC_SIZE / 2}
        cy={HARMONIC_SIZE / 2}
        r={INNER_R}
        fill="var(--v2-background-bg-base)"
      >
        <animate
          attributeName="r"
          values={SMIL.innerRadius}
          keyTimes={SMIL.keyTimes}
          dur={SMIL.dur}
          begin={begin}
          repeatCount="indefinite"
          calcMode="linear"
        />
      </circle>
      {/* Donut path — the visible ring/shape */}
      <path
        class="harmonic-dot-shape"
        d={CIRCLE_DONUT_PATH}
        fill="var(--accent)"
        fill-rule="evenodd"
      >
        <animate
          attributeName="d"
          values={SMIL.values}
          keyTimes={SMIL.keyTimes}
          dur={SMIL.dur}
          begin={begin}
          repeatCount="indefinite"
          calcMode="linear"
        />
      </path>
    </svg>
  )
}

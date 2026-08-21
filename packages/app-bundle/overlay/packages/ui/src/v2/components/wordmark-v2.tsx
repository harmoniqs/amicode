import { type ComponentProps } from "solid-js"

// AMICODE branding: wordmark text replaces the stock OPENCODE glyph paths.
// Same viewBox and props so call sites (session-new-design-view) are untouched.
export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720.002 129.001"
      fill="none"
      preserveAspectRatio="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.16">
        <text
          x="360"
          y="70"
          text-anchor="middle"
          dominant-baseline="central"
          textLength="700"
          lengthAdjust="spacingAndGlyphs"
          font-family="'Aero', 'Racing Sans One', var(--font-family-mono, ui-monospace, monospace)"
          font-weight="400"
          font-size="112"
          fill="currentColor"
        >
          AMICODE
        </text>
      </g>
    </svg>
  )
}

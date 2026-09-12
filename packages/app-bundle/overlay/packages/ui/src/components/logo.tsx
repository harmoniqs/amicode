import { type ComponentProps, type JSX } from "solid-js"

// AMICODE branding: Mark/Splash render the Harmoniqs H-robot mark; Logo
// renders the AMICODE wordmark. Component names, props, and data-component
// hooks are kept identical to stock. The mark is square (viewBox 0 0 3600
// 3600) — see logo.css aspect-ratio 1/1.
//
// Geometry mirrors amicode PR #99's two authored SVGs (amicode:
// packages/extension/media/amico{,_reduced}.svg), both square 0 0 3600 3600:
//   MARK_PATH   → amico_reduced.svg — the outer bracket (fill-rule evenodd
//                 knocks out the screen). The SMALL-size mark: Mark, Splash,
//                 AmicoSpinner (../amicode/spinner.tsx, imports MARK_PATH),
//                 and favicon/amico.svg (mirrors it as a literal — a static
//                 SVG can't import a TS module; keep its <path d>
//                 byte-identical to this constant).
//   MarkDetailed → amico.svg — the full mark WITH the internal circuit-pattern
//                 accents, for LARGE contexts only (the Meet Amico card).
// This matches amicode's own "small → reduced, large → detailed" split, so
// the fork and the extension render the same brand mark. MARK_PATH is the
// single source of truth for the glyph within this repo; it is kept aligned
// with amicode's geometry by hand when the mark changes (no build-time link).
export const MARK_PATH =
  "M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z"

const Robot = () => <path fill="currentColor" fill-rule="evenodd" d={MARK_PATH} />

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 3600 3600"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)" }}
    >
      <Robot />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 3600 3600"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)" }}
    >
      <Robot />
    </svg>
  )
}

// Detailed mark (amicode PR #99's amico.svg) — the full H-robot WITH the
// internal circuit-pattern accents, used ONLY where it renders large enough to
// resolve (the Meet Amico card, ~48px). currentColor + var(--icon-strong-base),
// same convention as Mark/Splash, so it stays theme-adaptive here — unlike
// amicode's native VS Code chat-tab icon, which needs committed light/dark SVG
// files because a native tab icon has no live CSS context for currentColor.
// Geometry mirrors amicode:packages/extension/media/amico.svg (viewBox
// 0 0 3600 3600); keep in sync by hand if that mark changes.
export const MarkDetailed = (props: { class?: string; style?: JSX.CSSProperties }) => {
  return (
    <svg
      data-component="logo-mark-detailed"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 3600 3600"
      xmlns="http://www.w3.org/2000/svg"
      style={{ color: "var(--icon-strong-base)", ...props.style }}
      fill="currentColor"
    >
      <path d="M2279.19,374.09v622.56h-958.38V374.09H202.07v2851.83h1118.74v-520.15h958.38v520.15h1118.74V374.09h-1118.74ZM3165.55,2523.71H478.91v-1338.38h2686.65v1338.38Z" />
      <rect x="1778.31" y="1312.43" width="107.11" height="692.38" />
      <polygon points="2769.41 1463.57 2903.01 1463.57 2903.01 1601.01 2769.39 1601.01 2769.39 1463.6 2635.79 1463.6 2635.79 1326.16 2769.41 1326.16 2769.41 1463.57" />
      <polygon points="3036.63 1738.45 2903.03 1738.45 2903.03 1875.89 2769.41 1875.89 2769.41 1738.45 2903.01 1738.45 2903.01 1601.01 3036.63 1601.01 3036.63 1738.45" />
      <polygon points="2903.02 1875.89 2769.43 1875.89 2769.43 2013.33 2635.81 2013.33 2635.81 1875.89 2769.4 1875.89 2769.4 1738.45 2903.02 1738.45 2903.02 1875.89" />
      <rect x="2373.03" y="1451.19" width="133.62" height="423.84" transform="translate(4879.6781 3326.2281) rotate(-180)" />
      <rect x="2009.75" y="1451.19" width="133.62" height="423.84" transform="translate(4153.1112 3326.2281) rotate(-180)" />
      <rect x="2143.56" y="1313.76" width="229.47" height="137.44" transform="translate(4516.5887 2764.9517) rotate(-180)" />
      <rect x="2143.56" y="1875.03" width="229.47" height="137.44" transform="translate(4516.5887 3887.5046) rotate(-180)" />
      <rect x="1503.05" y="1446.71" width="133.62" height="423.84" transform="translate(3139.725 3317.2494) rotate(-180)" />
      <rect x="1139.77" y="1446.71" width="133.62" height="423.84" transform="translate(2413.1581 3317.2494) rotate(-180)" />
      <rect x="1273.58" y="1309.27" width="229.47" height="137.44" transform="translate(2776.6357 2755.9729) rotate(-180)" />
      <rect x="1273.58" y="1870.54" width="229.47" height="137.44" transform="translate(2776.6357 3878.5258) rotate(-180)" />
      <polygon points="888.52 1864.8 754.93 1864.8 754.93 1727.36 888.55 1727.36 888.55 1864.77 1022.15 1864.77 1022.15 2002.21 888.52 2002.21 888.52 1864.8" />
      <polygon points="621.31 1589.92 754.9 1589.92 754.9 1452.48 888.52 1452.48 888.52 1589.92 754.93 1589.92 754.93 1727.36 621.31 1727.36 621.31 1589.92" />
      <polygon points="754.92 1452.48 888.51 1452.48 888.51 1315.04 1022.13 1315.04 1022.13 1452.48 888.54 1452.48 888.54 1589.92 754.92 1589.92 754.92 1452.48" />
      <rect x="1648.65" y="2256.8" width="349.19" height="137.44" transform="translate(3646.502 4651.0383) rotate(-180)" />
      <rect x="1510.91" y="2119.73" width="138.82" height="138.82" />
      <rect x="1997.85" y="2117.98" width="138.82" height="138.82" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <text
        x="117"
        y="22"
        text-anchor="middle"
        dominant-baseline="central"
        textLength="230"
        lengthAdjust="spacingAndGlyphs"
        font-family="'Aero', var(--font-family-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)"
        font-weight="750"
        letter-spacing="4"
        font-size="36"
        fill="var(--icon-base)"
      >
        AMICODE
      </text>
    </svg>
  )
}

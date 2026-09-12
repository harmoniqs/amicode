import { type ComponentProps } from "solid-js"
import { MARK_PATH } from "../components/logo"

// AMICODE: working/thinking spinner — the Harmoniqs H-robot silhouette as a
// small monochrome glyph (H body with the screen slit knocked out via
// fill-rule=evenodd; no eye digits / mouth — illegible at 14-18px).
// Colors via currentColor so mount sites' style={{color: ...}} passes through
// exactly like the stock Spinner. Animation: gentle opacity pulse reusing the
// EXISTING `pulse-opacity` keyframes (styles/animations.css) — chosen over
// rotation because the H is non-radial and tumbles/blurs at 16px, and pulse
// matches the stock spinner's own animation language. prefers-reduced-motion:
// static glyph, no animation (matchMedia guard; inline animations don't
// inherit the CSS-file media-query pattern used elsewhere).
//
// Path comes from logo.tsx's MARK_PATH (Mark/Splash now render the same
// glyph) instead of its own copy — this file used to carry an independent
// literal that happened to already match Mark/Splash's silhouette variant;
// consolidated so there's one geometry in this repo, not a second one that
// could quietly drift the way Mark/Splash's OWN old copy did.

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

// Static/animated brand mark for the amicode surfaces (receipt card, entity
// view, rail, ask, run window). Same H-glyph as AmicoSpinner; color comes from
// the `.amc-mark` class (accent) via currentColor, and `running` toggles the
// pulse through `.amc-mark.is-running` (CSS owns the prefers-reduced-motion
// guard here — see amicode.css — rather than the matchMedia guard below).
export function AmicoMark(props: { class?: string; running?: boolean }) {
  return (
    <svg
      viewBox="0 0 3600 3600"
      fill="currentColor"
      aria-hidden="true"
      data-component="amico-mark"
      classList={{ "amc-mark": true, "is-running": !!props.running, [props.class ?? ""]: !!props.class }}
    >
      <path fill-rule="evenodd" d={MARK_PATH} />
    </svg>
  )
}

export function AmicoSpinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
}) {
  return (
    <svg
      {...props}
      viewBox="0 0 3600 3600"
      data-component="amico-spinner"
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      fill="currentColor"
    >
      <path
        fill-rule="evenodd"
        d={MARK_PATH}
        style={
          reducedMotion()
            ? undefined
            : { animation: "pulse-opacity 1.2s ease-in-out infinite", "animation-fill-mode": "both" }
        }
      />
    </svg>
  )
}

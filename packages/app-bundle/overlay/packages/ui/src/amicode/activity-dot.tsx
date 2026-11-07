import { ACTIVITY_COLOR, type Activity } from "./activity"

// AMICODE: the one activity dot. Colour is never the only signal — the dot is
// role="img" with an aria-label (and a hover title). Omit `label` only when
// adjacent text already names the state; the dot is then aria-hidden. Running
// dots breathe with the shared reduced-motion-aware `.amc-activity-pulse`
// (design-polish.css).
export function ActivityDot(props: { activity: Activity; label?: string; class?: string; pulse?: boolean }) {
  return (
    <span
      data-component="activity-dot"
      data-activity={props.activity}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      title={props.label}
      class={`block shrink-0 rounded-full ${props.class ?? "size-1.5"}`}
      classList={{ "amc-activity-pulse": props.pulse ?? props.activity === "running" }}
      style={{ background: ACTIVITY_COLOR[props.activity] }}
    />
  )
}

// AMICODE: ConnectionIcon — 18px logo + 6px state-dot badge (issue #327)
import { Show } from "solid-js"
import { cardModel } from "./connections"
import type { ConnectionView } from "./connections"

export function ConnectionIcon(props: { conn: ConnectionView }) {
  const model = () => cardModel(props.conn)
  const tone = () => model().tone

  const dotClass = () => {
    switch (tone()) {
      case "success":
        return "bg-icon-success-base"
      case "critical":
        return "bg-icon-critical-base"
      case "warning":
        return "bg-icon-warning-base"
      case "pending":
        return "bg-icon-warning-base animate-pulse"
      default:
        return "bg-border-weak-base"
    }
  }

  const isSvg = () => Boolean(props.conn.icon && props.conn.icon.trim().startsWith("<svg"))
  const letter = () => {
    if (props.conn.icon && !isSvg()) return props.conn.icon.charAt(0).toUpperCase()
    const name = props.conn.name ?? props.conn.id
    return name.charAt(0).toUpperCase()
  }

  return (
    <div class="relative shrink-0" style={{ width: "18px", height: "18px" }}>
      <div
        class="w-[18px] h-[18px] rounded-[4px] flex items-center justify-center overflow-hidden border border-border-weak-base"
        style={{ "font-size": "10px", "font-weight": "600", "background": isSvg() ? "transparent" : "var(--v2-background-bg-raised)" }}
      >
        <Show when={isSvg()} fallback={<span class="text-text-base">{letter()}</span>}>
          <span class="w-[18px] h-[18px] flex items-center justify-center [&>svg]:w-[18px] [&>svg]:h-[18px] [&>svg]:rounded-[4px]" innerHTML={props.conn.icon ?? ""} />
        </Show>
      </div>
      <div class={`absolute -bottom-0.5 -right-0.5 size-[6px] rounded-full border border-surface-base ${dotClass()}`} />
    </div>
  )
}

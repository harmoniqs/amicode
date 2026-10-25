// AMICODE: ConnectionIcon — 18px logo + 6px activity-dot badge (issue #327)
import { Show } from "solid-js"
import { cardModel } from "./connections"
import type { ConnectionView } from "./connections"
import { connectionActivity } from "./activity"
import { ActivityDot } from "./activity-dot"

export function ConnectionIcon(props: { conn: ConnectionView; label?: string }) {
  const model = () => cardModel(props.conn)

  // pending → running, expired/unreachable/drift → attention, connected →
  // success, invalid/unentitled → error, needs-key → idle
  const activity = () => connectionActivity(model())

  const isSvg = () => Boolean(props.conn.icon && props.conn.icon.trim().startsWith("<svg"))
  const letter = () => {
    if (props.conn.icon && !isSvg()) return props.conn.icon.charAt(0).toUpperCase()
    const name = props.conn.name ?? props.conn.id
    return name.charAt(0).toUpperCase()
  }

  return (
    <div class="relative shrink-0" style={{ width: "18px", height: "18px" }}>
      <div
        class="w-[18px] h-[18px] rounded-sm flex items-center justify-center overflow-hidden border border-border-weak-base"
        style={{ "font-size": "10px", "font-weight": "600", "background": isSvg() ? "transparent" : "var(--v2-background-bg-raised)" }}
      >
        <Show when={isSvg()} fallback={<span class="text-text-base">{letter()}</span>}>
          <span class="w-[18px] h-[18px] flex items-center justify-center [&>svg]:w-[18px] [&>svg]:h-[18px] [&>svg]:rounded-sm" innerHTML={props.conn.icon ?? ""} />
        </Show>
      </div>
      <span class="absolute -bottom-0.5 -right-0.5 flex rounded-full border border-surface-base">
        <ActivityDot activity={activity()} label={props.label ?? model().state} class="size-[6px]" />
      </span>
    </div>
  )
}

import type { JSX } from "solid-js"

// amicode#1999 (#1979 S9): the model picker row, shared by the V1 List and the
// V2 MenuV2.RadioItem pickers. Two lines so the name is never squeezed:
//   line 1 — the name (takes the row width minus the trailing tags/badge/star,
//            wraps to at most two lines, never single-line truncates) + trailing
//   line 2 — provider · inline meta · greyed reason, faint 12px, single-line
//            truncate (this line gives way first).
// Plain markup on purpose — no Show/classList — so the DOM test can render it
// without Solid's DOM transform (model-picker-row.test.tsx).
export function ModelPickerRow(props: {
  name: string
  provider: string
  /** formatRowInline output; omitted → line 2 is the provider alone. */
  meta?: string
  metaTitle?: string
  /** why a greyed (unreachable) model is greyed, shown on line 2. */
  reason?: string
  greyed?: boolean
  trailing?: JSX.Element
  v2?: boolean
}) {
  return (
    <div
      data-slot="model-row"
      class={`flex w-full min-w-0 flex-1 flex-col gap-0.5 text-left ${props.greyed ? "opacity-50" : ""}`}
    >
      <div data-slot="model-row-line1" class="flex w-full min-w-0 items-start gap-x-2">
        <span
          data-slot="model-row-name"
          class={`min-w-0 flex-1 line-clamp-2 break-words leading-5 ${props.v2 ? "" : "text-13-regular"}`}
          title={props.name}
        >
          {props.name}
        </span>
        <span data-slot="model-row-trailing" class="flex shrink-0 items-center gap-1">
          {props.trailing}
        </span>
      </div>
      <div
        data-slot="model-row-line2"
        class={`min-w-0 truncate tabular-nums ${props.v2 ? "text-[12px] leading-4 font-[440] text-v2-text-text-faint" : "text-12-regular text-text-weak"}`}
      >
        <span data-slot="model-row-provider">{props.provider}</span>
        {props.meta ? (
          <span data-slot="model-row-meta" title={props.metaTitle}>
            {" · "}
            {props.meta}
          </span>
        ) : null}
        {props.reason ? (
          <span data-slot="model-row-reason" title={props.reason}>
            {" · "}
            {props.reason}
          </span>
        ) : null}
      </div>
    </div>
  )
}

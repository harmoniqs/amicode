import { createMemo, Show } from "solid-js"
import { AmicoWave } from "@opencode-ai/ui/amicode-thinking"
import { dotCentreForGroup, type TimelineGroupType } from "./dot-offsets"

/**
 * ThoughtRailOverlay — the persistent dot that tracks the active turn.
 *
 * Architecture:
 * - Lives inside the scroll container's virtual content div
 * - Absolutely positioned to span the active turn's rows
 * - The wave dot inside uses CSS sticky so it stays near viewport top during long streams
 * - Only repositions (top/height) on step boundaries (new rows), NOT per text fragment
 * - On turn completion, crossfades out (CSS class transition) while per-row done-dots appear
 *
 * Props:
 * - visible: whether a turn is actively streaming
 * - top: px offset from virtual content top to start of turn
 * - height: total px height of the active turn's rows
 * - dotOffset: current vertical centre for the dot (from dotCentreForGroup)
 * - settled: whether the turn just completed (triggers crossfade)
 */
export function ThoughtRailOverlay(props: {
  visible: boolean
  top: number
  height: number
  groupType: TimelineGroupType
  settled: boolean
}) {
  const dotOffset = createMemo(() => dotCentreForGroup(props.groupType))

  return (
    <Show when={props.visible}>
      <div
        data-component="thought-rail-overlay"
        class="thought-rail-overlay"
        classList={{
          "thought-rail-overlay--settled": props.settled,
        }}
        style={{
          position: "absolute",
          top: `${props.top}px`,
          left: "0",
          width: "20px",
          height: `${props.height}px`,
          "pointer-events": "none",
          "z-index": "10",
        }}
      >
        {/* The continuous rail line */}
        <div
          data-slot="thought-rail-line"
          class="thought-rail-line"
          style={{
            position: "absolute",
            top: "0",
            left: "9px",
            width: "2px",
            height: "100%",
          }}
        />
        {/* The sticky dot — stays near viewport top during long streams */}
        <div
          data-slot="thought-rail-dot"
          class="thought-rail-dot"
          style={{
            position: "sticky",
            top: "12px",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            width: "20px",
            height: "20px",
          }}
        >
          <AmicoWave class="thought-rail-wave" />
        </div>
      </div>
    </Show>
  )
}

/**
 * ThoughtRailDoneDot — a static settled dot rendered per-row after turn completion.
 *
 * Uses deterministic offset — no TreeWalker measurement.
 */
export function ThoughtRailDoneDot(props: {
  groupType: TimelineGroupType
}) {
  const offset = createMemo(() => dotCentreForGroup(props.groupType))

  return (
    <div
      data-slot="thought-rail-done-dot"
      class="thought-rail-done-dot"
      style={{
        position: "absolute",
        left: "0",
        top: `${offset()}px`,
        width: "6px",
        height: "6px",
        "border-radius": "50%",
        transform: "translateY(-50%)",
      }}
    />
  )
}

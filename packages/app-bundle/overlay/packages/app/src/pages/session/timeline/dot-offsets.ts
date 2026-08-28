/**
 * Deterministic dot-centre offsets by timeline group type.
 *
 * Replaces the TreeWalker-based measurement that suffered from race conditions
 * when virtualizer rows mount/unmount during streaming. Each offset is the
 * vertical centre (in px from the row's top edge) where the rail dot should
 * sit for that row type.
 *
 * If CSS padding changes, update the constants here — one file, one source.
 */

export type TimelineGroupType = "prose" | "tool-group" | "single-tool" | "thinking"

const OFFSETS: Record<TimelineGroupType, number> = {
  /** Text content: accounts for card padding-top (12px) + half line-height (~18px) */
  prose: 21,
  /** Collapsed tool group accordion: the header's vertical centre */
  "tool-group": 11,
  /** A single tool card (not in a group): header centre */
  "single-tool": 16,
  /** Thinking row: wave indicator's vertical centre */
  thinking: 11,
}

const DEFAULT_OFFSET = OFFSETS.prose

/**
 * Returns the vertical centre offset (px from row top) for the rail dot
 * given the type of timeline row group.
 */
export function dotCentreForGroup(type: TimelineGroupType): number {
  return OFFSETS[type] ?? DEFAULT_OFFSET
}

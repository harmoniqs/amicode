// AMICODE (widget kernel, #1856): sticky-widget docking — the pure decision.
// Widgets live in sandboxed iframes, so `position: sticky` inside a frame only
// sticks within the frame; docking is a host feature. The grid feeds this the
// per-card facts (manifest flag, hidden/empty state, whether the card's slot
// has scrolled out ABOVE the scroll root) plus the grid mode, and gets back the
// one entry key to dock, or none. The DOM layer (IntersectionObserver + an
// in-place restyle of the same frame) stays thin in widget-grid.tsx.
import type { Density } from "./widget-tokens"

/** Docked strip height (px) — the compact form a docked widget renders at. */
export const DOCK_STRIP_HEIGHT = 64

export interface DockCandidate {
  key: string
  /** manifest `sticky = true` (unknown/missing widgets are never sticky) */
  sticky: boolean
  hidden: boolean
  /** the widget reported an empty state (amc:empty) */
  empty: boolean
  /** the card's slot has scrolled out of view above the scroll root */
  outOfView: boolean
}

/** Which entry docks. `entries` is in dashboard order — pins append, so the
 *  LAST eligible entry is the most recently pinned and wins. Never docks
 *  while the grid is in move/add mode, or when docking is disabled for the
 *  surface (only the home dashboard docks). */
export function dockedKey(input: {
  enabled: boolean
  mode: "move" | "add" | undefined
  entries: DockCandidate[]
}): string | undefined {
  if (!input.enabled || input.mode !== undefined) return undefined
  return input.entries.findLast((e) => e.sticky && !e.hidden && !e.empty && e.outOfView)?.key
}

/** A docked widget renders as the slim strip → density `tight`; undocked it
 *  gets the host's current density back. */
export function dockDensity(base: Density, docked: boolean): Density {
  return docked ? "tight" : base
}

/** IntersectionObserver entry → "scrolled out above". A slot below the fold
 *  (not yet reached) is NOT out of view in the docking sense — the strip only
 *  appears once the user has scrolled past the card. */
export function slotAboveRoot(entry: {
  isIntersecting: boolean
  boundingClientRect: { bottom: number }
  rootBounds: { top: number } | null
}): boolean {
  if (entry.isIntersecting) return false
  return entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0)
}

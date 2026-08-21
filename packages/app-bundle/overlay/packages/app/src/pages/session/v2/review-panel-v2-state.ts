import type { SessionReviewExpandMode } from "@opencode-ai/session-ui/v2/session-review-v2"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

// Width bounds duplicated from @opencode-ai/session-ui/v2/session-review-v2
// so this module stays importable in the bun test env (the component chain
// pulls @pierre/diffs workers, which don't run under happydom).
const SIDEBAR_WIDTH_DEFAULT = 240
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 480

/** amicode#105 single-pane policy (pure, tested): the Work Column never
 *  splits — the review sidebar (the file list) does not render at any width.
 *  Diffs take the full column width; navigation is the changes dropdown. */
export function reviewSidebarOpened(_persisted?: boolean): boolean {
  return false
}

/** The toggle is inert — it stays for prop compatibility but can never open
 *  the split. A persisted `sidebarOpened: true` from the split-pane era is
 *  ignored everywhere through reviewSidebarOpened. */
export function reviewSidebarToggled(_opened: boolean): boolean {
  return false
}

export function createReviewPanelV2State() {
  const [store, setStore, , ready] = persisted(
    Persist.global("review-panel-v2"),
    createStore({
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      expandMode: "collapse" as SessionReviewExpandMode,
    }),
  )
  // The filter is transient by design: a persisted filter would silently hide
  // files after a reload.
  const [filter, setFilter] = createSignal("")

  return {
    sidebarOpened: reviewSidebarOpened,
    sidebarWidth: () => store.sidebarWidth,
    sidebarTransition: ready,
    filter,
    setFilter,
    expandMode: () => store.expandMode,
    setExpandMode: (mode: SessionReviewExpandMode) => setStore("expandMode", mode),
    resizeSidebar: (width: number) =>
      setStore("sidebarWidth", Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width))),
    toggleSidebar: () => {},
  }
}

export type ReviewPanelV2State = ReturnType<typeof createReviewPanelV2State>

import { batch } from "solid-js"
import { createStore, produce } from "solid-js/store"

export const DEFAULT_REVIEW_PANEL_OPENED = false

export type ReviewPanelSource = "context-button" | "other"

export type SessionReviewPanelView = {
  scroll: Record<string, unknown>
  /** #1966: the side panel's open/closed state belongs to its session. */
  reviewPanelOpened?: boolean
}

/**
 * Per-session side-panel open/closed state (#1966). The open flag is read from
 * and written to the session's persisted `sessionView` entry; a session that
 * never set it is closed — it never inherits another session's state. The open
 * source is ephemeral and keyed by session too, so a context-button open in one
 * session cannot leak into another.
 */
export function createSessionReviewPanel(input: {
  views: () => Record<string, SessionReviewPanelView | undefined>
  write: (session: string, opened: boolean) => void
}) {
  const [sources, setSources] = createStore<Record<string, ReviewPanelSource | undefined>>({})
  const opened = (session: string) => input.views()[session]?.reviewPanelOpened ?? DEFAULT_REVIEW_PANEL_OPENED

  return {
    opened,
    source(session: string): ReviewPanelSource {
      if (!opened(session)) return "other"
      return sources[session] ?? "other"
    },
    set(session: string, next: boolean, source: ReviewPanelSource) {
      const nextSource = next ? source : "other"
      batch(() => {
        if (sources[session] !== nextSource) setSources(session, nextSource)
        if (opened(session) === next) return
        input.write(session, next)
      })
    },
    drop(sessions: string[]) {
      setSources(
        produce((draft) => {
          for (const session of sessions) delete draft[session]
        }),
      )
    },
  }
}

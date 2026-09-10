import type { DevToolsStatus } from "./developer-tools-controller"

/**
 * The devtools path-validation request lifecycle, as a pure reducer.
 *
 * Kept separate from the SolidJS signal wiring so the exact invariant that
 * was wrong (#940) is directly testable: starting a new validation
 * round-trip must NOT blank the currently-visible status. The old status
 * (an error or a success indicator) stays on screen — dimmed by the UI via
 * `pending` — until the new reply actually arrives. Clearing it eagerly is
 * what produced the flicker: every path edit made the indicator vanish and
 * then snap back a moment later.
 */

export interface DevToolsRequestState {
  status: DevToolsStatus | undefined
  pending: boolean
}

export type DevToolsRequestEvent =
  | { type: "request-sent" }
  | { type: "status-received"; status: DevToolsStatus }

export function reduceDevToolsRequest(
  state: DevToolsRequestState,
  event: DevToolsRequestEvent,
): DevToolsRequestState {
  switch (event.type) {
    case "request-sent":
      // Keep the stale status visible; only the pending flag changes.
      return { status: state.status, pending: true }
    case "status-received":
      return { status: event.status, pending: false }
  }
}

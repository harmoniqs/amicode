// AMICODE: the per-session tab status dot.
//
// Five states on the activity vocabulary (design-polish.css `--activity-*`):
// red (error), amber (attention — waiting on the user), blue (running),
// green (done, unread), grey (done, seen). Yellow never encodes a state.

export type SessionTabStatus = "idle" | "running" | "attention" | "done" | "error"

export function sessionTabStatus(input: {
  loading: boolean
  needsAttention: boolean
  unread: boolean
  hasError?: boolean
}): SessionTabStatus {
  // Error is loudest — red dot demands action.
  if (input.hasError) return "error"
  // Waiting on the user (permission / question) — amber, above running: the
  // agent is blocked until the user answers.
  if (input.needsAttention) return "attention"
  // Running means the agent is working — blue.
  if (input.loading) return "running"
  // Done + unread — green.
  if (input.unread) return "done"
  // Done + already seen — grey.
  return "idle"
}

export const SESSION_TAB_TONE: Record<SessionTabStatus, { color: string; label: string }> = {
  idle: { color: "var(--activity-idle)", label: "Done" },
  running: { color: "var(--activity-running)", label: "Working" },
  attention: { color: "var(--activity-attention)", label: "Needs your attention" },
  done: { color: "var(--activity-success)", label: "Done — unread" },
  error: { color: "var(--activity-error)", label: "Error" },
}

/** The dot itself. Exported so every surface that shows session state — the tab
 *  strip, the sessions dropdown — renders the SAME mark rather than each rolling
 *  its own green. If the treatment changes, it changes in one place. */
export function StatusDot(props: {
  color: string
  label: string
  status?: string
  boxed?: boolean
  pulse?: boolean
}) {
  return (
    <span
      data-component="session-status-dot"
      data-status={props.status}
      role="img"
      aria-label={props.label}
      title={props.label}
      class={
        props.boxed
          ? "relative inline-flex size-4 shrink-0 items-center justify-center"
          : "relative inline-flex shrink-0 items-center justify-center"
      }
    >
      <span
        aria-hidden="true"
        class="block size-1.5 rounded-full"
        classList={{ "amc-activity-pulse": props.pulse }}
        style={{ background: props.color }}
      />
    </span>
  )
}

export function SessionTabStatusDot(props: { status: SessionTabStatus }) {
  const tone = () => SESSION_TAB_TONE[props.status]
  // boxed: the tab strip reserves a 16px slot so rows stay aligned
  return (
    <StatusDot
      color={tone().color}
      label={tone().label}
      status={props.status}
      pulse={props.status === "running"}
      boxed
    />
  )
}

// AMICODE: the per-session tab status dot.
//
// Four states: green (done, unread), grey (done, seen), yellow (running),
// red (error).

export type SessionTabStatus = "idle" | "running" | "done" | "error"

export function sessionTabStatus(input: {
  loading: boolean
  needsAttention: boolean
  unread: boolean
  hasError?: boolean
}): SessionTabStatus {
  // Error is loudest — red dot demands action.
  if (input.hasError) return "error"
  // Running means the agent is working — yellow.
  if (input.loading) return "running"
  // Done + unread (or needs attention) — green.
  if (input.needsAttention || input.unread) return "done"
  // Done + already seen — grey.
  return "idle"
}

const TONE: Record<SessionTabStatus, { color: string; label: string }> = {
  idle: { color: "var(--status-idle)", label: "Done" },
  running: { color: "var(--status-running)", label: "Working" },
  done: { color: "var(--status-done)", label: "Done — unread" },
  error: { color: "var(--status-error)", label: "Error" },
}

/** The dot itself. Exported so every surface that shows session state — the tab
 *  strip, the sessions dropdown — renders the SAME mark rather than each rolling
 *  its own green. If the treatment changes, it changes in one place. */
export function StatusDot(props: { color: string; label: string; status?: string; boxed?: boolean }) {
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
        style={{ background: props.color }}
      />
    </span>
  )
}

export function SessionTabStatusDot(props: { status: SessionTabStatus }) {
  const tone = () => TONE[props.status]
  // boxed: the tab strip reserves a 16px slot so rows stay aligned
  return <StatusDot color={tone().color} label={tone().label} status={props.status} boxed />
}

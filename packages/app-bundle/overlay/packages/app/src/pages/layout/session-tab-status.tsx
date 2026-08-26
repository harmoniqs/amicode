// AMICODE: the per-session tab status dot.
//
// Replaces the Amico mark that used to sit on every tab. The mark was identical
// on all of them, so it cost a slot and carried no information; a dot in that
// slot says what the session is doing at a glance down the whole tab strip.
//
// The states are the ones the session store can actually report. There is no
// per-session error signal today — `globalStore.error` is server-wide — so an
// "error" tone is deliberately absent rather than added as a dot that never
// lights. When a per-session failure signal exists, add it here as `danger`.

export type SessionTabStatus = "idle" | "running" | "attention" | "error" | "done"

export function sessionTabStatus(input: {
  loading: boolean
  needsAttention: boolean
  unread: boolean
  hasError?: boolean
}): SessionTabStatus {
  // Blocked beats busy: a permission or question needs the user before anything
  // else can happen, so it must not be masked by a spinner. An error outranks
  // plain unread, which would otherwise swallow it — both come from the same
  // unseen-notification index.
  if (input.needsAttention) return "attention"
  if (input.loading) return "running"
  if (input.hasError) return "error"
  if (input.unread) return "done"
  return "idle"
}

// These come from --status-* in design-polish.css: a SEMANTIC scale, deliberately
// outside the brand yellow system. A dot's job is to say what state a session is
// in, and it needs 3:1 (graphical object), not the 4.5:1 body-text minimum that
// made the earlier tones muddy. The values were chosen by colour-blindness
// simulation — see the comment on --status-idle.
const TONE: Record<SessionTabStatus, { color: string; label: string }> = {
  // quiet on purpose — it still holds the slot so the strip stays aligned
  idle: { color: "var(--status-idle)", label: "Idle" },
  // blue, the conventional in-progress signal — NOT the brand yellow, which is
  // 1.27:1 on white and cannot be made to work as a dot there
  running: { color: "var(--status-running)", label: "Working" },
  attention: { color: "var(--status-attention)", label: "Needs you" },
  error: { color: "var(--status-error)", label: "Error" },
  done: { color: "var(--status-done)", label: "Finished — unread" },
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
        // No ring. Each tone is picked to clear 3:1 against its own ground
        // unaided, so an edge would only mute the hue that carries the meaning.
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

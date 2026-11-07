// amicode#1787 (S1) — status chips on the session list. Render-only: the chip
// DERIVES from the ServerSession store's shared-row leaves (busy/heartbeat
// status + the question rows), the same leaves the #1617/#1637 floors already
// guard and the S2 question inbox already derives from — so "waiting on
// question" means the same thing on the list and in the inbox.
//
// The #1768 rhyme (peer-fleet session-status, one data plane over): tri-state
// busy/idle/OMITTED — a session with NO status evidence renders NO chip
// (absence never reads as idle), an unreachable owner's omission keeps the
// current chip (the store's recency-guarded reconcile owns that floor), and
// the row self-corrects when an explicit frame lands (owner returns / the
// shared row TTLs out and a reconcile read reports idle). No polling: the chip
// re-derives reactively off the store, which the event flow and the existing
// re-seed seams (connected edge, sync-gap frame, visibility-gated self-heal)
// already keep current.
import type { QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { Show } from "solid-js"

/** The chip a session list row shows. */
export type SessionListChip =
  | { kind: "running"; retry: boolean }
  | { kind: "waiting-on-question" }
  | { kind: "idle"; ageMs: number | undefined }

/** The shared-row source: the ServerSession store's own leaves. `session_working`
 *  is optional so a plain record (a status map without the working floor) still
 *  derives — the store passes its method, tests pass the store itself. */
export type SessionListChipSource = {
  session_status: Record<string, SessionStatus | undefined>
  question: Record<string, readonly QuestionRequest[] | undefined>
  session_working?: (sessionID: string) => boolean
}

/** Derive one row's chip. NO status row + no question + no working floor is
 *  the OMITTED state: it returns undefined and the row renders no chip —
 *  absence never reads as idle. */
export function deriveSessionListChip(input: {
  source: SessionListChipSource
  sessionID: string
  /** The session record's last-activity time (session.time.updated). */
  lastActivityAt?: number
  now: number
}): SessionListChip | undefined {
  const { source, sessionID } = input
  // The question rows are the same rows the S2 inbox lists — one definition
  // of "waiting on question" across both surfaces.
  if ((source.question[sessionID]?.length ?? 0) > 0) return { kind: "waiting-on-question" }
  const status = source.session_status[sessionID]
  const working = source.session_working?.(sessionID) ?? false
  if (working || (status?.type ?? "idle") !== "idle") return { kind: "running", retry: status?.type === "retry" }
  if (status === undefined) return undefined // omitted — honest absence
  return {
    kind: "idle",
    ageMs: input.lastActivityAt === undefined ? undefined : Math.max(0, input.now - input.lastActivityAt),
  }
}

/** The chip's user-facing text. English-only by design, matching the tab
 *  status dot's labels (session-tab-status.tsx). */
export function sessionListChipLabel(chip: SessionListChip): string {
  if (chip.kind === "waiting-on-question") return "waiting on question"
  if (chip.kind === "running") return chip.retry ? "retrying" : "running"
  if (chip.ageMs === undefined) return "idle"
  if (chip.ageMs < 60_000) return "idle"
  if (chip.ageMs < 3_600_000) return `idle ${Math.floor(chip.ageMs / 60_000)}m`
  if (chip.ageMs < 24 * 3_600_000) return `idle ${Math.floor(chip.ageMs / 3_600_000)}h`
  return `idle ${Math.floor(chip.ageMs / (24 * 3_600_000))}d`
}

// ── the chip mark ────────────────────────────────────────────────────────────
// Reads like the neighboring session-control-chip / status dot: a small
// muted chip with a colored dot — the dot's tone reuses the SAME status
// palette as SessionTabStatusDot (running yellow, needs-you green, idle grey),
// so one session reads identically on the tab, in the dock, and on the list.

const CHIP_TONE: Record<SessionListChip["kind"], string> = {
  running: "var(--status-running)",
  "waiting-on-question": "var(--status-done)",
  idle: "var(--status-idle)",
}

export function SessionListStatusChip(props: { chip: SessionListChip | undefined }) {
  return (
    <Show when={props.chip === undefined ? undefined : props.chip} keyed>
      {(chip) => {
        const label = sessionListChipLabel(chip)
        return (
          <span
            data-slot="session-list-chip"
            data-kind={chip.kind}
            class="shrink-0 inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] leading-none text-v2-text-text-faint bg-v2-background-bg-layer-02"
            title={label}
          >
            <span aria-hidden="true" class="block size-1.5 rounded-full" style={{ background: CHIP_TONE[chip.kind] }} />
            <span>{label}</span>
          </span>
        )
      }}
    </Show>
  )
}

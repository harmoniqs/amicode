// Pure state machine for the ConnectionBanner (amicode#653) — separated from
// the Solid component so the timing law is unit-testable (bun test).
//
// The law (issue #653's acceptance criteria): a brief blip — e.g. a hub
// restart under 10s — NEVER flashes the banner; the reconnect loop wins
// quietly. Only a persistent down (>= DOWN_GRACE_MS after a first successful
// connect) surfaces the "Hub unreachable" pill with the Restart action, and
// only that persistent state earns a "reconnected" flash on recovery.

export const DOWN_GRACE_MS = 10_000
export const RECONNECT_FLASH_MS = 3_000

export type StreamStatus = "connected" | "disconnected"
export type BannerMode = "silent" | "down" | "reconnected"

export type BannerInput = {
  status: StreamStatus
  /** Has the stream EVER connected in this app session? Boot renders
   *  "disconnected" transiently while the stream is being set up — never
   *  surface that as "unreachable". */
  connectedOnce: boolean
  /** Epoch ms when the current disconnect spell began, or null if connected. */
  downSince: number | null
  /** Epoch ms when the last recovery happened, or null. */
  recoveredAt: number | null
  now: number
}

export type BannerState = {
  mode: BannerMode
  /** Whether the Restart Hub action is offered (only in the down state). */
  showRestart: boolean
}

export function computeBannerState(input: BannerInput): BannerState {
  const { status, connectedOnce, downSince, recoveredAt, now } = input
  if (status === "connected") {
    // Recovery flash: only if the down spell actually earned the banner.
    if (recoveredAt !== null && downSince !== null && now - downSince >= DOWN_GRACE_MS) {
      if (now - recoveredAt < RECONNECT_FLASH_MS) return { mode: "reconnected", showRestart: false }
    }
    return { mode: "silent", showRestart: false }
  }
  // Disconnected: silent until the spell outlives the grace window — and
  // never during the boot transient (no first connect yet).
  if (!connectedOnce || downSince === null) return { mode: "silent", showRestart: false }
  if (now - downSince >= DOWN_GRACE_MS) return { mode: "down", showRestart: true }
  return { mode: "silent", showRestart: false }
}

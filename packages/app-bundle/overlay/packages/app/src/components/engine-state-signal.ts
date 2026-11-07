import { createSignal } from "solid-js"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  latchedEngineStateAt,
  type EngineState,
  type FleetRole,
} from "./engine-toggle-utils"

// engine-state-signal.ts — #1608: the GLOBAL engine lifecycle signal.
//
// #1598 kept the engine-state signal LOCAL to the status popover, so a push
// that arrived while the popover was closed was lost, and nothing outside the
// popover could read it. This promotes it to a module-level always-mounted
// signal — installed ONCE (see installEngineStateListener) so a single window
// listener owns the channel for the whole app lifetime.
//
// It also carries the LOCAL "stop-requested" latch: the click flips the UI to
// `stopping` instantly, before any extension round-trip. A delivered push then
// reconciles it. CRITICALLY (BUG1 fix), the latch is SELF-EXPIRING: if the
// confirming `off` push is dropped (engine dead → SSE gone → the push never
// arrives), a timer resolves the latch to the intended terminal `off` state so
// the toggle is NEVER permanently grayed — the user can always click to restart.

// How long `stopping` may show before the latch self-resolves to `off`. The
// deliberate kill is SIGTERM→wait→SIGKILL-bounded at ~3s (server_manager.ts),
// so 4s covers the happy path and still recovers a dropped confirm quickly.
export const STOP_LATCH_TIMEOUT_MS = 4000

// Default "on": the app can only render when the engine is already serving it,
// so the resting initial state is on; booting/off/stopping arrive via push.
const [engineState, setEngineStateRaw] = createSignal<EngineState>("on")
// Fleet role default standalone — a window with no fleet topology behaves as a
// normal standalone engine host.
const [fleetRole, setFleetRole] = createSignal<FleetRole>("standalone")
// The local latch: the wall-clock time of the stop click, or undefined when
// there is no outstanding optimistic stop. A tick signal advances the derived
// state so the timeout is observed reactively — effectiveEngineState() MUST
// read `tick` (below) or the self-expiry setTimeout fires into the void: the
// popover would only re-derive on reopen (BUG1 follow-up — live update lost).
const [latchedAt, setLatchedAt] = createSignal<number | undefined>(undefined)
const [tick, setTick] = createSignal(0)
let latchTimer: ReturnType<typeof setTimeout> | undefined
const now = () => Date.now()

export { engineState, fleetRole }

/** The state the UI should render: the latch reads `stopping` inside the
 *  confirm window, then resolves to `off` (BUG1); a delivered push wins.
 *
 *  Reads `tick()` for its reactive side effect ONLY: `now()` is a plain
 *  non-reactive Date.now(), so nothing here would re-run when the self-expiry
 *  timer elapses. The timer bumps `tick` (latchStopRequested); reading it makes
 *  this a tracked dependency so the toggle re-derives to `off` live at the 4s
 *  boundary WITHOUT the user reopening the popover. */
export function effectiveEngineState(): EngineState {
  tick() // reactive dependency — see the timer in latchStopRequested()
  return latchedEngineStateAt(engineState(), latchedAt(), now(), STOP_LATCH_TIMEOUT_MS)
}

function clearLatchTimer() {
  if (latchTimer !== undefined) {
    clearTimeout(latchTimer)
    latchTimer = undefined
  }
}

/** Flip the toggle to `stopping` locally the instant the user clicks. Records
 *  the click time and arms the self-expiry timer: if no confirming push lands
 *  within STOP_LATCH_TIMEOUT_MS, the derived state falls back to `off` so the
 *  toggle is never stuck grayed. */
export function latchStopRequested() {
  setLatchedAt(now())
  clearLatchTimer()
  latchTimer = setTimeout(() => {
    // Tick to re-derive effectiveEngineState() → past the window it reads `off`.
    // The latch is intentionally NOT cleared: `off` is the intended terminal
    // state, and a later real push (e.g. `on` from a restart) still wins.
    setTick((t) => t + 1)
    latchTimer = undefined
  }, STOP_LATCH_TIMEOUT_MS)
}

/** Apply a delivered engine-state push. Clears the local latch + its timer —
 *  the real state now owns the rendering, so the optimistic latch steps aside. */
export function applyEngineState(state: EngineState) {
  setLatchedAt(undefined)
  clearLatchTimer()
  setEngineStateRaw(state)
}

/** Install the ONE window listener that feeds the global signals. Idempotent —
 *  a second install is a no-op — so multiple call sites (the always-mounted
 *  host + the popover) are safe. Returns a disposer for symmetry/testing. */
let installed = false
export function installEngineStateListener(win: Window = window): () => void {
  if (installed) return () => {}
  installed = true
  const onMsg = (e: MessageEvent) => {
    const state = parseEngineStateMessage(e.data)
    if (state !== undefined) applyEngineState(state)
    const role = parseFleetRoleMessage(e.data)
    if (role !== undefined) setFleetRole(role)
  }
  win.addEventListener("message", onMsg)
  return () => {
    win.removeEventListener("message", onMsg)
    installed = false
  }
}

/** TEST-ONLY: reset the module signals + install guard between cases. */
export function __resetEngineStateForTest() {
  setEngineStateRaw("on")
  setFleetRole("standalone")
  setLatchedAt(undefined)
  clearLatchTimer()
  installed = false
}

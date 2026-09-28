import { createSignal } from "solid-js"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  latchedEngineState,
  type EngineState,
  type FleetRole,
} from "./engine-toggle-utils"

// engine-state-signal.ts — #1608: the GLOBAL engine lifecycle signal.
//
// #1598 kept the engine-state signal LOCAL to the status popover, so a push
// that arrived while the popover was closed was lost, and nothing outside the
// popover (the composer refusal, the off-narration banner) could read it. This
// promotes it to a module-level always-mounted signal — mirroring the
// solver-switch-banner pattern — installed ONCE from the layout so a single
// window listener owns the channel for the whole app lifetime.
//
// It also carries the LOCAL "stop-requested" latch (AC5): the click flips the
// UI off instantly, before any extension round-trip. A delivered push then
// reconciles it (the latch clears the moment the real state arrives), so the
// latch never fights delivery — it only covers the gap before it.

// Default "on": the app can only render when the engine is already serving it,
// so the resting initial state is on; booting/off/stopping arrive via push.
const [engineState, setEngineStateRaw] = createSignal<EngineState>("on")
// Fleet role drives the fleet-client hide (AC8). Default standalone — a window
// with no fleet topology behaves as a normal standalone engine host.
const [fleetRole, setFleetRole] = createSignal<FleetRole>("standalone")
// The local latch: set true on a stop click, cleared when a real push lands.
const [stopRequested, setStopRequested] = createSignal(false)

export { engineState, fleetRole }

/** The state the UI should render: the latch wins until a real push arrives,
 *  so a click reads as `stopping` instantly (AC5) without waiting for delivery. */
export function effectiveEngineState(): EngineState {
  return latchedEngineState(engineState(), stopRequested())
}

/** Flip the toggle off locally the instant the user clicks (AC5). The extension
 *  round-trip then confirms via push; this only covers the gap before it. */
export function latchStopRequested() {
  setStopRequested(true)
}

/** Apply a delivered engine-state push. Clears the local latch — the real
 *  state now owns the rendering, so the optimistic latch steps aside. */
export function applyEngineState(state: EngineState) {
  setStopRequested(false)
  setEngineStateRaw(state)
}

/** Install the ONE window listener that feeds the global signals. Idempotent —
 *  a second install is a no-op — so calling it from the always-mounted banner
 *  is safe even across HMR. Returns a disposer for symmetry/testing. */
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
  setStopRequested(false)
  installed = false
}

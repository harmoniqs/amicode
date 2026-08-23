import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import {
  solverSwitchExpired,
  solverSwitchLabel,
  solverSwitchPhase,
  type SolverSwitchPhase,
} from "@opencode-ai/ui/amicode-solver-switch"
import type { SolverMode } from "@opencode-ai/ui/amicode-solver-toggle"
import { useServerSDK } from "@/context/server-sdk"

// Amicode: the visible half of a solver switch (opencode#78 follow-up).
//
// #221 made the switch REAL — the extension watcher re-preps the session config
// and restarts the opencode server. The webview survives that; its SSE stream
// does not. Nothing narrated the gap, so a deliberate tier change looked like a
// hang (the reconnect loop retries silently, which reads as an endless
// "thinking" wave).
//
// Scope is deliberately narrow. The old ConnectionBanner spoke for EVERY drop
// and was unmounted on 2026-08-07 (f696388/a03aa04) after opencode#132's stuck
// pill; this one only ever speaks for a switch the app itself requested, so it
// cannot get stuck on a transient blip and does not reinstate that decision.

// Module-level: the two call sites that can start a switch live in different
// component trees (the popover's connections state and the home chrome's), and
// both must reach the one banner in the layout.
const [target, setTarget] = createSignal<SolverMode | undefined>()
const [startedAt, setStartedAt] = createSignal(0)

/** Announce a switch the app just requested. `hp` rides a validated credential,
 *  `piccolo` rides POST /amicode/solver-mode — this only mirrors that request,
 *  it never causes one. */
export function beginSolverSwitch(mode: SolverMode) {
  setTarget(mode)
  setStartedAt(Date.now())
}

function endSolverSwitch() {
  setTarget(undefined)
  setStartedAt(0)
}

export function SolverSwitchBanner() {
  const sdk = useServerSDK()
  const [sawDrop, setSawDrop] = createSignal(false)
  const [elapsed, setElapsed] = createSignal(0)

  // One clock, alive only while a switch is outstanding: it drives the expiry
  // check, which has nothing else to react to (the stall case is defined by the
  // absence of any status change).
  createEffect(() => {
    if (!target()) {
      setSawDrop(false)
      setElapsed(0)
      return
    }
    const timer = setInterval(() => setElapsed(Date.now() - startedAt()), 500)
    onCleanup(() => clearInterval(timer))
  })

  // Latch the drop: once the server has gone down, coming back up is the
  // switch completing rather than the request still waiting to be picked up.
  createEffect(() => {
    if (target() && sdk().event.status() === "disconnected") setSawDrop(true)
  })

  const phase = (): SolverSwitchPhase =>
    solverSwitchPhase({
      target: target(),
      connected: sdk().event.status() === "connected",
      sawDrop: sawDrop(),
    })

  createEffect(() => {
    const current = phase()
    if (current === "idle") return
    // Hold the completed chip briefly — it is the only confirmation the user
    // gets inside the app, and the extension's toast lands outside the webview.
    if (current === "ready") {
      const done = setTimeout(endSolverSwitch, 3000)
      onCleanup(() => clearTimeout(done))
      return
    }
    if (solverSwitchExpired(current, elapsed())) endSolverSwitch()
  })

  const label = () => solverSwitchLabel(phase(), target())

  return (
    <Show when={label()}>
      {(text) => (
        <div data-component="amicode-solver-switch" data-phase={phase()} role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{text()}</span>
        </div>
      )}
    </Show>
  )
}

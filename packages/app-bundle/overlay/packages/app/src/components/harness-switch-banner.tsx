import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import {
  harnessSwitchExpired,
  harnessSwitchLabel,
  harnessSwitchPhase,
  type HarnessSwitchPhase,
} from "@/components/harness-switch"
import { useServerSDK } from "@/context/server-sdk"

// Amicode: the visible half of a harness switch (amicode#1549) — the
// solver-switch banner's twin for the composer's harness control. The switch
// is real: the extension watcher persists the setting and restarts the server
// underneath the webview; the SSE stream dies for those seconds and this
// banner is the only narration. Scope mirrors the solver twin: it speaks ONLY
// for a switch the app itself requested, so it cannot get stuck on a
// transient blip.

// Module-level: the call site (the composer's harness control) and the one
// banner in the layout live in different component trees.
const [target, setTarget] = createSignal<string | undefined>()
const [startedAt, setStartedAt] = createSignal(0)

/** Announce a switch the app just requested — `displayName` is the registry's
 *  name for the picked harness, so the narration names what was picked. This
 *  only mirrors the request; it never causes one. */
export function beginHarnessSwitch(displayName: string) {
  setTarget(displayName)
  setStartedAt(Date.now())
}

function endHarnessSwitch() {
  setTarget(undefined)
  setStartedAt(0)
}

export function HarnessSwitchBanner() {
  const sdk = useServerSDK()
  const [sawDrop, setSawDrop] = createSignal(false)
  const [elapsed, setElapsed] = createSignal(0)

  // One clock, alive only while a switch is outstanding: it drives the expiry
  // check, which has nothing else to react to.
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

  const phase = (): HarnessSwitchPhase =>
    harnessSwitchPhase({
      target: target(),
      connected: sdk().event.status() === "connected",
      sawDrop: sawDrop(),
    })

  createEffect(() => {
    const current = phase()
    if (current === "idle") return
    // Hold the completed chip briefly — the only confirmation the user gets
    // inside the app; the extension's toast lands outside the webview.
    if (current === "ready") {
      const done = setTimeout(endHarnessSwitch, 3000)
      onCleanup(() => clearTimeout(done))
      return
    }
    if (harnessSwitchExpired(current, elapsed())) endHarnessSwitch()
  })

  const label = () => harnessSwitchLabel(phase(), target())

  return (
    <Show when={label()}>
      {(text) => (
        <div data-component="amicode-harness-switch" data-phase={phase()} role="status" aria-live="polite">
          <i aria-hidden="true" />
          <span>{text()}</span>
        </div>
      )}
    </Show>
  )
}

import { Show } from "solid-js"
import { effectiveEngineState, fleetRole, installEngineStateListener } from "./engine-state-signal"
import { engineBannerLabel } from "./engine-toggle-utils"

// engine-banner.tsx — #1608: the calm, persistent narration of a deliberate
// engine off (and the booting/stopping transitions), mirroring the proven
// SolverSwitchBanner in-app pattern.
//
// Why this exists: toggling the engine off (#1598) used to read as a hang —
// the composer refused sends with a generic "connection dropped" toast and the
// SSE loop reconnected forever with nothing saying the stop was DELIBERATE.
// This banner speaks only for the engine lifecycle the app itself can observe
// (via the now-forwarded engine-state pushes), and stays SILENT when the engine
// is on or on a fleet-client window (the engine is remote there — a local
// "off" would be a lie). It is NOT a blocking overlay.
//
// It is always mounted (from the layout), so it also OWNS the one global
// engine-state listener install — a push arriving while the status popover is
// closed is no longer lost.

export function EngineBanner() {
  installEngineStateListener()
  const label = () => engineBannerLabel(effectiveEngineState(), fleetRole())
  return (
    <Show when={label()}>
      {(text) => (
        <div
          data-component="amicode-engine-banner"
          data-state={effectiveEngineState()}
          role="status"
          aria-live="polite"
        >
          <i aria-hidden="true" />
          <span>{text()}</span>
        </div>
      )}
    </Show>
  )
}

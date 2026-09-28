// engine-toggle.tsx — #1598: engine on/off toggle in the status cluster.
//
// Renders in the status popover body. Driven entirely by extension push
// messages (engine-state + fleet-role), never by the engine's own status
// surface (which 503s when down). Hidden on fleet-client windows.

import { createSignal, onCleanup, Show } from "solid-js"
import {
  parseEngineStateMessage,
  parseFleetRoleMessage,
  sendEngineCommand,
  type EngineState,
  type FleetRole,
} from "./engine-toggle"

/**
 * Engine on/off toggle — renders a row with a status dot, "Engine" label,
 * and a clickable toggle area. Locked (non-interactive) while booting.
 * Hidden on fleet-client windows.
 */
export function EngineToggle() {
  // Default to "booting" (safe before the first push arrives).
  const [engineState, setEngineState] = createSignal<EngineState>("booting")
  const [fleetRole, setFleetRole] = createSignal<FleetRole>("standalone")

  const onMessage = (e: MessageEvent) => {
    const engineParsed = parseEngineStateMessage(e.data)
    if (engineParsed !== undefined) {
      setEngineState(engineParsed)
      return
    }
    const roleParsed = parseFleetRoleMessage(e.data)
    if (roleParsed !== undefined) {
      setFleetRole(roleParsed)
    }
  }

  window.addEventListener("message", onMessage)
  onCleanup(() => window.removeEventListener("message", onMessage))

  const isLocked = () => engineState() === "booting"
  const hidden = () => fleetRole() === "client"

  const dotClass = () => {
    switch (engineState()) {
      case "on":
        return "bg-icon-success-base"
      case "booting":
        return "bg-icon-warning-base"
      case "off":
        return "bg-border-weak-base"
    }
  }

  const handleClick = () => {
    if (isLocked()) return
    sendEngineCommand(engineState())
  }

  return (
    <Show when={!hidden()}>
      <button
        type="button"
        class="flex items-center gap-2 w-full min-h-8 pl-3 pr-2 py-1 rounded-md transition-colors text-left"
        classList={{
          "hover:bg-surface-raised-base-hover cursor-pointer": !isLocked(),
          "cursor-not-allowed opacity-60": isLocked(),
        }}
        aria-disabled={isLocked()}
        aria-label={`Engine: ${engineState()}`}
        data-testid="engine-toggle"
        onClick={handleClick}
      >
        <div
          classList={{
            "size-1.5 rounded-full shrink-0": true,
            [dotClass()]: true,
          }}
          class={isLocked() ? "animate-pulse" : ""}
        />
        <span class="text-14-regular text-text-base truncate">Engine</span>
        <div class="flex-1" />
        <span class="text-12-regular text-text-weak">
          {engineState() === "on" ? "On" : engineState() === "booting" ? "Starting…" : "Off"}
        </span>
      </button>
    </Show>
  )
}

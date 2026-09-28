/**
 * new-session-machine-picker-mount.tsx — #1453 (W4b)
 *
 * The LIVE mount of the new-session machine picker (`new-session-machine-picker.ts`,
 * #1442) — this component is the non-test importer of `createMachinePickerState`
 * that retires that module's dead-module status.
 *
 * It wires the picker's two data sources:
 *   - the machine list: the fleet-sessions projection (GET /amicode/fleet/sessions,
 *     W2 #1447 / W4a #1452) grouped by owner (machineOptionsFromFleetSessions);
 *   - the DEFAULT selection: the focused machine delivered over the W3 (#1451)
 *     chat_bridge `fleet-focus` down-message. The overlay-side receiver latches
 *     the latest push; this component RE-READS it on mount (current()) and
 *     subscribes for live updates — the push is best-effort, not replayed.
 *
 * The picker chooses where a NEW session runs (createPayload().machine_id). That
 * is DISTINCT from the sidebar focus selector (W3-owned): focus only seeds the
 * default here; selecting a machine never re-focuses the sidebar. On a fleet
 * with no owner-tagged sessions the projection is empty and the picker renders
 * nothing (honest fleet-of-one degrade).
 */
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useServer } from "@/context/server"
import { amicodeGet } from "@/utils/amicode-fetch"
import { fleetSessionsFromResponse } from "@/pages/session/timeline/session-header-provenance"
import { createMachinePickerState } from "@/components/new-session-machine-picker"
import { getFleetFocusReceiver, machineOptionsFromFleetSessions } from "./new-session-machine-mount"
import { publishMachineSelection } from "./new-session-machine-selection"

export function NewSessionMachinePicker() {
  const server = useServer()

  // The fleet-sessions projection → the machine list. Keyed on server.current
  // so a server switch re-fetches; a failed/absent projection degrades to [].
  const [fleetSessionsRaw] = createResource(
    () => server.current,
    () => amicodeGet(server.current, "/amicode/fleet/sessions").catch(() => undefined),
  )
  const machines = createMemo(() => machineOptionsFromFleetSessions(fleetSessionsFromResponse(fleetSessionsRaw.latest)))

  // Re-read current focus on mount (the latch is the read-back — W3 exposes no
  // host endpoint), then track live pushes. undefined = home/local.
  const receiver = getFleetFocusReceiver()
  const [focused, setFocused] = createSignal<string | undefined>(receiver?.current())
  onMount(() => {
    setFocused(() => receiver?.current())
    const off = receiver?.subscribe((machineId) => setFocused(() => machineId))
    onCleanup(() => off?.())
  })

  // An explicit user pick overrides the focus default; both flow through the
  // #1442 picker state, whose createPayload carries the chosen machine_id.
  const [override, setOverride] = createSignal<string | undefined>(undefined)
  const picker = createMemo(() =>
    createMachinePickerState({ machines: machines(), focusedMachineId: override() ?? focused() }),
  )

  // #1643 (completes #1484 AC3): publish the picker's effective selection to the
  // submit path. A REMOTE selection is what the create's pre-flight gate reads
  // to arm the x-amicode-owner header; a local one publishes undefined (local,
  // header-less create). Without this the selection was purely cosmetic — the
  // AC3-shipped-incomplete finding.
  createEffect(() => {
    const sel = picker().selectedMachineId
    const chosen = picker().machines.find((m) => m.machineId === sel)
    // A local pick (or the default local) publishes undefined → local create.
    publishMachineSelection(chosen && !chosen.isLocal ? sel : undefined)
  })
  onCleanup(() => publishMachineSelection(undefined))

  return (
    <Show when={machines().length > 0}>
      <label
        data-component="new-session-machine-picker"
        data-machine-id={picker().selectedMachineId}
        class="flex min-h-7 items-center gap-1 text-v2-text-text-faint"
      >
        <span class="sr-only">Machine</span>
        <select
          class="min-w-0 cursor-pointer bg-transparent text-[13px] leading-none text-v2-text-text-muted focus-visible:outline-none"
          value={picker().selectedMachineId}
          onChange={(event) => setOverride(event.currentTarget.value)}
        >
          <For each={picker().machines}>
            {(machine) => (
              <option value={machine.machineId}>
                {machine.name}
                {machine.isLocal ? " (this machine)" : ""}
              </option>
            )}
          </For>
        </select>
      </label>
    </Show>
  )
}

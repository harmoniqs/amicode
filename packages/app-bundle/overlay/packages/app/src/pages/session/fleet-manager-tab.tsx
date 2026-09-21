// FleetManagerContent — the Fleet Manager Work Column tab (#1322, ADR 0026).
// The tab CONSOLIDATES fleet management: Devices (roster + capability chips +
// the local row's inline capabilities edit), This machine (Server mode +
// window-mode + transport selector + Go Standalone / Repair), Hub service
// (server only), Versions (absorbing the retired Fleet & Versions panel), and
// the Enroll action. It INVOKES the existing registered commands — it never
// reimplements their logic (Key Decision) — and follows the design system:
// tokens only, selection-by-border, no raw color/radius literals.
//
// All decision logic lives in the pure, unit-tested ./fleet-manager module;
// this file is the (untested-by-design) SolidJS wiring around it.
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { useServer } from "@/context/server"
import { amicodeGet, amicodePost } from "@/utils/amicode-fetch"
import { postAmicode } from "@/utils/amicode-bridge"
import {
  shapeFleetDeviceRows,
  buildCapabilitiesReport,
  fleetManagerCommand,
  transportPrefill,
  TRANSPORT_OPTIONS,
  enrollAction,
  CREATE_FLEET_COMMAND,
  fleetTransportMessage,
  shapeVersionRows,
  attachControlFor,
  performAttachControl,
  type RosterRowLike,
  type DoctorSurfaceLike,
} from "@/pages/session/fleet-manager"

type FleetManagerSection = "devices" | "machine" | "hub" | "versions"

/** Tolerant roster-response reader → the lawful rows array, else []. Mirrors the
 *  host's own tolerant load: a malformed / error response never throws here. */
function rowsFromRosterResponse(raw: unknown): RosterRowLike[] {
  if (!raw || typeof raw !== "object") return []
  const rows = (raw as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return []
  return rows as RosterRowLike[]
}

function rosterReachable(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as { ok?: unknown }).ok === true
}

export function FleetManagerContent() {
  const server = useServer()
  const [section, setSection] = createSignal<FleetManagerSection>("devices")

  // The local machine id (single-writer: only this row's capabilities are
  // editable). The extension supplies it via the open-fleet-manager message;
  // absent it, rows render read-only (honest — we never fabricate "which
  // machine is us").
  const [localMachineId, setLocalMachineId] = createSignal<string | null>(null)
  // This machine's window-mode axis (remote-ssh | local) — its OWN field, kept
  // separate from link-health posture (ADR 0025 #4). Host-provided via the open
  // message; "unknown" until then (honest, never fabricated / overloaded).
  const [windowMode, setWindowMode] = createSignal<string | null>(null)
  // The doctor report the extension ships with the Versions route (open-fleet-
  // manager). Null until the route provides it — the section degrades honestly.
  const [versionReport, setVersionReport] = createSignal<{ surfaces: DoctorSurfaceLike[] } | null>(null)
  const onBridge = (e: MessageEvent) => {
    const d = e.data as {
      source?: string
      kind?: string
      localMachineId?: string
      windowMode?: string
      section?: FleetManagerSection
      report?: { surfaces: DoctorSurfaceLike[] }
    }
    if (d?.source !== "amicode" || d.kind !== "open-fleet-manager") return
    if (typeof d.localMachineId === "string") setLocalMachineId(d.localMachineId)
    if (typeof d.windowMode === "string") setWindowMode(d.windowMode)
    if (d.report) setVersionReport(d.report)
    if (d.section) setSection(d.section)
  }
  if (typeof window !== "undefined") {
    window.addEventListener("message", onBridge)
    onCleanup(() => window.removeEventListener("message", onBridge))
  }

  const [rosterRaw, { refetch }] = createResource(
    () => server.current,
    () => amicodeGet(server.current, "/amicode/roster").catch(() => undefined),
  )
  const reachable = createMemo(() => rosterReachable(rosterRaw()))
  const rows = createMemo(() => (reachable() ? rowsFromRosterResponse(rosterRaw()) : []))
  const devices = createMemo(() => shapeFleetDeviceRows({ rows: rows(), localMachineId: localMachineId() }))
  const localRow = createMemo(() => rows().find((r) => r.machine_id === localMachineId()) ?? null)
  // Hub service is a server-only concern (Server mode === "server").
  const isServer = createMemo(() => localRow()?.server_mode === "server")

  // ── #1344 (ADR 0027 §3, Slice 4): the current attachment + the Attach control.
  // The attached peer is read from the pointer's OWN local honesty surface
  // (GET /amicode/fleet/attachment — never proxied). A switch re-keys this +
  // the roster (a full reload of the scoped surfaces, so no previous studio's
  // cached data leaks) WITHOUT ever changing server.current: the webview stays
  // SINGLE-ORIGIN. The ADR explicitly rejected reusing useServer's add/setActive
  // (the multi-server switcher) for the data plane — a switch is a backend
  // pointer flip, so this drives the verb via amicodePost(server.current, …),
  // which re-resolves the origin per call.
  const [attachmentRaw, { refetch: refetchAttachment }] = createResource(
    () => server.current,
    () => amicodeGet(server.current, "/amicode/fleet/attachment").catch(() => undefined),
  )
  const attachedMachineId = createMemo(() => {
    const raw = attachmentRaw()
    if (!raw || typeof raw !== "object") return null
    const a = raw as { attached?: boolean; pointer?: { machine_id?: string } | null }
    return a.attached && a.pointer?.machine_id ? a.pointer.machine_id : null
  })
  const runAttachControl = (machineId: string) => {
    void performAttachControl({
      control: attachControlFor(machineId, attachedMachineId()),
      // server.current's SAME origin — single-origin, never a server switch.
      post: (route, body) => amicodePost(server.current, route, body),
    })
      .then(() => {
        // the switch's reload: refetch the scoped surfaces (no stale-cache leak).
        refetchAttachment()
        refetch()
      })
      .catch(() => {})
  }

  // ── Devices: the local row's inline capabilities edit → POST /amicode/roster ─
  const toggleCapability = (tag: string) => {
    const row = localRow()
    if (!row) return
    const has = row.capabilities.includes(tag)
    const next = has ? row.capabilities.filter((c) => c !== tag) : [...row.capabilities, tag]
    void amicodePost(server.current, "/amicode/roster", buildCapabilitiesReport(row, next))
      .then(() => refetch())
      .catch(() => {})
  }

  // ── This machine: transport selector (prefill roaming → tailscale) ──────────
  const transportValue = createMemo(() => {
    const row = localRow()
    return transportPrefill({
      capabilities: row?.capabilities ?? [],
      transport: row?.transport,
    })
  })
  const writeTransport = (value: string) => {
    // value-bearing envelope — the extension writes amicode.fleetTransport.
    try {
      window.parent?.postMessage(fleetTransportMessage(value), "*")
    } catch {
      /* no parent frame (public build) — nothing to write */
    }
  }

  // ── Enroll: launch /create-a-fleet, or the honest not-yet-available state ────
  // On this branch #1320 / /create-a-fleet is not built — the absent case.
  const enroll = createMemo(() => enrollAction({ hasCreateFleetSkill: false }))
  const launchEnroll = () => {
    const action = enroll()
    if (action.available && action.launch) postAmicode(CREATE_FLEET_COMMAND)
  }

  const eyebrow = "text-[10px] uppercase tracking-wide text-text-weak font-[600]"

  const SectionTab = (p: { id: FleetManagerSection; label: string; available?: boolean }) => (
    <Show when={p.available ?? true}>
      <button
        class="flex-1 min-w-0 flex items-center justify-center gap-1 rounded px-1.5 py-1 text-11-medium transition-colors truncate border"
        classList={{
          "border-v2-border-border-strong text-text-base font-[600]": section() === p.id,
          "border-transparent text-text-weak hover:text-text-base": section() !== p.id,
        }}
        onClick={() => setSection(p.id)}
      >
        <span class="truncate">{p.label}</span>
      </button>
    </Show>
  )

  return (
    <div class="relative pt-2 flex-1 min-h-0 overflow-hidden flex flex-col gap-3 p-3">
      {/* Section segmented control — selection-by-border (design system). */}
      <div class="flex items-center gap-0.5 rounded-md border border-border-weak-base p-0.5 min-w-0">
        <SectionTab id="devices" label="Devices" />
        <SectionTab id="machine" label="This machine" />
        <SectionTab id="hub" label="Hub" available={isServer()} />
        <SectionTab id="versions" label="Versions" />
      </div>

      <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-4">
        {/* ── Devices ─────────────────────────────────────────────────────── */}
        <Show when={section() === "devices"}>
          <Show
            when={reachable()}
            fallback={<div class="text-12-regular text-text-weak">Fleet host unreachable.</div>}
          >
            <Show
              when={devices().length > 0}
              fallback={<div class="text-12-regular text-text-weak">No devices reporting yet.</div>}
            >
              <div class="flex flex-col gap-2">
                <For each={devices()}>
                  {(device) => (
                    <div
                      class="flex flex-col gap-1.5 rounded-md border border-border-weak-base p-2"
                      data-machine-id={device.machineId}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <Icon name="server" size="small" />
                        <span class="text-12-medium text-text-base truncate">{device.name}</span>
                        <span class={eyebrow} data-health={device.health}>
                          {device.health}
                        </span>
                        {/* #1344: the per-row Attach/Detach control — a peer row
                            only (you attach to ANOTHER machine, not yourself).
                            Drives the backend verb on server.current's origin. */}
                        <Show when={!device.editable}>
                          <button
                            type="button"
                            class="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] border transition-colors cursor-pointer"
                            classList={{
                              "border-v2-border-border-strong text-text-base": attachedMachineId() === device.machineId,
                              "border-border-weak-base text-text-weak hover:text-text-base":
                                attachedMachineId() !== device.machineId,
                            }}
                            onClick={() => runAttachControl(device.machineId)}
                            data-attach-control={attachControlFor(device.machineId, attachedMachineId()).action}
                            data-attach-machine-id={device.machineId}
                          >
                            {attachControlFor(device.machineId, attachedMachineId()).label}
                          </button>
                        </Show>
                      </div>
                      <div class="text-11-regular text-text-weak">
                        role: {device.role} · last-seen: {device.lastSeen}
                      </div>
                      <div class="flex flex-wrap items-center gap-1">
                        <For each={device.capabilities}>
                          {(chip) => (
                            <button
                              type="button"
                              class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] border transition-colors"
                              classList={{
                                "border-v2-border-border-strong text-text-base": chip.known,
                                "border-border-weak-base text-text-weak": !chip.known,
                                "cursor-pointer hover:text-text-base": device.editable,
                                "cursor-default": !device.editable,
                              }}
                              disabled={!device.editable}
                              onClick={() => device.editable && toggleCapability(chip.tag)}
                              data-tag={chip.tag}
                              data-wired={chip.wired ? "true" : "false"}
                            >
                              <span>{chip.tag}</span>
                              <Show when={chip.note}>
                                <span class="text-text-weak">({chip.note})</span>
                              </Show>
                            </button>
                          )}
                        </For>
                      </div>
                      <Show when={device.editable}>
                        <div class="text-[10px] text-text-weak">
                          Toggle a capability to update this machine's row. Role is the reconciled fleet mirror
                          (changed via enroll / Go Standalone).
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          {/* Enroll — launches /create-a-fleet when present; honest state absent. */}
          <div class="flex flex-col gap-1 rounded-md border border-border-weak-base p-2">
            <div class={eyebrow}>Enroll a device</div>
            <Show
              when={enroll().available}
              fallback={
                <div class="text-11-regular text-text-weak">
                  Guided enrollment isn't available yet on this build.
                </div>
              }
            >
              <button
                type="button"
                class="self-start rounded px-2 py-1 text-11-medium border border-v2-border-border-strong text-text-base cursor-pointer hover:bg-accent-fill-soft"
                onClick={launchEnroll}
              >
                Enroll a device
              </button>
            </Show>
          </div>
        </Show>

        {/* ── This machine ────────────────────────────────────────────────── */}
        <Show when={section() === "machine"}>
          <div class="flex flex-col gap-3">
            <div class="flex flex-col gap-1">
              <div class={eyebrow}>Server mode</div>
              <div class="text-12-regular text-text-base">{localRow()?.server_mode ?? "unknown"}</div>
            </div>

            <div class="flex flex-col gap-1">
              <div class={eyebrow}>Window mode</div>
              <div class="text-12-regular text-text-base">{windowMode() ?? "unknown"}</div>
            </div>

            <div class="flex flex-col gap-1">
              <div class={eyebrow}>Transport</div>
              <select
                class="self-start rounded-md border border-border-weak-base bg-v2-background-bg-layer-02 px-2 py-1 text-12-regular text-text-base"
                value={transportValue()}
                onChange={(e) => writeTransport(e.currentTarget.value)}
              >
                <For each={TRANSPORT_OPTIONS}>{(opt) => <option value={opt}>{opt}</option>}</For>
              </select>
            </div>

            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded px-2 py-1 text-11-medium border border-border-weak-base text-text-base cursor-pointer hover:bg-accent-fill-soft"
                onClick={() => postAmicode(fleetManagerCommand("goStandalone"))}
              >
                Go Standalone
              </button>
              <button
                type="button"
                class="rounded px-2 py-1 text-11-medium border border-border-weak-base text-text-base cursor-pointer hover:bg-accent-fill-soft"
                onClick={() => postAmicode(fleetManagerCommand("repair"))}
              >
                Repair
              </button>
            </div>
          </div>
        </Show>

        {/* ── Hub service (server only) ───────────────────────────────────── */}
        <Show when={section() === "hub" && isServer()}>
          <div class="flex flex-col gap-2">
            <div class={eyebrow}>Durable hub</div>
            <div class="text-12-regular text-text-weak">
              The durable hub keeps the fleet reachable between sessions.
            </div>
            <button
              type="button"
              class="self-start rounded px-2 py-1 text-11-medium border border-border-weak-base text-text-base cursor-pointer hover:bg-accent-fill-soft"
              onClick={() => postAmicode(fleetManagerCommand("restartHub"))}
            >
              Restart hub
            </button>
          </div>
        </Show>

        {/* ── Versions (absorbs the retired Fleet & Versions panel) ───────── */}
        <Show when={section() === "versions"}>
          <div class="flex flex-col gap-2">
            <div class={eyebrow}>Fleet &amp; versions</div>
            <Show
              when={shapeVersionRows(versionReport()).length > 0}
              fallback={
                <div class="text-12-regular text-text-weak">
                  Version status is checked by <span class="text-text-base">amico doctor</span>. Open this from the
                  command palette (Fleet &amp; Versions) to load the surface report.
                </div>
              }
            >
              <div class="flex flex-col gap-1">
                <For each={shapeVersionRows(versionReport())}>
                  {(v) => (
                    <div
                      class="flex items-center justify-between gap-2 rounded-md border border-border-weak-base p-2"
                      data-surface={v.surface}
                    >
                      <span class="text-12-medium text-text-base truncate">{v.surface}</span>
                      <span class="text-11-regular text-text-weak tabular-nums">
                        {v.version} → {v.sourceVersion}
                      </span>
                      <span
                        class="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 border border-border-weak-base text-text-weak"
                        data-verdict={v.verdict}
                      >
                        {v.verdict}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

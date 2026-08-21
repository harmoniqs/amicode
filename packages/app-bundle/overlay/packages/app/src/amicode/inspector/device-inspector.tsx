import { For, Show, createMemo } from "solid-js"
import type { createInspectorBridge } from "./inspector-bridge"

type Props = { bridge: ReturnType<typeof createInspectorBridge> }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

export function DeviceInspector(props: Props) {
  const devices = () => Array.from(props.bridge.devices().entries())
  const active = createMemo(() => {
    const id = props.bridge.activeDevice()
    if (id && props.bridge.devices().has(id)) return { id, data: props.bridge.devices().get(id)! }
    const first = devices()[0]
    return first ? { id: first[0], data: first[1] } : undefined
  })

  const refresh = (device: string) => {
    window.parent.postMessage({ source: "amicode", kind: "device:refresh", device }, "*")
    // also try direct parent (when not in deck pane iframe indirection the host still listens)
    window.postMessage({ source: "amicode", kind: "device:refresh", device }, "*")
  }

  return (
    <div class="flex flex-col gap-3 p-3" data-component="device-inspector">
      <div class="flex items-center justify-between">
        <div class="text-12-medium">Device Inspector</div>
        <Show when={devices().length > 1}>
          <select
            class="text-12-regular border border-border-weaker-base rounded px-1 py-0.5 bg-background-base max-w-[140px] truncate"
            value={active()?.id ?? ""}
            onChange={(e) => props.bridge.setActiveDevice(e.currentTarget.value)}
          >
            <For each={devices()}>{([id]) => <option value={id}>{id}</option>}</For>
          </select>
        </Show>
      </div>

      <Show when={!active()} fallback={
        <div class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <div class="text-11-medium truncate">{active()!.id}</div>
            <button class="ml-auto text-11-regular border rounded px-2 py-0.5" onClick={() => refresh(active()!.id)}>
              Refresh
            </button>
          </div>

          <Show when={isRecord(active()!.data.status) && (active()!.data.status as Record<string, unknown>).driveLines}>
            {(dl) => (
              <div>
                <div class="text-11-medium text-text-faint">Drive lines</div>
                <div class="flex flex-wrap gap-1 mt-1">
                  <For each={(active()!.data.status as { driveLines: { id: string; online: boolean }[] }).driveLines}>
                    {(d) => (
                      <span class="text-11-regular border rounded-full px-2 py-0.5" data-online={d.online}>
                        {d.id} {d.online ? "●" : "○"}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>

          <Show when={isRecord(active()!.data.status) && (active()!.data.status as Record<string, unknown>).qubits}>
            <div>
              <div class="text-11-medium text-text-faint">Qubits</div>
              <div class="flex flex-wrap gap-1 mt-1">
                <For each={(active()!.data.status as { qubits: { qubit: string; status: string }[] }).qubits}>
                  {(q) => <span class="text-11-regular border rounded px-2 py-0.5">{q.qubit}: {q.status}</span>}
                </For>
              </div>
            </div>
          </Show>

          <Show when={isRecord(active()!.data.status) && (active()!.data.status as Record<string, unknown>).metrics}>
            <div>
              <div class="text-11-medium text-text-faint">Metrics</div>
              <For each={Object.entries((active()!.data.status as { metrics: Record<string, { value: number; ageSeconds: number; status: string }> }).metrics)}>
                {([k, m]) => (
                  <div class="flex justify-between text-11-regular border-b border-border-weaker-base py-1">
                    <span>{k}</span>
                    <span class="font-mono">
                      {m.value.toFixed(4)} · {m.status} · {Math.round(m.ageSeconds)}s ago
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={isRecord(active()!.data.status) && (active()!.data.status as Record<string, unknown>).calibrationParams}>
            <div>
              <div class="text-11-medium text-text-faint">Calibration params</div>
              <div class="text-11-regular font-mono whitespace-pre-wrap break-all border rounded p-2 bg-[var(--v2-background-bg-subtle)]">
                {JSON.stringify((active()!.data.status as { calibrationParams: unknown }).calibrationParams, null, 2)}
              </div>
            </div>
          </Show>

          <Show when={active()!.data.actions.length > 0}>
            <div>
              <div class="text-11-medium text-text-faint">Recommended actions</div>
              <For each={active()!.data.actions as { node: string; action: string; locked?: boolean; reason?: string }[]}>
                {(a) => (
                  <div class="border rounded p-2 mt-1 text-11-regular" data-locked={a.locked}>
                    <div class="font-mono">{a.node} → {a.action} {a.locked ? "🔒" : ""}</div>
                    <Show when={a.reason}>
                      <div class="text-text-weak">{a.reason}</div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      }>
        <div class="text-12-regular text-text-weak py-8 text-center">No device — configure one in settings.</div>
      </Show>
    </div>
  )
}

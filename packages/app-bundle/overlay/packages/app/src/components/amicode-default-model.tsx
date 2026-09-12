import { For, Show, createMemo } from "solid-js"
import { useModels } from "@/context/models"
import { formatModelValue, parseModelValue } from "./amicode-default-model-value"

// Dashboard "Default model" control. Drives opencode's GLOBAL model store
// (useModels — mounted app-wide, persisted via Persist.global), which is what
// new chats inherit as their starting model (see local.tsx recentModel()), so
// a change takes effect immediately with no server restart. It ALSO mirrors the
// choice into the `amicode.defaultModel` VS Code setting over the iframe→parent
// bridge (chat_panel.ts), keeping the headless/first-turn config pin in sync.
// The in-chat picker still overrides per session.

/** Post the chosen model to the extension host so it updates amicode.defaultModel.
 *  No-op when unframed (plain web/desktop): there's no parent shell to relay it. */
function syncDefaultModelPin(model: string, win: Window = window): void {
  if (win.parent === win) return
  win.parent.postMessage({ source: "amicode", kind: "set-default-model", model }, "*")
}

export function AmicodeDefaultModel() {
  const models = useModels()

  const available = createMemo(() => models.list())
  // opencode's default visibility hides dated, non-"latest" models — which can
  // hide EVERY model and leave the control empty. Prefer the visible set, but
  // fall back to all available models so the picker is never blank when models
  // exist. (Guarded below on available(), so it only hides with zero models.)
  const selectable = createMemo(() => {
    const vis = available().filter((m) => models.visible({ providerID: m.provider.id, modelID: m.id }))
    return vis.length > 0 ? vis : available()
  })

  const groups = createMemo(() => {
    const byProvider = new Map<string, { provider: string; items: { value: string; name: string }[] }>()
    for (const m of selectable()) {
      const group = byProvider.get(m.provider.id) ?? { provider: m.provider.name, items: [] }
      group.items.push({ value: formatModelValue({ providerID: m.provider.id, modelID: m.id }), name: m.name })
      byProvider.set(m.provider.id, group)
    }
    return [...byProvider.values()]
  })

  // Bound to the DURABLE pin (models.pin), not the recents head — chats using
  // other models must not move the dashboard's declared default. Empty = Auto
  // (no pin; new chats fall back to recents/provider default).
  const current = createMemo(() => {
    const pin = models.pin.get()
    return pin ? formatModelValue(pin) : ""
  })

  const choose = (value: string) => {
    if (value === "") {
      models.pin.set(undefined) // Auto: clear the pin, mirror the cleared setting
      syncDefaultModelPin("")
      return
    }
    const key = parseModelValue(value)
    if (!key) return
    models.pin.set(key)
    syncDefaultModelPin(value)
  }

  return (
    <Show when={available().length > 0}>
      <label
        data-component="amicode-default-model"
        title="Default model for new chats"
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "8px",
          "font-size": "12px",
          color: "var(--v2-text-text-muted)",
        }}
      >
        <span data-slot="amicode-default-model-label" style={{ "font-weight": "550" }}>
          Model
        </span>
        <select
          data-slot="amicode-default-model-select"
          value={current()}
          onChange={(event) => choose(event.currentTarget.value)}
          style={{
            "font-size": "12px",
            color: "var(--v2-text-text-base)",
            background: "var(--v2-background-bg-layer-01)",
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "var(--radius-md)",
            padding: "4px 8px",
            "max-width": "220px",
            cursor: "pointer",
          }}
        >
          <option value="">Auto</option>
          <For each={groups()}>
            {(group) => (
              <optgroup label={group.provider}>
                <For each={group.items}>{(item) => <option value={item.value}>{item.name}</option>}</For>
              </optgroup>
            )}
          </For>
        </select>
      </label>
    </Show>
  )
}

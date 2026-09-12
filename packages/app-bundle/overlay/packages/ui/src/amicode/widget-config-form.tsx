import { For, Show } from "solid-js"
import type { FormField } from "./widget-schema"

// AMICODE (widget kernel): the ⚙ form, GENERATED from a widget's manifest
// config schema (widget-schema.formModel). Every change calls onChange
// immediately — the grid saves state per change, no save button (spec T2.6).

const LABEL: Record<string, string> = {}

function labelFor(key: string): string {
  return LABEL[key] ?? key.replace(/[_-]/g, " ")
}

const INPUT_STYLE = {
  "font-size": "11px",
  padding: "2px 6px",
  border: "1px solid var(--v2-border-border-base)",
  "border-radius": "var(--radius-sm)",
  background: "var(--v2-background-bg-base)",
  color: "var(--v2-text-text-base)",
} as const

export function WidgetConfigForm(props: { fields: FormField[]; onChange: (key: string, value: unknown) => void }) {
  return (
    <div
      data-component="amicode-widget-config"
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "6px",
        padding: "8px 10px",
        border: "1px solid var(--v2-border-border-base)",
        "border-radius": "var(--radius-md)",
        background: "var(--v2-background-bg-layer-02)",
        "font-size": "11px",
        color: "var(--v2-text-text-muted)",
      }}
    >
      <Show when={props.fields.length === 0}>
        <span>nothing to configure</span>
      </Show>
      <For each={props.fields}>
        {(field) => (
          <label style={{ display: "flex", "align-items": "center", gap: "8px", "min-width": "0" }}>
            <span style={{ flex: "0 0 90px", overflow: "hidden", "text-overflow": "ellipsis" }}>
              {labelFor(field.key)}
            </span>
            {field.kind === "boolean" ? (
              <input
                type="checkbox"
                checked={field.value}
                onChange={(e) => props.onChange(field.key, e.currentTarget.checked)}
              />
            ) : field.kind === "select" ? (
              <select
                value={field.value}
                onChange={(e) => props.onChange(field.key, e.currentTarget.value)}
                style={INPUT_STYLE}
              >
                <For each={field.options}>{(o) => <option value={o}>{o}</option>}</For>
              </select>
            ) : field.kind === "multi-select" ? (
              <span style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
                <For each={field.options}>
                  {(o) => (
                    <label style={{ display: "inline-flex", gap: "3px", "align-items": "center" }}>
                      <input
                        type="checkbox"
                        checked={field.value.includes(o)}
                        onChange={(e) => {
                          const next = e.currentTarget.checked
                            ? [...field.value, o]
                            : field.value.filter((x) => x !== o)
                          props.onChange(field.key, next)
                        }}
                      />
                      {o}
                    </label>
                  )}
                </For>
              </span>
            ) : field.kind === "number" ? (
              <input
                type="number"
                value={field.value}
                min={field.min}
                max={field.max}
                onChange={(e) => props.onChange(field.key, Number(e.currentTarget.value))}
                style={{ ...INPUT_STYLE, width: "70px" }}
              />
            ) : (
              <input
                type="text"
                value={field.value}
                maxLength={field.maxLength}
                onChange={(e) => props.onChange(field.key, e.currentTarget.value)}
                style={{ ...INPUT_STYLE, flex: "1" }}
              />
            )}
          </label>
        )}
      </For>
    </div>
  )
}

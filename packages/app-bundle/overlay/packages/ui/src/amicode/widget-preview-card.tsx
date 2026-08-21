import { For, Show, createMemo, createSignal } from "solid-js"
import { WidgetFrame } from "./widget-frame"
import type { WidgetInfo } from "./widget-schema"
import { amicodeWidgetHost } from "./ui-bridge"
import { resolveTokens, densityForViewport } from "./widget-tokens"
import type { WidgetPreview } from "./widget-preview"

// AMICODE (Stage 2 chat authoring): renders an amicode_author_widget tool
// result as a LIVE preview of the just-authored widget, inside the chat. Reuses
// the exact frame kernel the home grid uses (server-served sandboxed frame +
// bridge), reading the server context (frame src base, host callbacks, pin
// verb) off the ui-bridge — same idiom as the RunWindow. "Pin to dashboard"
// adds it to home. Re-authoring the same id emits a new hash → a fresh preview
// with the updated code (hot-reload). No host registered (e.g. TUI) → a plain
// note, never a crash.

export function WidgetPreviewCard(props: { preview: WidgetPreview }) {
  const host = createMemo(() => amicodeWidgetHost())
  const [pinState, setPinState] = createSignal<"idle" | "pinning" | "pinned" | "error">("idle")

  const info = createMemo<WidgetInfo>(() => ({
    id: props.preview.id,
    name: props.preview.name,
    version: "1.0.0",
    bridge: 1,
    description: "",
    size: props.preview.size,
    height: props.preview.height,
    config: {},
    builtin: false,
    overridden: false,
    hash: props.preview.hash,
    path: null,
  }))

  // computed at mount — a preview doesn't need live theme reactivity
  const style = getComputedStyle(document.documentElement)
  const density = densityForViewport(window.innerWidth, window.innerHeight)
  const tokens = resolveTokens((n) => style.getPropertyValue(n), density)

  const pin = () => {
    const h = host()
    if (!h || pinState() === "pinning" || pinState() === "pinned") return
    setPinState("pinning")
    void h
      .pin(props.preview.id, props.preview.size)
      .then(() => setPinState("pinned"))
      .catch(() => setPinState("error"))
  }
  const pinLabel = () =>
    ({ idle: "Pin to dashboard", pinning: "Pinning…", pinned: "Pinned to dashboard ✓", error: "Couldn’t pin — retry" })[
      pinState()
    ]

  return (
    <div data-component="amicode-widget-preview" data-size={props.preview.size}>
      <div class="amc-wp-head">
        <span class="amc-wp-eyebrow">Widget preview</span>
        <span class="amc-wp-name">{props.preview.name}</span>
        <span class="amc-wp-badge">{props.preview.size}</span>
      </div>

      <Show
        when={host()}
        fallback={<div class="amc-wp-note">Open your Amicode dashboard to see “{props.preview.name}”.</div>}
      >
        {(h) => (
          <div class="amc-wp-stage">
            <WidgetFrame
              widget={info()}
              frameSrc={h().frameSrc(props.preview.id, props.preview.hash)}
              config={{}}
              context={{}}
              tokens={tokens}
              density={density}
              callbacks={h().callbacks}
            />
          </div>
        )}
      </Show>

      <Show when={props.preview.warnings.length > 0}>
        <ul class="amc-wp-warnings">
          <For each={props.preview.warnings}>{(w) => <li>{w}</li>}</For>
        </ul>
      </Show>

      <div class="amc-wp-foot">
        <button
          type="button"
          class="amc-wp-pin"
          data-state={pinState()}
          disabled={!host() || pinState() === "pinning" || pinState() === "pinned"}
          onClick={pin}
        >
          {pinLabel()}
        </button>
        <span class="amc-wp-hint">or ask me to change it</span>
      </div>
    </div>
  )
}

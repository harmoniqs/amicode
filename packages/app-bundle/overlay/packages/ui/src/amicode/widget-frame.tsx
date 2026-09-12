import { Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import { HOST_BRIDGE_VERSION, handleWidgetMessage } from "./widget-bridge"
import type { WidgetInfo } from "./widget-schema"
import type { Density } from "./widget-tokens"

// AMICODE (widget kernel): one sandboxed iframe per widget. THIN SHELL — all
// message routing lives in widget-bridge.ts (tested); this component only
// wires DOM events to it and owns the three visual states: loading (manifest
// height placeholder), running (content-height frame), error card. A widget
// that reports height 0 is an empty-state: the host collapses the cell
// (grid hides it outside edit mode). Bridge-version gate: a widget declaring
// a newer bridge than this host supports never mounts — error card instead.
// The frame loads a SERVER-SERVED document (/amicode/widget-frame?id=), not
// srcdoc: srcdoc inherits the app's CSP, which forbids the inline runtime.
// sandbox="allow-scripts" keeps the origin opaque regardless of the src.

const LOAD_TIMEOUT_MS = 5000

export interface WidgetHostCallbacks {
  fetch: (path: string) => Promise<unknown>
  action: (verb: string, payload: unknown) => Promise<unknown>
  prompt: (text: string) => void
  open: (entity: string) => void
}

export function WidgetFrame(props: {
  widget: WidgetInfo
  frameSrc: string | undefined // full /amicode/widget-frame URL; undefined while resolving
  config: Record<string, unknown>
  context: Record<string, unknown>
  tokens: Record<string, string>
  density: Density
  callbacks: WidgetHostCallbacks
  onHeight?: (h: number) => void
  /** explicit empty-state (never inferred from height — hidden frames have no layout) */
  onEmpty?: (empty: boolean) => void
  /** geometric mode: the frame fills its host-sized block; the widget's
   *  reported content height is ignored (the empty signal still flows) */
  fill?: boolean
}) {
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [height, setHeight] = createSignal<number>(props.widget.height)
  const [booted, setBooted] = createSignal(false)
  let iframe: HTMLIFrameElement | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const versionBlocked = createMemo(() => props.widget.bridge > HOST_BRIDGE_VERSION)

  const src = createMemo(() => (versionBlocked() ? undefined : props.frameSrc))

  const postToFrame = (msg: unknown) => {
    iframe?.contentWindow?.postMessage(msg, "*")
  }

  const onMessage = (e: MessageEvent) => {
    if (!iframe || e.source !== iframe.contentWindow) return
    void handleWidgetMessage(e.data, {
      fetch: props.callbacks.fetch,
      action: props.callbacks.action,
      prompt: props.callbacks.prompt,
      open: props.callbacks.open,
      ready: () => {
        setBooted(true)
        if (timeout !== undefined) clearTimeout(timeout)
        postToFrame({
          t: "amc:init",
          v: HOST_BRIDGE_VERSION,
          config: props.config,
          theme: props.tokens,
          context: props.context,
          density: props.density,
        })
      },
      height: (h) => {
        if (h > 0) setHeight(h)
        props.onHeight?.(h)
      },
      empty: (empty) => props.onEmpty?.(empty),
      error: (message) => setError(message),
      post: postToFrame,
    })
  }

  createEffect(() => {
    if (src() === undefined) return
    window.addEventListener("message", onMessage)
    timeout = setTimeout(() => {
      if (!booted()) setError("widget did not boot within 5s")
    }, LOAD_TIMEOUT_MS)
    onCleanup(() => {
      window.removeEventListener("message", onMessage)
      if (timeout !== undefined) clearTimeout(timeout)
    })
  })

  // live updates ride the bridge, no frame reload
  createEffect(on(() => props.config, (c) => booted() && postToFrame({ t: "amc:config", config: c }), { defer: true }))
  createEffect(on(() => props.context, (c) => booted() && postToFrame({ t: "amc:context", context: c }), { defer: true }))
  createEffect(
    on(
      () => [props.tokens, props.density] as const,
      ([tokens, density]) => booted() && postToFrame({ t: "amc:theme", theme: tokens, density }),
      { defer: true },
    ),
  )

  return (
    <Show
      when={!versionBlocked() && !error()}
      fallback={
        <div
          data-component="amicode-widget-error"
          style={{
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "var(--radius-lg)",
            background: "var(--v2-background-bg-layer-01)",
            padding: "10px 12px",
            "font-size": "11px",
            color: "var(--v2-text-text-muted)",
            display: "flex",
            "flex-direction": "column",
            gap: "4px",
          }}
        >
          <span style={{ "font-weight": "600", color: "var(--v2-text-text-base)" }}>
            {props.widget.name} <span style={{ color: "var(--v2-state-fg-danger)" }}>failed</span>
          </span>
          <span style={{ "word-break": "break-word" }}>
            {versionBlocked()
              ? `needs bridge v${props.widget.bridge}; this host speaks v${HOST_BRIDGE_VERSION}`
              : error()}
          </span>
          <Show when={props.widget.path}>
            <span style={{ "font-family": "var(--font-family-mono, monospace)", "font-size": "10px", color: "var(--v2-text-text-faint)" }}>
              {props.widget.path}
            </span>
          </Show>
        </div>
      }
    >
      <iframe
        ref={iframe}
        title={props.widget.name}
        sandbox="allow-scripts"
        src={src()}
        style={{
          display: "block",
          width: "100%",
          height: props.fill ? "100%" : `${height()}px`,
          border: "none",
          background: "transparent",
          "color-scheme": "normal",
        }}
      />
    </Show>
  )
}

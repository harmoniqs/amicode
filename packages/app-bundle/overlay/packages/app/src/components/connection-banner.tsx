import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"

// Amicode webview: a dead server (e.g. an opencode:build restart) used to read
// as an endless "thinking" wave — the event loop retries silently every 250ms.
// Surface the drop and the recovery. The fresh stream's server.connected makes
// server-sync refetch everything, so recovery needs no reload in most cases.
export function ConnectionBanner() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [connectedOnce, setConnectedOnce] = createSignal(false)
  const [wasDown, setWasDown] = createSignal(false)
  const [flash, setFlash] = createSignal(false)
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => {
    if (flashTimer !== undefined) clearTimeout(flashTimer)
  })

  createEffect(() => {
    const status = sdk().event.status()
    // Always clear wasDown when we're connected, even on first connect
    if (status === "connected") {
      if (wasDown()) {
        setWasDown(false)
        setFlash(true)
        if (flashTimer !== undefined) clearTimeout(flashTimer)
        flashTimer = setTimeout(() => {
          setFlash(false)
          flashTimer = undefined
        }, 3000)
      }
      if (!connectedOnce()) {
        setConnectedOnce(true)
      }
      return
    }
    if (status === "disconnected") {
      // Only report drops after a first successful connect — boot renders
      // "disconnected" transiently while the stream is still being set up.
      if (connectedOnce()) setWasDown(true)
      if (flashTimer !== undefined) {
        clearTimeout(flashTimer)
        flashTimer = undefined
      }
      setFlash(false)
    }
  })

  const down = () => wasDown() && sdk().event.status() === "disconnected"

  return (
    <Show when={down() || flash()}>
      <div
        data-component="amicode-connection-banner"
        data-state={down() ? "down" : "up"}
        style={{
          position: "fixed",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          "z-index": 40,
          padding: "6px 14px",
          "border-radius": "999px",
          "font-size": "12px",
          "font-weight": 600,
          border: "1px solid var(--v2-border-border-base, #3c3c3c)",
          background: "var(--v2-background-bg-layer-01, #1e1e1e)",
          "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.35)",
          color: down() ? "var(--v2-state-fg-warning, #d29922)" : "var(--v2-state-fg-success, #3fb950)",
        }}
      >
        {down() ? language.t("app.server.connectionLost") : language.t("app.server.reconnected")}
      </div>
    </Show>
  )
}

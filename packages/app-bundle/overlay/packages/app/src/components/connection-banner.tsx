import { Show, createEffect, createSignal, onCleanup } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import {
  DOWN_GRACE_MS,
  RECONNECT_FLASH_MS,
  computeBannerState,
  type StreamStatus,
} from "./connection-banner-state"

// Amicode webview (amicode#653): the hub-down banner. The 2026-08-30 hub
// incidents left fleet panels reading a dead hub as an eternal loading
// screen — the surface the user stares at said nothing while the journal
// held the answer. This banner surfaces the truth with an exit: after a
// first successful connect, a disconnect that outlives the grace window
// becomes an explicit "Hub unreachable" pill offering Restart Hub (the
// client-initiated atomic restart, amicode#649 — a restart initiated from
// the client's extension host can never kill its own runtime). Brief blips
// and the boot transient stay silent; recovery flashes only after a
// spell that earned the banner. State law lives in
// ./connection-banner-state.ts (unit-tested); this component only binds it.

export function ConnectionBanner() {
  const sdk = useServerSDK()
  const language = useLanguage()
  const [connectedOnce, setConnectedOnce] = createSignal(false)
  const [downSince, setDownSince] = createSignal<number | null>(null)
  const [recoveredAt, setRecoveredAt] = createSignal<number | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [restarting, setRestarting] = createSignal(false)
  let ticker: ReturnType<typeof setInterval> | undefined
  let flashDeadline = 0

  onCleanup(() => {
    if (ticker !== undefined) clearInterval(ticker)
  })

  createEffect(() => {
    const status: StreamStatus = sdk().event.status()
    if (status === "connected") {
      if (downSince() !== null) {
        setRecoveredAt(Date.now())
        flashDeadline = Date.now() + RECONNECT_FLASH_MS
      }
      setDownSince(null)
      if (!connectedOnce()) setConnectedOnce(true)
      if (ticker === undefined) ticker = setInterval(() => setNow(Date.now()), 500)
      return
    }
    // Disconnected: stamp the spell start (boot transient stays silent —
    // connectedOnce is still false), keep the ticker only while a spell is
    // live so the grace window can flip the state.
    if (downSince() === null && connectedOnce()) setDownSince(Date.now())
    if (downSince() !== null && ticker === undefined) ticker = setInterval(() => setNow(Date.now()), 500)
  })

  // Stop the ticker when nothing needs it (connected, no live flash).
  createEffect(() => {
    const state = computeBannerState({
      status: sdk().event.status(),
      connectedOnce: connectedOnce(),
      downSince: downSince(),
      recoveredAt: recoveredAt(),
      now: now(),
    })
    if (state.mode === "silent" && flashDeadline !== 0 && Date.now() >= flashDeadline) {
      setRecoveredAt(null)
      flashDeadline = 0
    }
    if (state.mode === "silent" && downSince() === null && flashDeadline === 0 && ticker !== undefined) {
      clearInterval(ticker)
      ticker = undefined
    }
  })

  const state = () =>
    computeBannerState({
      status: sdk().event.status(),
      connectedOnce: connectedOnce(),
      downSince: downSince(),
      recoveredAt: recoveredAt(),
      now: now(),
    })

  const restartHub = () => {
    setRestarting(true)
    // The extension-host bridge (strict allowlist) owns the actual restart —
    // the client-side path can never kill its own runtime.
    window.parent.postMessage({ source: "amicode", kind: "command", command: "amicode.restartHub" }, "*")
    // The banner resolves itself when the stream reconnects; if the hub was
    // only paused (not down), the stream may never drop — clear the spinner
    // so the button can't stick.
    setTimeout(() => setRestarting(false), 15_000)
  }

  return (
    <Show when={state().mode !== "silent"}>
      <div
        data-component="amicode-connection-banner"
        data-state={state().mode}
        style={{
          position: "fixed",
          bottom: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          "z-index": 40,
          display: "flex",
          "align-items": "center",
          gap: "10px",
          padding: "6px 14px",
          "border-radius": "var(--radius-full)",
          "font-size": "12px",
          "font-weight": 600,
          border: "1px solid var(--v2-border-border-base, #3c3c3c)",
          background: "var(--v2-background-bg-layer-01, #1e1e1e)",
          "box-shadow": "0 8px 24px rgba(0, 0, 0, 0.35)",
          color:
            state().mode === "down"
              ? "var(--v2-state-fg-warning, #d29922)"
              : "var(--v2-state-fg-success, #3fb950)",
        }}
      >
        {state().mode === "down"
          ? `${language.t("app.server.connectionLost")}`
          : language.t("app.server.reconnected")}
        <Show when={state().showRestart}>
          <button
            type="button"
            disabled={restarting()}
            onClick={restartHub}
            style={{
              cursor: restarting() ? "default" : "pointer",
              padding: "2px 10px",
              "border-radius": "var(--radius-full)",
              "font-size": "11px",
              "font-weight": 600,
              border: "1px solid var(--v2-border-border-base, #3c3c3c)",
              background: "transparent",
              color: "inherit",
              opacity: restarting() ? 0.6 : 1,
            }}
          >
            {restarting() ? "…" : language.t("app.server.restartHub")}
          </button>
        </Show>
      </div>
    </Show>
  )
}

// DOWN_GRACE_MS re-exported for the test surface.
export { DOWN_GRACE_MS }

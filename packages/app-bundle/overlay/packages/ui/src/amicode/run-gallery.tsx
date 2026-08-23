import { For, Show, createSignal } from "solid-js"
import { type RunCardData, renderRunCardSvg, runCardPngDataUrl, runCardFilename } from "./run-card"

// AMICODE: the run gallery — a full-screen overlay of shareable run cards
// (every completed solve, newest first). Each card renders the SAME SVG that
// exports, so what you see is exactly the PNG you share. Save routes through
// props.onSave (the extension's save-file bridge in the webview; the app falls
// back to a plain <a download> in a browser).

export function AmicodeRunGallery(props: {
  cards: RunCardData[] | undefined
  onClose: () => void
  onSave?: (filename: string, pngDataUrl: string) => void
}) {
  const [busy, setBusy] = createSignal<string | undefined>(undefined)

  const save = async (card: RunCardData) => {
    setBusy(card.runId)
    try {
      const png = await runCardPngDataUrl(card)
      const filename = runCardFilename(card)
      if (props.onSave) props.onSave(filename, png)
      else {
        const a = document.createElement("a")
        a.href = png
        a.download = filename
        a.click()
      }
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <div
      data-component="amicode-run-gallery"
      style={{
        position: "fixed",
        inset: "0",
        "z-index": "60",
        background: "color-mix(in srgb, #000 50%, transparent)",
        display: "flex",
        "flex-direction": "column",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        style={{
          margin: "24px auto",
          width: "min(1040px, calc(100vw - 48px))",
          "max-height": "calc(100vh - 48px)",
          display: "flex",
          "flex-direction": "column",
          "border-radius": "var(--radius-lg)",
          border: "1px solid var(--v2-border-border-base)",
          background: "var(--v2-background-bg-base)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            "align-items": "center",
            gap: "10px",
            padding: "14px 20px",
            "border-bottom": "1px solid var(--v2-border-border-base)",
          }}
        >
          <span style={{ "font-size": "15px", "font-weight": "650", color: "var(--v2-text-text-base)" }}>
            Run gallery
          </span>
          <span style={{ "font-size": "12px", color: "var(--v2-text-text-muted)" }}>
            {props.cards ? `${props.cards.length} solved` : "loading…"}
          </span>
          <button
            type="button"
            onClick={() => props.onClose()}
            style={{
              "margin-left": "auto",
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--v2-text-text-muted)",
              "font-size": "18px",
              "line-height": "1",
              padding: "4px",
            }}
            aria-label="Close gallery"
          >
            ✕
          </button>
        </div>
        <div style={{ overflow: "auto", padding: "20px", display: "flex", "flex-direction": "column", gap: "20px" }}>
          <Show
            when={props.cards && props.cards.length > 0}
            fallback={
              <div
                style={{
                  padding: "40px 0",
                  "text-align": "center",
                  color: "var(--v2-text-text-muted)",
                  "font-size": "13px",
                }}
              >
                {props.cards ? "No completed solves yet — finish one and it lands here." : "Loading cards…"}
              </div>
            }
          >
            <For each={props.cards}>
              {(card) => (
                <div style={{ display: "flex", "flex-direction": "column", gap: "8px" }}>
                  {/* the display IS the export: same SVG markup, scaled to fit */}
                  <div
                    style={{
                      "border-radius": "var(--radius-lg)",
                      overflow: "hidden",
                      "line-height": "0",
                      border: "1px solid var(--v2-border-border-base)",
                    }}
                    innerHTML={renderRunCardSvg(card).replace(
                      'width="1200" height="630"',
                      'width="100%" height="auto"',
                    )}
                  />
                  <div style={{ display: "flex", "align-items": "center", gap: "10px" }}>
                    <button
                      type="button"
                      data-slot="amicode-card-save"
                      disabled={busy() === card.runId}
                      onClick={() => void save(card)}
                      style={{
                        background: "var(--accent, #FFE614)",
                        color: "var(--accent-ink, #111214)",
                        border: "none",
                        "border-radius": "var(--radius-md)",
                        padding: "5px 14px",
                        "font-size": "12px",
                        "font-weight": "600",
                        cursor: "pointer",
                      }}
                    >
                      {busy() === card.runId ? "Rendering…" : "Save PNG"}
                    </button>
                    <span style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>
                      {card.problem} · {card.runId.slice(0, 18)}
                    </span>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </div>
  )
}

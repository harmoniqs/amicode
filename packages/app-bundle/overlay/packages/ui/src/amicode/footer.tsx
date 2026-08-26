import { Mark } from "../components/logo"

// amicode: slim home-page footer — brand link, quiet resource links, engine
// chip. Links open via the extension bridge (window.open is dead in the
// webview iframe); plain-browser contexts fall back to window.open.

const LINKS: { label: string; url: string }[] = [
  { label: "harmoniqs.ai", url: "https://www.harmoniqs.ai" },
  { label: "Piccolo.jl", url: "https://github.com/harmoniqs/Piccolo.jl" },
  { label: "GitHub", url: "https://github.com/harmoniqs" },
]

function openExternal(url: string) {
  if (window.parent !== window) window.parent.postMessage({ source: "amicode", kind: "open-external", url }, "*")
  else window.open(url, "_blank", "noreferrer")
}

export function AmicodeFooter() {
  return (
    <div
      data-component="amicode-footer"
      style={{
        display: "flex",
        "align-items": "center",
        gap: "16px",
        "margin-top": "auto",
        padding: "10px 2px 0",
        "border-top": "1px solid var(--v2-border-border-base)",
      }}
    >
      <button
        type="button"
        onClick={() => openExternal("https://www.harmoniqs.ai")}
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "8px",
          background: "none",
          border: "none",
          cursor: "pointer",
          padding: "0",
          color: "var(--v2-text-text-base)",
          "font-size": "12px",
          "font-weight": "600",
        }}
      >
        <Mark class="size-4" />
        Harmoniqs ↗
      </button>
      <div style={{ display: "flex", gap: "14px", "margin-left": "auto" }}>
        {LINKS.slice(1).map((l) => (
          <button
            type="button"
            onClick={() => openExternal(l.url)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "0",
              color: "var(--v2-text-text-muted)",
              "font-size": "11px",
            }}
          >
            {l.label} ↗
          </button>
        ))}
        <span
          style={{
            "font-size": "10px",
            color: "var(--v2-text-text-faint)",
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "var(--radius-full)",
            padding: "2px 8px",
          }}
        >
          Piccolo engine
        </span>
      </div>
    </div>
  )
}

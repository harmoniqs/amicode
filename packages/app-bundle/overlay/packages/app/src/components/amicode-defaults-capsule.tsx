import { Show, batch, createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import { useModels } from "@/context/models"
import { AmicodeDefaultModel } from "./amicode-default-model"
import { announceChromeDropdown, chromeDropdownOpenId, clearChromeDropdown } from "@/utils/chrome-dropdown"
import {
  hpAfterConnect,
  hpClickAction,
  loadSolverMode,
  modeAfterDisconnect,
  saveSolverMode,
  solverConnectionDot,
  type SolverMode,
} from "@opencode-ai/ui/amicode-solver-toggle"
import {
  ConnectionCard,
  type ConnectionActionView,
  type ConnectionsTabLabels,
  type ConnectionView,
  type CredentialSubmitPayload,
} from "@opencode-ai/ui/amicode-connections-tab"

// AMICODE: the chrome strip's DEFAULTS CAPSULE (nav redesign, Kate 2026-07-15).
// One compact control carries both session defaults — model and solver — so the
// bar holds one row at every panel width. The face reads the current pair
// ("Auto · Piccolo"); the popover holds the full model select (the existing
// AmicodeDefaultModel, unchanged: global pin + VS Code-setting mirror) and a
// solver radio pair sharing solver-toggle.tsx's persistence. When the
// high-performance solver is on, the face wears the accent border — the PRO
// funnel stays visible at every width instead of being the first casualty
// of a narrow column.
//
// amicode#200: the solver toggle owns the Company Compute connection. The HP
// radio wears a status dot (green connected / amber attention / gray no key),
// and clicking it while unconnected expands the SAME connection card the
// status popover used to host — connect here, HP flips on when the credential
// lands connected. Connected + already-HP clicks open the card in its
// management state (identity, validated-at, revalidate, disconnect).
// Disconnect always drops the mode back to Piccolo: HP is cloud-only.

/** The Company Compute slice of createAmicodeConnectionsState, passed down by
 *  the host chrome. Optional so bare mounts (storybook) keep legacy behavior. */
export type AmicodeComputeControl = {
  view: Accessor<ConnectionView | undefined>
  labels: Accessor<ConnectionsTabLabels>
  actionError: Accessor<string | undefined>
  onSubmit: (payload: CredentialSubmitPayload) => Promise<ConnectionActionView>
  onDisconnect: (id: string) => void
  onRevalidate: (id: string) => void
  refetch: () => void
}

// The status dot lives on the connection card's STATUS line (Kate: the dot
// accompanies "not connected…", never the solver name — same idiom as the
// Connections tab, where the dot leads the card's first line). The header
// row signals state non-visually via aria-label/title and data-dot.

// amicode#200 AC6: the Connect Cloud palette command deep-links here. The
// extension posts an "open-compute-connect" envelope through the webview
// bridge; the app-shell listener calls requestComputeConnect() and the next
// mounted capsule opens straight into the connect flow. Timestamped so a
// request fired while another page was showing can't pop the popover minutes
// later (15s freshness window).
const [connectRequestAt, setConnectRequestAt] = createSignal(0)
export function requestComputeConnect() {
  setConnectRequestAt(Date.now())
}
const CONNECT_REQUEST_TTL_MS = 15_000

export function AmicodeDefaultsCapsule(props: { compute?: AmicodeComputeControl }) {
  const models = useModels()
  const [open, setOpen] = createSignal(false)
  const [mode, setMode] = createSignal<SolverMode>(loadSolverMode())
  const [computeOpen, setComputeOpen] = createSignal(false)
  const pick = (m: SolverMode) => {
    setMode(m)
    saveSolverMode(m)
  }

  const dot = createMemo(() => solverConnectionDot(props.compute?.view()))
  const onHpClick = () => {
    if (!props.compute) {
      pick("hp") // legacy seam: unwired hosts keep the old behavior
      return
    }
    if (hpClickAction(dot()) === "activate") {
      pick("hp")
      return
    }
    // not connected — reveal the connect card inline; freshen the view
    setComputeOpen(true)
    props.compute.refetch()
  }
  // details (gear): the persistent way back to the connection card once a
  // credential exists — connect success must never strand the user with no
  // visible route to identity / revalidate / disconnect (Kate, 2026-07-22)
  const onDetailsClick = () => {
    if (computeOpen()) {
      setComputeOpen(false)
      return
    }
    setComputeOpen(true)
    props.compute?.refetch()
  }
  const submitCredential = async (payload: CredentialSubmitPayload) => {
    const result = await props.compute!.onSubmit(payload)
    if (hpAfterConnect(result)) pick("hp")
    return result
  }
  const disconnectCompute = (id: string) => {
    props.compute!.onDisconnect(id)
    pick(modeAfterDisconnect())
  }

  const modelName = createMemo(() => {
    const pin = models.pin.get()
    if (!pin) return "Auto"
    const m = models.list().find((x) => x.provider.id === pin.providerID && x.id === pin.modelID)
    return m?.name ?? "Auto"
  })
  const hp = () => mode() === "hp"

  let root: HTMLDivElement | undefined
  let hpRow: HTMLDivElement | undefined
  const close = () => {
    setOpen(false)
    setComputeOpen(false)
    clearChromeDropdown("defaults")
  }
  // amicode#203: one chrome dropdown at a time (see chrome-dropdown.ts).
  createEffect(() => {
    if (chromeDropdownOpenId() !== "defaults" && open()) {
      setOpen(false)
      setComputeOpen(false)
    }
  })
  const onDocPointer = (e: PointerEvent) => {
    if (root && !root.contains(e.target as Node)) {
      close()
      return
    }
    // inside the popover but outside the HP accordion → collapse the card
    // (Kate: the disclosure dismisses like any other; the kebab reopens it)
    if (computeOpen() && hpRow && !hpRow.contains(e.target as Node)) setComputeOpen(false)
  }
  const onDocKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close()
  }
  const openPopover = () => {
    if (open()) return
    // batch: announce + open flag must land atomically (press-twice bug).
    batch(() => {
      announceChromeDropdown("defaults")
      setOpen(true)
    })
    document.addEventListener("pointerdown", onDocPointer, true)
    document.addEventListener("keydown", onDocKey, true)
  }
  const toggle = () => {
    if (open()) {
      close()
      teardown()
    } else {
      openPopover()
    }
  }

  // amicode#200 AC6: consume a pending Connect Cloud deep-link — open the
  // popover directly into the compute connect flow.
  createEffect(() => {
    const at = connectRequestAt()
    if (!at || !props.compute) return
    setConnectRequestAt(0)
    if (Date.now() - at > CONNECT_REQUEST_TTL_MS) return
    openPopover()
    setComputeOpen(true)
    props.compute.refetch()
  })
  const teardown = () => {
    document.removeEventListener("pointerdown", onDocPointer, true)
    document.removeEventListener("keydown", onDocKey, true)
  }
  onCleanup(teardown)

  const radio = (active: boolean): Record<string, string> => ({
    display: "flex",
    "align-items": "center",
    gap: "8px",
    width: "100%",
    padding: "6px 10px",
    "font-size": "12px",
    "font-weight": active ? "650" : "400",
    "text-align": "left",
    border: active ? "1px solid var(--accent-edge)" : "1px solid var(--v2-border-border-base)",
    "border-radius": "var(--radius-md)",
    cursor: "pointer",
    background: active ? "var(--accent-fill-soft)" : "transparent",
    color: active ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
  })

  return (
    <div ref={root} data-component="amicode-defaults-capsule" style={{ position: "relative", "min-width": "0" }}>
      <button
        type="button"
        data-slot="amicode-defaults-face"
        title="Defaults — model & solver, apply everywhere"
        aria-expanded={open()}
        onClick={toggle}
        style={{
          display: "inline-flex",
          "align-items": "center",
          gap: "8px",
          "max-width": "100%",
          "min-width": "0",
          border: hp()
            ? "1px solid var(--accent-edge)"
            : "1px solid var(--v2-border-border-base)",
          "border-radius": "var(--radius-md)",
          background: "var(--v2-background-bg-layer-01)",
          color: "var(--v2-text-text-base)",
          padding: "4px 10px",
          "font-size": "12px",
          "font-weight": "600",
          cursor: "pointer",
          transition: "border-color 0.15s ease",
        }}
      >
        <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap", "min-width": "0" }}>
          {modelName()} · {hp() ? "Piccolissimo+Altissimo" : "Piccolo"}
        </span>
        <span aria-hidden="true" style={{ "font-size": "10px", color: "var(--v2-text-text-muted)", "flex-shrink": "0" }}>
          ▾
        </span>
      </button>
      <Show when={open()}>
        <div
          data-slot="amicode-defaults-pop"
          role="dialog"
          aria-label="Defaults"
          style={{
            position: "absolute",
            right: "0",
            top: "calc(100% + 8px)",
            "z-index": "40",
            width: "min(300px, 86vw)",
            background: "var(--v2-background-bg-base)",
            border: "1px solid var(--v2-border-border-base)",
            "border-radius": "var(--radius-lg)",
            "box-shadow": "0 14px 40px -18px rgba(0, 0, 0, 0.55)",
            padding: "16px",
            display: "flex",
            "flex-direction": "column",
            gap: "12px",
          }}
        >
          <AmicodeDefaultModel />
          <div style={{ height: "1px", background: "var(--v2-border-border-base)" }} />
          <div style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
            <span
              style={{
                "font-size": "10px",
                "font-weight": "700",
                "letter-spacing": "0.08em",
                "text-transform": "uppercase",
                color: "var(--v2-text-text-faint)",
              }}
            >
              Solver
            </span>
            <button
              type="button"
              data-slot="amicode-solver-piccolo"
              aria-pressed={!hp()}
              style={radio(!hp())}
              onClick={() => {
                pick("piccolo")
                setComputeOpen(false)
              }}
            >
              Piccolo
            </button>
            {/* One bordered control (Kate, 2026-07-22): a single accordion —
                header row (select + kebab click zones) and the API-key card
                expand/collapse INSIDE the same border, split by a hairline. */}
            <div
              ref={hpRow}
              data-slot="amicode-solver-hp-row"
              style={{
                // accent border while ACTIVE (hp) or while the connect/manage
                // flow is open — the expanded-but-unconnected state signals
                // "the choice is moving here"; the header tint (selection
                // truth) still flips only when the credential lands (Kate,
                // 2026-07-22: don't flip Piccolo off before the switch is real)
                border:
                  hp() || computeOpen()
                    ? "1px solid var(--accent-edge)"
                    : "1px solid var(--v2-border-border-base)",
                "border-radius": "var(--radius-md)",
                overflow: "hidden",
                display: "flex",
                "flex-direction": "column",
              }}
            >
              <div
                style={{
                  display: "flex",
                  "align-items": "stretch",
                  gap: "0",
                  "font-size": "12px",
                  "font-weight": hp() ? "650" : "400",
                  background: hp() ? "var(--accent-fill-soft)" : "transparent",
                  color: hp() ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
                }}
              >
              <button
                type="button"
                data-slot="amicode-solver-hp"
                data-dot={dot()}
                aria-pressed={hp()}
                aria-expanded={computeOpen()}
                aria-controls="amicode-capsule-compute"
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "8px",
                  flex: "1 1 0",
                  "min-width": "0",
                  padding: "6px 10px",
                  border: "none",
                  background: "transparent",
                  color: "inherit",
                  font: "inherit",
                  "font-weight": "inherit",
                  "text-align": "left",
                  cursor: "pointer",
                }}
                onClick={onHpClick}
                aria-label={
                  // Name the cloud, not just "the cloud": users are picking a
                  // paid service here, and every refusal they can hit downstream
                  // (amico-run's local-launch refusal, the hpc gate) calls it
                  // Harmoniqs Cloud too — one name end to end.
                  dot() === "connected"
                    ? "Piccolissimo + Altissimo solver — connected to Harmoniqs Cloud"
                    : dot() === "attention"
                      ? "Piccolissimo + Altissimo solver — Harmoniqs Cloud key needs attention"
                      : "Piccolissimo + Altissimo solver — add your Harmoniqs Cloud API key to enable"
                }
                title={
                  dot() === "connected"
                    ? "Connected to Harmoniqs Cloud — every solve on this solver runs there"
                    : dot() === "attention"
                      ? "Harmoniqs Cloud key needs attention — click to fix"
                      : "Runs in Harmoniqs Cloud — click to add your API key"
                }
              >
                <span style={{ overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  Piccolissimo + Altissimo
                </span>
                {/* amicode pill spec (media/ui/atoms/pill.ts): round, currentColor
                    border, 10% currentColor tint — state lives in the text color. */}
                <span
                  style={{
                    "font-size": "10px",
                    "font-weight": "600",
                    "letter-spacing": "0.5px",
                    padding: "4px 8px",
                    "line-height": "1",
                    "border-radius": "var(--radius-full)",
                    border: "none",
                    background: "var(--accent)",
                    color: "var(--accent-ink)",
                    "flex-shrink": "0",
                  }}
                >
                  PRO
                </span>
                {/* Connection state, ON THE ROW. Without this the row is silent:
                    with a key already on file a click just activates HP, which is
                    correct but indistinguishable from "nothing happened" (reported
                    2026-07-28 as "it did not ask me for an API key" — it had no
                    reason to ask, and no way to say so). Text, not a bare dot:
                    Kate's idiom is that the dot accompanies words rather than the
                    solver name, and words survive colour-blindness and a
                    screenshot. It also states what a click will DO. */}
                <span
                  data-slot="amicode-solver-hp-state"
                  style={{
                    "font-size": "10px",
                    "font-weight": "600",
                    "letter-spacing": "0.3px",
                    "flex-shrink": "0",
                    color:
                      dot() === "connected"
                        ? "var(--v2-text-text-success, var(--v2-text-text-muted))"
                        : dot() === "attention"
                          ? "var(--v2-text-text-warning, var(--v2-text-text-muted))"
                          : "var(--v2-text-text-muted)",
                  }}
                >
                  {dot() === "connected" ? "CONNECTED" : dot() === "attention" ? "CHECK KEY" : "ADD KEY"}
                </span>
              </button>
              <Show when={props.compute}>
                <button
                  type="button"
                  data-slot="amicode-solver-hp-details"
                  aria-label="Harmoniqs Cloud — connection details and API key"
                  aria-expanded={computeOpen()}
                  aria-controls="amicode-capsule-compute"
                  title="Connection details"
                  onClick={onDetailsClick}
                  style={{
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    padding: "0 8px",
                    border: "none",
                    background: "transparent",
                    color: computeOpen() ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
                    cursor: "pointer",
                    "flex-shrink": "0",
                  }}
                >
                  {/* kebab — no ellipsis glyph in the sprite yet; inline vector,
                      currentColor so it themes with the row states */}
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="8" cy="3" r="1.4" />
                    <circle cx="8" cy="8" r="1.4" />
                    <circle cx="8" cy="13" r="1.4" />
                  </svg>
                </button>
              </Show>
              </div>
              <Show when={props.compute && computeOpen()}>
                {/* aria-live: the card's state copy (validating → connected /
                    error) announces to screen readers; focus lands here on open
                    so keyboard users reach the form without tabbing blind.
                    The dot on the radio is color-only — its aria-label carries
                    the state in text (WCAG color-not-only). */}
                <div
                  id="amicode-capsule-compute"
                  data-slot="amicode-capsule-compute"
                  aria-live="polite"
                  tabIndex={-1}
                  ref={(el) => setTimeout(() => el.focus(), 0)}
                  style={{
                    padding: "0 2px 4px",
                    outline: "none",
                  }}
                >
                <Show
                  when={props.compute!.view()}
                  fallback={<div class="h-8 mx-2 my-1 rounded-md bg-surface-raised-base animate-pulse" aria-hidden />}
                >
                  {(conn) => (
                    <ConnectionCard
                      conn={conn()}
                      labels={props.compute!.labels()}
                      actionError={props.compute!.actionError()}
                      onSubmit={submitCredential}
                      onDisconnect={disconnectCompute}
                      onRevalidate={props.compute!.onRevalidate}
                      hideHeader
                    />
                  )}
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}

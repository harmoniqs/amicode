import { createSignal } from "solid-js"

// AMICODE: solver mode toggle — SHOW-ONLY v1 (spec-20260709-093000). Presents
// the future High-Performance path (Piccolissimo splines + Altissimo GPU
// solver on Harmoniqs cloud) as a selectable mode so demos can tell the story
// today. It deliberately changes NOTHING about solves: the future wiring is
// the scores schema's `executor: "cloud-altissimo" | local` seam, and the
// existing `issimo` entitlement tier becomes the subscription gate.

export type SolverMode = "piccolo" | "hp"
const KEY = "amicode-solver-mode"

export function loadSolverMode(storage: Pick<Storage, "getItem"> = localStorage): SolverMode {
  try {
    return storage.getItem(KEY) === "hp" ? "hp" : "piccolo"
  } catch {
    return "piccolo"
  }
}

export function saveSolverMode(mode: SolverMode, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(KEY, mode)
  } catch {
    /* storage unavailable — selection just won't persist */
  }
}

// ── amicode#200: the solver toggle owns the Company Compute connection ──────
// Pure decision helpers — the capsule (packages/app) renders from these so the
// dot/click/flip contract stays testable without a DOM.

import type { ConnectionView } from "./connections"

/** Dot on the HP segment: connected (green) / attention (amber — anything
 *  wrong or in flight) / none (gray — no credential yet, or no data). */
export type SolverConnectionDot = "connected" | "attention" | "none"

export function solverConnectionDot(view: ConnectionView | undefined): SolverConnectionDot {
  if (!view) return "none"
  if (view.state === "connected") return "connected"
  if (view.state === "needs-key") return "none"
  return "attention"
}

/** What an HP-radio click does: activate the mode (connected), or open the
 *  connect form (anything else — AC7: never activate unconnected). Management
 *  lives behind the always-visible details affordance, not a hidden
 *  second-click on the radio (Kate's test feedback, 2026-07-22). */
export type HpClickAction = "activate" | "connect"

export function hpClickAction(dot: SolverConnectionDot): HpClickAction {
  return dot === "connected" ? "activate" : "connect"
}
/** AC2: HP flips on only when a credential submit LANDS connected. */
export function hpAfterConnect(result: { ok: boolean; connection?: { state: string } }): boolean {
  return result.ok && result.connection?.state === "connected"
}

/** Invariant: disconnecting Company Compute can never leave HP selected. */
export function modeAfterDisconnect(): SolverMode {
  return "piccolo"
}

/** opencode#78: a pick only travels to the server when it RELEASES the tier.
 *  Selecting hp is never a client request — that flip rides a validated
 *  Company Compute credential (the server's submitCredentialResponse), and a
 *  second hp writer is exactly the duplicate flip ADR 0001 forbids. Returning
 *  the mode rather than a bare boolean keeps the call site honest about WHAT
 *  it is asking the server for. */
export function releaseRequestForPick(mode: SolverMode): "piccolo" | undefined {
  return mode === "piccolo" ? "piccolo" : undefined
}

export function AmicodeSolverToggle() {
  const [mode, setMode] = createSignal<SolverMode>(loadSolverMode())
  const pick = (m: SolverMode) => {
    setMode(m)
    saveSolverMode(m)
  }
  const seg = (active: boolean): Record<string, string> => ({
    display: "inline-flex",
    "align-items": "center",
    gap: "6px",
    padding: "4px 12px",
    "font-size": "12px",
    "font-weight": active ? "650" : "400",
    border: "none",
    cursor: "pointer",
    background: active ? "var(--accent-fill-soft)" : "transparent",
    color: active ? "var(--v2-text-text-base)" : "var(--v2-text-text-muted)",
  })
  return (
    <div
      data-component="amicode-solver-toggle"
      title="Solver — High-Performance runs in the cloud with your API key"
      style={{ display: "flex", "align-items": "center", gap: "8px" }}
    >
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
      <div
        style={{
          display: "inline-flex",
          border: mode() === "hp" ? "1px solid var(--accent-edge)" : "1px solid var(--v2-border-border-base)",
          "border-radius": "var(--radius-md)",
          overflow: "hidden",
          transition: "border-color 0.15s ease",
        }}
      >
        <button
          type="button"
          data-slot="amicode-solver-piccolo"
          style={seg(mode() === "piccolo")}
          onClick={() => pick("piccolo")}
        >
          Piccolo
        </button>
        <button type="button" data-slot="amicode-solver-hp" style={seg(mode() === "hp")} onClick={() => pick("hp")}>
          <span aria-hidden="true">⚡</span>
          Piccolissimo + Altissimo
          <span
            style={{
              "font-size": "10px",
              "font-weight": "700",
              "letter-spacing": "0.06em",
              padding: "0 4px",
              "border-radius": "var(--radius-sm)",
              background: "var(--accent, #FFE614)",
              color: "var(--accent-ink, #111214)",
            }}
          >
            PRO
          </span>
        </button>
      </div>
      <span style={{ "font-size": "11px", color: "var(--v2-text-text-faint)" }}>High Performance Solver</span>
    </div>
  )
}

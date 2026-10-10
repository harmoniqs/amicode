// amicode#1549 — the composer's harness state. The engine's
// GET /amicode/harness answers {ok, harness, status, options?} where
// `options` is the extension-published registry view (harness-options.json —
// the registry lives in the extension; this side only parses it). A response
// WITHOUT a published view means "no harness control" — stock-opencode
// behavior, unchanged. Pure helpers so the view contract is testable without
// a DOM (the solver-toggle decision-helper split).
import { createSignal } from "solid-js"

export interface HarnessOptionView {
  id: string
  displayName: string
  state: "ready" | "needs-setup"
  detail: string
  disabled: boolean
  reason?: string
}

export interface HarnessViewState {
  harness: string
  status: "ready" | "switching"
  options: HarnessOptionView[]
}

/** Tolerant parse: anything off-shape, or a response with no usable registry
 *  view, parses to undefined — the caller hides the control. Option entries
 *  missing required fields are dropped, not repaired. */
export function parseHarnessState(raw: unknown): HarnessViewState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const body = raw as Record<string, unknown>
  if (body.ok !== true || typeof body.harness !== "string") return undefined
  if (!Array.isArray(body.options) || body.options.length === 0) return undefined
  const options: HarnessOptionView[] = []
  for (const entry of body.options) {
    if (typeof entry !== "object" || entry === null) continue
    const o = entry as Record<string, unknown>
    if (typeof o.id !== "string" || o.id === "") continue
    if (typeof o.displayName !== "string") continue
    if (o.state !== "ready" && o.state !== "needs-setup") continue
    if (typeof o.disabled !== "boolean") continue
    options.push({
      id: o.id,
      displayName: o.displayName,
      state: o.state,
      detail: typeof o.detail === "string" ? o.detail : "",
      disabled: o.disabled,
      ...(typeof o.reason === "string" ? { reason: o.reason } : {}),
    })
  }
  if (options.length === 0) return undefined
  return {
    harness: body.harness,
    status: body.status === "switching" ? "switching" : "ready",
    options,
  }
}

/** The degradation contract (ADR-0011 Harness Contract v1): telaio accepts no
 *  agent/model/variant on session-create or prompt, so those slots dim with
 *  an honest affordance. opencode — or no harness state at all — never
 *  degrades. */
export function harnessDegraded(state: HarnessViewState | undefined): boolean {
  return state !== undefined && state.harness !== "opencode"
}

// Module-level singleton: the composer's harness state is app-lifetime and
// one-per-server (the same shape the solver banner's module signals use). The
// control component refetches on server changes and reconnects.
const [harnessState, setHarnessState] = createSignal<HarnessViewState | undefined>(undefined)

/** Adopt a parsed GET response (or undefined to hide the control). */
export function adoptHarnessState(state: HarnessViewState | undefined): void {
  setHarnessState(state)
}

/** The live harness state — undefined before the first fetch or when no
 *  registry is published (control hidden). */
export function liveHarnessState(): HarnessViewState | undefined {
  return harnessState()
}

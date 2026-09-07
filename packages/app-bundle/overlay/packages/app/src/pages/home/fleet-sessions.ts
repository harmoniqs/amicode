// MERGED SESSIONS VIEW — view-model (amicissimo#393, Slice C of spec
// spec-20260905-193000-local-shell-data-plane rev 2, D2 + D4 + D6): the native
// session list renders the /amicode/fleet/sessions MERGED projection — both
// stores' sessions in ONE list, each row provenance-tagged with its store —
// and honors the live posture from /amicode/fleet/status. The founding pain
// (#779) is dead in the view layer too: standalone and hub sessions, one
// list, no silent split, and the interim tree-view bridge (#779/#794) is
// superseded per the sub-spec's D4.
//
// Entitlement honesty (the H3 discipline from Slice A, applied to the view
// layer): the fleet surfaces exist ONLY with the entitlement. Without it the
// staged status route answers the base no-route 404 — `exists` is false — and
// the view renders NOTHING: the base sessions list is byte-identical to base.
//
// Currency honesty (D2): the list's currency token is derived over what is
// actually FETCHED and tagged with its data sources — a token derived over
// one upstream is never compared against another. ANY posture transition
// (the Slice B refetch_epoch) triggers refetch-before-first-render: the
// rendered rows go STALE and are replaced by an honest loading state, never
// rendered stale-as-current (the #293 class, killed on this plane).
//
// Pure and solid-free so it unit-tests headless; fleet-sessions-view.tsx is
// the thin Solid consumer.

export type FleetProvenance = "local" | "hub"

export interface FleetPostureView {
  state: "fleet" | "degraded" | "standalone"
  /** The service's honest UI-consumable pointer — surfaced verbatim for the
   *  hub-down posture (the service owns its wording; the view never rewords
   *  an honesty surface). */
  pointer: string | null
  /** Monotonic; bumps on EVERY posture transition — the refetch-before-
   *  first-render key. */
  refetchEpoch: number
  /** D7's mid-session parity surfacing. */
  parityChanged: boolean
}

export interface FleetStatusView {
  /** The staged fleet surfaces exist. Without the entitlement the status
   *  route 404s (the base no-route answer) and this is false — the view
   *  does not exist and the base list renders byte-identical. */
  exists: boolean
  mode: "engine" | "fleet" | null
  posture: FleetPostureView | null
}

export interface FleetSessionRow {
  id: string | null
  title: string
  directory: string | null
  updated: number | null
  /** The store this row came from. A row the projection shipped WITHOUT a
   *  tag is never guessed — it renders untagged (or not at all), never
   *  mislabeled. */
  provenance: FleetProvenance | null
  /** The raw projection entry (the hub/local session record as served). */
  session: Record<string, unknown>
}

export interface FleetSourceView {
  present: boolean
  reason: string | null
  count: number | null
}

export interface FleetProjectionView {
  ok: boolean
  rows: FleetSessionRow[]
  sources: { local: FleetSourceView; hub: FleetSourceView }
  currency: { token: string; sources: string[] } | null
}

const POSTURE_STATES = new Set(["fleet", "degraded", "standalone"])
const PROVENANCES = new Set(["local", "hub"])

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null
}

function sourceView(raw: unknown): FleetSourceView {
  if (typeof raw !== "object" || raw === null) return { present: false, reason: null, count: null }
  const r = raw as Record<string, unknown>
  return {
    present: r["present"] === true,
    reason: str(r["reason"]),
    count: num(r["count"]),
  }
}

/** Parse the GET /amicode/fleet/status body defensively. A 404'd probe
 *  (undefined — the no-entitlement no-route answer), a non-object body, or a
 *  body without ok+mode all mean the view does not exist. Never throws. */
export function fleetStatusView(raw: unknown): FleetStatusView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { exists: false, mode: null, posture: null }
  }
  const body = raw as Record<string, unknown>
  if (body["ok"] !== true) return { exists: false, mode: null, posture: null }
  const mode = body["mode"] === "engine" || body["mode"] === "fleet" ? body["mode"] : null
  if (mode === null) return { exists: false, mode: null, posture: null }

  let posture: FleetPostureView | null = null
  const rawPosture = body["posture"]
  if (typeof rawPosture === "object" && rawPosture !== null && !Array.isArray(rawPosture)) {
    const p = rawPosture as Record<string, unknown>
    const state = str(p["state"])
    if (state !== null && POSTURE_STATES.has(state)) {
      posture = {
        state: state as FleetPostureView["state"],
        pointer: str(p["pointer"]),
        refetchEpoch: num(p["refetch_epoch"]) ?? 0,
        parityChanged:
          typeof p["parity"] === "object" &&
          p["parity"] !== null &&
          (p["parity"] as Record<string, unknown>)["changed"] === true,
      }
    }
  }
  return { exists: true, mode, posture }
}

function rowOf(entry: unknown): FleetSessionRow | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null
  const e = entry as Record<string, unknown>
  const provenanceRaw = str(e["amicode_provenance"])
  return {
    id: str(e["id"]),
    title: str(e["title"]) ?? str(e["id"]) ?? "",
    directory: str(e["directory"]),
    updated: num(e["time"] && typeof e["time"] === "object" ? (e["time"] as Record<string, unknown>)["updated"] : null),
    provenance: provenanceRaw !== null && PROVENANCES.has(provenanceRaw) ? (provenanceRaw as FleetProvenance) : null,
    session: e,
  }
}

/** Parse the GET /amicode/fleet/sessions merged projection defensively. A
 *  malformed body is ok=false with zero rows — never a partial lie. */
export function fleetProjectionView(raw: unknown): FleetProjectionView {
  const absent = { present: false, reason: null, count: null }
  const empty: FleetProjectionView = {
    ok: false,
    rows: [],
    sources: { local: absent, hub: absent },
    currency: null,
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty
  const body = raw as Record<string, unknown>
  if (body["ok"] !== true || !Array.isArray(body["sessions"])) return empty
  const rows = body["sessions"].map(rowOf).filter((r): r is FleetSessionRow => r !== null)
  const rawSources = typeof body["sources"] === "object" && body["sources"] !== null ? body["sources"] : {}
  const rawCurrency =
    typeof body["currency"] === "object" && body["currency"] !== null ? (body["currency"] as Record<string, unknown>) : {}
  const token = str(rawCurrency["token"])
  const sources = Array.isArray(rawCurrency["sources"])
    ? rawCurrency["sources"].filter((s): s is string => typeof s === "string")
    : []
  return {
    ok: true,
    rows,
    sources: {
      local: sourceView((rawSources as Record<string, unknown>)["local"]),
      hub: sourceView((rawSources as Record<string, unknown>)["hub"]),
    },
    currency: token !== null ? { token, sources } : null,
  }
}

export type FleetListState =
  /** The probe is still in flight — the base list renders untouched (it is
   *  truthful local data, and the no-entitlement boot ends exactly here). */
  | "base"
  /** The view does not exist (no entitlement): render nothing, base is
   *  byte-identical. */
  | "absent"
  /** Hub-down: the base standalone posture runs (the base list keeps
   *  working) and the service's pointer surfaces honestly. */
  | "standalone-pointer"
  /** Fleet/degraded posture but no fetched projection yet. */
  | "loading"
  /** A posture transition happened since these rows were fetched —
   *  refetch-before-first-render: the rows must NOT render stale-as-current. */
  | "stale"
  /** Merged rows render; the hub is degraded and that is surfaced. */
  | "degraded"
  /** Merged rows render, fleet healthy. */
  | "merged"

/** The honest presentation state — the single decision the view renders
 *  from. Never throws; every input combination resolves to a named state. */
export function fleetSessionsListState(input: {
  status: FleetStatusView | undefined
  projection: FleetProjectionView | undefined
  /** The refetch_epoch the rendered rows were derived over (undefined =
   *  nothing rendered yet). */
  renderedEpoch: number | undefined
}): { state: FleetListState; pointer: string | null } {
  const { status, projection, renderedEpoch } = input
  if (status === undefined) return { state: "base", pointer: null }
  if (!status.exists) return { state: "absent", pointer: null }
  const posture = status.posture
  if (posture !== null && posture.state === "standalone") {
    // hub-down: the base standalone posture is running — the base list is
    // the honest data; fleet data is surfaced as honestly unavailable.
    return { state: "standalone-pointer", pointer: posture.pointer }
  }
  // fleet or degraded posture (or a Slice A-only plane with no detector):
  if (projection === undefined || !projection.ok) return { state: "loading", pointer: null }
  if (posture !== null && renderedEpoch !== undefined && renderedEpoch !== posture.refetchEpoch) {
    return { state: "stale", pointer: null }
  }
  return { state: posture?.state === "degraded" ? "degraded" : "merged", pointer: null }
}

/** D2 currency honesty: two currency tokens may only be compared when they
 *  are derived over the SAME source set — a token derived over one upstream
 *  is never compared against another. A null currency (the projection did
 *  not carry one) never compares. */
export function currencyTokensCompatible(
  a: { token: string; sources: string[] } | null,
  b: { token: string; sources: string[] } | null,
): boolean {
  if (a === null || b === null) return false
  const sa = [...a.sources].sort().join(",")
  const sb = [...b.sources].sort().join(",")
  if (sa !== sb) return false
  return a.token === b.token
}

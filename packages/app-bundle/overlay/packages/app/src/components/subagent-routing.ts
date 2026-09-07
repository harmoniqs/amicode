// subagent-routing.ts — S3 (spec-20260907-011500 D3, amicode#860): the
// subagent model-routing settings section's VIEW-MODEL, solid-free and
// headless under vitest (the #848/#393 pattern — pure model, thin Solid
// consumer). Covers the defensive body parse off GET /amicode/model-routing
// and the provenance/drift display logic. The section is explicitly
// user-invoked (a settings tab) — the observability clause's full-visibility
// surface; the dispatch summary carries the in-line half.

/** One per-role row off the service route (snake_case on the wire). */
export interface RoutingRoleRow {
  role: string
  classes: string[]
  handSetModel: string | null
  effective: {
    outcome: "model" | "inherit"
    model: string | null
    tier: string
    reason: string
    announcement: string | null
  }
  suggestion: { model: string; cls: string | null } | null
  chain: Array<{ tier: string; model: string; state: string; reason: string }>
  drift: { drifted: boolean; tuned_model: string | null }
}

export interface RoutingBodyView {
  exists: boolean
  roles: RoutingRoleRow[]
  optIn: boolean
  providers: string[] | null
  snapshotRefreshedAt: string | null
  seats: { tuned: boolean; fleet: boolean }
}

const empty = (): RoutingBodyView => ({
  exists: false,
  roles: [],
  optIn: false,
  providers: null,
  snapshotRefreshedAt: null,
  seats: { tuned: false, fleet: false },
})

/** The defensive parse: 404 / non-object / not-ok → the view does not
 *  exist; off-shape rows are dropped, never guessed into a row. */
export function routingBodyView(raw: unknown): RoutingBodyView {
  if (typeof raw !== "object" || raw === null) return empty()
  const b = raw as Record<string, unknown>
  if (b.ok !== true || !Array.isArray(b.roles)) return empty()
  const roles: RoutingRoleRow[] = []
  for (const r of b.roles) {
    if (typeof r !== "object" || r === null) continue
    const row = r as Record<string, unknown>
    if (typeof row.role !== "string" || row.role === "") continue
    const effRaw = (typeof row.effective === "object" && row.effective !== null ? row.effective : {}) as Record<string, unknown>
    const driftRaw = (typeof row.drift === "object" && row.drift !== null ? row.drift : {}) as Record<string, unknown>
    const sugRaw = (typeof row.suggestion === "object" && row.suggestion !== null ? row.suggestion : null) as Record<string, unknown> | null
    roles.push({
      role: row.role,
      classes: Array.isArray(row.classes) ? row.classes.filter((c): c is string => typeof c === "string") : [],
      handSetModel: typeof row.hand_set_model === "string" ? row.hand_set_model : null,
      effective: {
        outcome: effRaw.outcome === "model" && typeof effRaw.model === "string" ? "model" : "inherit",
        model: typeof effRaw.model === "string" ? effRaw.model : null,
        tier: typeof effRaw.tier === "string" ? effRaw.tier : "default",
        reason: typeof effRaw.reason === "string" ? effRaw.reason : "",
        announcement: typeof effRaw.announcement === "string" ? effRaw.announcement : null,
      },
      suggestion:
        sugRaw && typeof sugRaw.model === "string"
          ? { model: sugRaw.model, cls: typeof sugRaw.cls === "string" ? sugRaw.cls : null }
          : null,
      chain: Array.isArray(row.chain)
        ? row.chain
            .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
            .map((c) => ({
              tier: typeof c.tier === "string" ? c.tier : "default",
              model: typeof c.model === "string" ? c.model : "",
              state: c.state === "accepted" ? "accepted" : "skipped",
              reason: typeof c.reason === "string" ? c.reason : "",
            }))
        : [],
      drift: {
        drifted: driftRaw.drifted === true,
        tuned_model: typeof driftRaw.tuned_model === "string" ? driftRaw.tuned_model : null,
      },
    })
  }
  const seatsRaw = (typeof b.seats === "object" && b.seats !== null ? b.seats : {}) as Record<string, unknown>
  return {
    exists: true,
    roles,
    optIn: b.opt_in === true,
    providers: Array.isArray(b.providers) ? b.providers.filter((p): p is string => typeof p === "string") : null,
    snapshotRefreshedAt: typeof b.snapshot_refreshed_at === "string" ? b.snapshot_refreshed_at : null,
    seats: { tuned: seatsRaw.tuned === true, fleet: seatsRaw.fleet === true },
  }
}

/** The provenance chip's i18n key suffix — the known classes render their
 *  own chip; anything else reads as "default" (never a wrong provenance). */
export function provenanceKey(tier: string): string {
  const known = ["user-set", "fleet-locked", "tuned", "suggested", "default"]
  return known.includes(tier) ? `settings.subagents.provenance.${tier}` : "settings.subagents.provenance.default"
}

/** The row's display tuple: what the model column shows + whether the
 *  drift/reset affordance renders. */
export function rowDisplay(row: RoutingRoleRow): {
  label: string
  provenance: string
  showDrift: boolean
  showReset: boolean
} {
  const label = row.effective.outcome === "model" && row.effective.model ? row.effective.model : ""
  return {
    label,
    provenance: provenanceKey(row.effective.tier),
    showDrift: row.drift.drifted,
    showReset: row.drift.drifted,
  }
}

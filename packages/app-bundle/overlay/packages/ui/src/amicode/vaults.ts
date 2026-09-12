// AMICODE: pure, tolerant parsing for the Vaults panel tab. The wire shape is
// `amico-vault status --json` (harmoniqs/amico PR #184), relayed verbatim by
// GET /amicode/vaults. `last_sync` is git `%cr` prose ("2 hours ago") or the
// literal string "unknown" — never a timestamp; render it, don't parse it.
// This module is the SINGLE consumer of the wire shape (spec: one schema, one
// place to update). It must never throw on malformed input.

export type VaultMountView = {
  id: string
  kind?: string
  writable?: boolean
  lastSync: string
  warnings: string[]
}

export type VaultsView = {
  ok: boolean
  mounts: VaultMountView[]
  error?: string
}

export function lastSyncDisplay(value: unknown): string {
  if (typeof value !== "string" || value === "" || value === "unknown") return "—"
  return value
}

export function parseVaultsResponse(raw: unknown): VaultsView {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { ok: false, mounts: [], error: "bad_shape: response is not an object" }
  const data = raw as Record<string, unknown>
  if (data.ok !== true) {
    const error = typeof data.error === "string" && data.error ? data.error : "amico-vault reported a failure"
    return { ok: false, mounts: [], error }
  }
  if (!Array.isArray(data.mounts)) return { ok: false, mounts: [], error: "bad_shape: mounts missing or not a list" }
  const mounts = data.mounts.map((entry): VaultMountView => {
    const mount = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>
    return {
      id: typeof mount.id === "string" && mount.id ? mount.id : "(unknown)",
      kind: typeof mount.kind === "string" ? mount.kind : undefined,
      writable: typeof mount.writable === "boolean" ? mount.writable : undefined,
      lastSync: lastSyncDisplay(mount.last_sync),
      warnings: Array.isArray(mount.warnings) ? mount.warnings.filter((w): w is string => typeof w === "string") : [],
    }
  })
  return { ok: true, mounts }
}

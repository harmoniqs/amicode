// amicode#105: pure decisions behind the vault drawer's data states. The
// drawer is the vault's ONLY host (ADR docs/adr/0001), so its failure states
// are first-class and named — pre-fix, a failed mounts fetch and an empty
// vault both rendered the same bare "empty" line (nothing fails silently).

/** Which server the drawer asks: the focused one, else the first healthy,
 *  else the first at all (a home route with several servers must still open
 *  populated). Undefined only when there is no server to ask. */
export function pickVaultServer<Conn>(input: {
  current: Conn | undefined
  list: Conn[]
  healthy: (conn: Conn) => boolean
}): Conn | undefined {
  if (input.current) return input.current
  return input.list.find(input.healthy) ?? input.list[0]
}

export type VaultMountsState<Mount> =
  | { kind: "loading" }
  /** the fetch was attempted and failed — named state with retry */
  | { kind: "error" }
  /** there is no server to ask */
  | { kind: "no-server" }
  /** the vault serves zero mounts — the attach-a-vault CTA */
  | { kind: "empty" }
  | { kind: "ready"; mounts: Mount[] }

export function vaultMountsState<Mount>(input: {
  raw: { mounts?: Mount[] } | undefined
  loading: boolean
  noServer: boolean
}): VaultMountsState<Mount> {
  if (input.loading) return { kind: "loading" }
  if (input.noServer) return { kind: "no-server" }
  if (input.raw === undefined) return { kind: "error" }
  const mounts = Array.isArray(input.raw.mounts) ? input.raw.mounts : []
  return mounts.length === 0 ? { kind: "empty" } : { kind: "ready", mounts }
}

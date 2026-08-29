// amicode#639: sessions spawned by the `amicode_session` tool stamp metadata
// {spawned_by, spawned_depth} at create time. The session route showing the
// PARENT auto-opens each spawned child as a background tab (addSessionTab —
// never navigates, never steals focus). The pure selection logic lives here
// so it is unit-testable; the effect in pages/session.tsx applies it.

export type SpawnedLike = { id: string; metadata?: { [key: string]: unknown } | null }

export function isSpawnedBy(info: SpawnedLike | undefined | null, parentSessionID: string): boolean {
  return !!info && info.metadata?.spawned_by === parentSessionID
}

// Returns the ids in `infoById` spawned by `parentSessionID` that are not in
// `alreadyOpened`, sorted for deterministic tab order. The caller owns the
// opened-set so a re-running effect never double-opens.
export function collectSpawnedChildren(
  infoById: Record<string, SpawnedLike | undefined>,
  parentSessionID: string,
  alreadyOpened: Iterable<string>,
): string[] {
  if (!parentSessionID) return []
  const opened = new Set(alreadyOpened)
  const out: string[] = []
  for (const [id, info] of Object.entries(infoById ?? {})) {
    if (opened.has(id)) continue
    if (isSpawnedBy(info, parentSessionID)) out.push(id)
  }
  return out.sort()
}

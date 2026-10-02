// #1577: Singleton portal-owner registry — enforces at most one portal source
// per session-scoped titlebar mount point. During `startTransition`, two
// SessionHeader components can be mounted simultaneously; without this, both
// render portals into the same mount-point div, doubling controls.
//
// The registry maps each mount-point ID to a reactive signal holding the
// current owner's token. When a new owner claims a mount point, the signal
// updates, and the prior owner's `<Show when={isPortalOwner(...)}>` reactively
// evaluates to false — ejecting its portal content without DOM manipulation.

import { createSignal } from "solid-js"
import type { TitlebarControlId } from "./titlebar-layout"
import { mountPointId } from "./titlebar-layout"

let _nextToken = 0

// Per-mount-point signal: holds the token of the current owner.
// Lazily created on first claim.
const _ownerSignals = new Map<string, ReturnType<typeof createSignal<number>>>()

function getOwnerSignal(key: string) {
  let entry = _ownerSignals.get(key)
  if (!entry) {
    entry = createSignal(0)
    _ownerSignals.set(key, entry)
  }
  return entry
}

/** Claim exclusive ownership of a titlebar mount point.
 *  Returns a numeric token identifying this owner. Any prior owner's
 *  `isPortalOwner` check reactively becomes false. */
export function claimPortalMount(id: TitlebarControlId): number {
  const token = ++_nextToken
  const [, setOwner] = getOwnerSignal(mountPointId(id))
  setOwner(token)
  return token
}

/** Reactive ownership check — returns true only when `token` is the
 *  current owner of the mount point. Reads the underlying signal, so
 *  it tracks in `createEffect`, `createMemo`, and `<Show>`. */
export function isPortalOwner(id: TitlebarControlId, token: number): boolean {
  const [owner] = getOwnerSignal(mountPointId(id))
  return owner() === token
}

/** Release ownership. A no-op if `token` is not the current owner
 *  (e.g. a stale component unmounting after a newer one claimed). */
export function releasePortalMount(id: TitlebarControlId, token: number): void {
  const key = mountPointId(id)
  const entry = _ownerSignals.get(key)
  if (!entry) return
  const [owner, setOwner] = entry
  if (owner() === token) {
    setOwner(0) // no owner
  }
}

/** Reset the registry — for tests only. */
export function _resetPortalRegistry(): void {
  _ownerSignals.clear()
  _nextToken = 0
}

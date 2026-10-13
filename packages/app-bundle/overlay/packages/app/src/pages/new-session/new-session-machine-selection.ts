/**
 * new-session-machine-selection.ts — #1643 (completes #1484 AC3)
 *
 * The bridge that carries the composer machine picker's CURRENT selection to
 * the submit path. The picker (new-session-machine-picker-mount.tsx) renders
 * its selection in local component state; submit.ts lives in a different tree
 * and had NO way to read it (the AC3-shipped-incomplete gap). This module is
 * that shared, module-level latch: the picker publishes on every change; submit
 * reads the latest at create time.
 *
 * Deliberately tiny and framework-free (mirrors the fleet-focus receiver
 * pattern): a single latched value, a getter, and a subscribe for the picker's
 * onCleanup. undefined = no explicit selection (→ local create).
 */

let _selected: string | undefined
const _subscribers = new Set<(machineId: string | undefined) => void>()

/** Publish the picker's current selection (called by the picker on change). */
export function publishMachineSelection(machineId: string | undefined): void {
  const next = machineId && machineId.trim() !== "" ? machineId : undefined
  _selected = next
  for (const fn of _subscribers) fn(next)
}

/** Read the latest published selection (called by submit at create time). */
export function currentMachineSelection(): string | undefined {
  return _selected
}

/** Subscribe to selection changes; returns an unsubscribe. */
export function subscribeMachineSelection(fn: (machineId: string | undefined) => void): () => void {
  _subscribers.add(fn)
  return () => _subscribers.delete(fn)
}

/** Test/reset seam. */
export function resetMachineSelection(): void {
  _selected = undefined
  _subscribers.clear()
}

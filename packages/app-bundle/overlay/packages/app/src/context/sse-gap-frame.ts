// sse-gap-frame.ts — #1617 (ADR 0033 Amendment 1): the client half of the fan-in
// backpressure fix. The origin aggregator's overflow defense-in-depth emits an
// id-less `amicode.sync.gap` SSE frame when a bounded per-namespace buffer
// overflow-dropped frames while the downstream was backpressured. The client
// intercepts that frame — exactly where it intercepts `amicode.fleet.focus`, the
// modeled precedent — and drives a FORCED bootstrap refetch that bypasses the
// #1289 reconnect-storm debounce, because a gap is a real loss the debounce must
// not swallow.
//
// This module is PURE (a predicate + a parser) so it is unit-testable in place,
// like `dispatchSseFocusEvent` and `shouldRefetchOnReconnect`. The server-sdk
// event loop calls `isSyncGapFrame` on the same `payload.type` it already reads
// for the focus frame, and on a match runs the forced-resync callback instead of
// the normal event queue.

/** The wire type of the synthetic gap frame the aggregator emits. */
export const SYNC_GAP_TYPE = "amicode.sync.gap" as const

/** The parsed gap frame: the namespaces whose buffers overflow-dropped. */
export interface SyncGapFrame {
  namespaces: string[]
}

/** True iff `type` names the synthetic gap frame. The server-sdk loop reads the
 *  frame's `type` off the same adapter/legacy split it uses for the focus frame;
 *  this is the single point of truth for the match. */
export function isSyncGapType(type: unknown): boolean {
  return type === SYNC_GAP_TYPE
}

/** Parse the gap frame's data (the `data:` JSON, or the adapter's `properties`).
 *  Returns the affected namespaces (possibly empty). A gap frame with a missing
 *  or malformed `namespaces` field still parses to an empty list — the forced
 *  refetch is unconditional once a gap frame is seen; the namespace list is
 *  diagnostic, not a gate. Returns undefined only when `data` is not an object. */
export function parseSyncGapFrame(data: unknown): SyncGapFrame | undefined {
  if (!data || typeof data !== "object") return undefined
  const ns = (data as { namespaces?: unknown }).namespaces
  if (Array.isArray(ns)) return { namespaces: ns.filter((n): n is string => typeof n === "string") }
  return { namespaces: [] }
}

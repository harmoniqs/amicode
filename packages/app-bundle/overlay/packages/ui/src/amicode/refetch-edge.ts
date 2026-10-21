// amicode: stream self-heal edge predicates — extracted from ./problem.ts when
// the deprecated research surfaces were removed (#1818). The entity rail that
// used these to refetch /amicode/problem is gone, but the transcript's own
// self-heal (pages/session/timeline/model.ts, #1646/#1617) rides the same
// edges: a silent SSE reconnect or a fan-in wedge must heal the viewed
// session, so the predicates stay live and keep their exact semantics. Pure
// so they are unit-tested in place without solid-js.

/** True iff the stream-connected signal made a genuine disconnect→connect edge
 *  (`false → true`) — the moment a view stranded by a connection blip should
 *  re-fetch. The initial connect (`undefined → true`) returns false: there is
 *  nothing to heal yet. Steady connection (`true → true`) and going down
 *  (`true → false`) never re-fetch. */
export function shouldRefetchOnReconnect(previous: boolean | undefined, next: boolean): boolean {
  return previous === false && next === true
}

/** #1617 — True iff a forced-resync token ADVANCED (`previous < next`). A
 *  WEDGE keeps the socket nominally connected — it never produces the
 *  `false → true` edge above — so the self-heal also fires on this monotonic
 *  signal, bumped when an `amicode.sync.gap` frame drives a forced bootstrap.
 *  The first observation (`undefined → n`) does NOT re-fetch (nothing to heal
 *  yet); an unchanged token does NOT re-fetch (no feedback loop). */
export function shouldRefetchOnResync(previous: number | undefined, next: number): boolean {
  return previous !== undefined && next > previous
}

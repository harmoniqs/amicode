// #1265 (Fleet thin client — Slice 5: honest degraded posture) — the
// RELAY→WRITER seam #780 left unwired. Verbatim from #780's debrief:
//
//   "The hub-up-but-slow 'degrade' write is the natural seam for the
//    service-side FleetPostureDetector (which computes latency degrade) to
//    feed the SAME writer; I left that unwired."
//
// The relay's FleetPostureDetector (amicode_service/fleet_posture.ts) computes
// fleet | degraded | standalone from the data-plane outcome stream with
// latency hysteresis — including the hub-up-but-slow DEGRADED steady state the
// extension's own up/down probe cannot see. This module maps that detector
// state onto #780's PostureFacts and drives the SAME FleetPostureStateWriter.
//
// SINGLE WRITER (AC2): #780's FleetPostureStateWriter stays the SOLE writer of
// the posture-state file. This module owns NO fs write path of its own — it is
// the WIRE (state → facts → the one writer), never a second writer. The
// writer's own signature dedupe keeps writes TRANSITION-ONLY; this module adds
// no state. The extension's attach loop uses this same helper for its own
// fleet/standalone transitions, so there is ONE fact-builder and ONE writer.
//
// Node-builtin-light and free of any amicode_service import: this is the
// extension-host peer of fleet_posture_state.ts. The relay's posture
// vocabulary is a 1:1 string match to #780's FleetPostureMode, so it is
// re-declared here as a literal union rather than imported across the seam.
import type { PostureFacts, FleetPostureMode, FleetPostureStateWriter, FleetPostureStateFile } from "./fleet_posture_state";

/** The relay detector's posture vocabulary (amicode_service/fleet_posture.ts
 *  `FleetPostureState`): fleet | degraded | standalone. Identical strings to
 *  #780's FleetPostureMode — mapped 1:1. */
export type RelayPostureState = "fleet" | "degraded" | "standalone";

export interface PostureContext {
  /** This machine's hostname (os.hostname()). */
  hostname: string;
  /** The canonical hub's identity (nulls when there is no hub). */
  hub: { name: string | null; base_url: string | null };
  /** Last measured RTT (ms) for a reachable state, if known. */
  rttMs?: number | null;
  /** ISO instant the hub was last known reachable, if known. */
  lastOk?: string | null;
  /** Injectable clock — defaults last_ok on a reachable state. */
  now?: () => string;
}

/** Reachability by posture state. fleet AND degraded are hub-UP (degraded =
 *  reachable but slow, a usable steady state); standalone is hub-DOWN. This is
 *  the load-bearing distinction: a degraded posture must NEVER render as
 *  "unreachable / fell back" (AC1). */
export function reachableForState(state: RelayPostureState): boolean {
  return state !== "standalone";
}

/** Map a relay posture state + context to #780's PostureFacts. Pure. A
 *  reachable state (fleet/degraded) carries last_ok (the provided one, else
 *  now) and the RTT; standalone carries neither (unknown from the state alone
 *  — buildPostureRecord records the absence as explicit null, never a guess). */
export function postureFactsFromState(state: RelayPostureState, ctx: PostureContext): PostureFacts {
  const reachable = reachableForState(state);
  const now = ctx.now ?? (() => new Date().toISOString());
  return {
    hostname: ctx.hostname,
    mode: state as FleetPostureMode,
    hub: { name: ctx.hub.name ?? null, base_url: ctx.hub.base_url ?? null },
    reachable,
    last_ok: reachable ? (ctx.lastOk ?? now()) : (ctx.lastOk ?? null),
    last_rtt_ms: reachable ? (ctx.rttMs ?? null) : null,
  };
}

/** Feed a relay posture state THROUGH #780's single writer. Returns the
 *  writer's result. Transition-only is the WRITER's discipline (its signature
 *  dedupe) — this function holds no state and opens no second write path. */
export function recordPostureState(
  state: RelayPostureState,
  ctx: PostureContext,
  writer: FleetPostureStateWriter,
): { wrote: boolean; record: FleetPostureStateFile | null } {
  return writer.record(postureFactsFromState(state, ctx));
}

/** Feed the relay detector's own snapshot shape (FleetPostureDetector.
 *  snapshot()) through the single writer. Shape-tolerant: an unknown/missing
 *  `state` writes NOTHING (a malformed snapshot must never persist a bogus or
 *  false-healthy posture — AC1). The RTT recorded for a reachable state is the
 *  most recent latency sample, else the context RTT. */
export function recordDetectorSnapshot(
  snapshot: { state?: unknown; latency_window?: unknown },
  ctx: PostureContext,
  writer: FleetPostureStateWriter,
): { wrote: boolean; record: FleetPostureStateFile | null } {
  const state = snapshot.state;
  if (state !== "fleet" && state !== "degraded" && state !== "standalone") {
    return { wrote: false, record: null };
  }
  const window = Array.isArray(snapshot.latency_window)
    ? (snapshot.latency_window.filter((n): n is number => typeof n === "number"))
    : [];
  const rttMs = window.length > 0 ? window[window.length - 1] : ctx.rttMs;
  return recordPostureState(state, { ...ctx, rttMs }, writer);
}

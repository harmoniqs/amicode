// MANAGED PER-PEER TRANSPORT SUPERVISOR (#1479, ADR 0034 — Fleet Studio
// completion). The legacy fleet transport is a SINGLE hub/client tunnel
// (fleet_transport.ts) and the single-attachment lifecycle (attach_lifecycle.ts)
// serves ONE active target. Neither can carry independently-healthy MacBook and
// Studio peer channels: temporary local forwards collide on the hub port, are
// not durable, and are keyed by mutable reach coordinates (alias/URL/name).
//
// This module adds a MANAGED, IDENTITY-KEYED supervisor OVER the existing
// low-level SSH-forward substrate (attachment_transport.ts's bringUpSshAttachment
// + providerForAttachment) — it introduces NO new transport provider. Each peer
// gets an independently ALLOCATED loopback endpoint (AC1), its transport is
// keyed by the stable identity_key fingerprint (#1477) NOT by any ephemeral
// URL/hostname/display name (AC2), one peer's failure/reconnect touches only
// THAT peer's named state (AC3), a target-identity mismatch SUSPENDS the
// transport and forwards no credential (AC4, the binding amendment), and
// endpoint rotation is observed dynamically and never silently restores Control
// (AC5).
//
// Invariants (ADR 0034 + #1475 scope):
//   - Every local peer endpoint binds 127.0.0.1 (loopback), like the hub tunnel.
//   - This supervisor spawns NO engine and never alters the client's never-fork
//     posture — it only stands up transport forwards (via the injected factory).
//   - Peer transport is NOT the global hub tunnel and NOT a persisted loopback
//     URL: the endpoint is resolved LIVE from the running handle, never read
//     back from disk (the binding amendment's "live supervisor resolution").
//   - Additive only: the legacy hub tunnel and single-attachment lifecycle keep
//     their compatibility responsibilities untouched (AC6).
import type {
  AttachmentTarget,
  AttachmentTransportHandle,
} from "./attachment_transport";

// ── loopback endpoint allocation (AC1 + the occupied-ports decision) ─────────

/** The default base of the per-peer loopback band — above the hub port
 *  (43117) and the usual ephemeral range floor, so a fresh peer band does not
 *  sit on the hub's own forward. */
export const DEFAULT_LOCAL_PORT_BASE = 43200;

/** How many candidate ports the allocator scans before declaring exhaustion. */
export const DEFAULT_LOCAL_PORT_RANGE = 512;

/** The remote service port peers listen on (the peer engine's loopback bind) —
 *  the SAME default the single-attachment lifecycle uses (attach_lifecycle.ts). */
export const DEFAULT_PEER_REMOTE_PORT = 43117;

/** Allocate a distinct LOCAL loopback port for one peer's forward. Pure: the
 *  caller supplies `isAvailable`, which folds together (a) the reserved ports
 *  (the hub tunnel's own port, etc.), (b) the ports already handed to OTHER
 *  live peers, and (c) a real free-port probe. Two peers targeting the same
 *  REMOTE port therefore never collide on a LOCAL one — the second sees the
 *  first's port as unavailable (AC1). Exhaustion is a NAMED not-ok, never a
 *  silent reuse. */
export function allocateLoopbackPort(opts: {
  base: number;
  range?: number;
  isAvailable: (port: number) => boolean;
}): { ok: true; port: number } | { ok: false; reason: "exhausted" } {
  const range = opts.range ?? DEFAULT_LOCAL_PORT_RANGE;
  for (let p = opts.base; p < opts.base + range; p++) {
    if (opts.isAvailable(p)) return { ok: true, port: p };
  }
  return { ok: false, reason: "exhausted" };
}

// ── endpoint identity verification (AC4 + AC5's re-verify core) ──────────────

/** The outcome of pinning an endpoint's OBSERVED identity fingerprint to the
 *  peer's EXPECTED stable identity_key. `unverified` = could-not-verify (an
 *  absent/blank observed OR expected identity) — refused, never a pass, per the
 *  binding amendment. `mismatch` = a DIFFERENT fingerprint answered — the
 *  suspend-and-forward-nothing case. */
export type EndpointIdentityCheck = { ok: true } | { ok: false; reason: "mismatch" | "unverified" };

/** Verify an observed endpoint identity against the expected stable identity_key
 *  (#1477). A missing observed OR expected value is `unverified` (never verify
 *  against nothing); a present-but-different value is a `mismatch`. */
export function verifyEndpointIdentity(expected: string, observed: string | undefined): EndpointIdentityCheck {
  const exp = (expected ?? "").trim();
  const obs = (observed ?? "").trim();
  if (exp === "" || obs === "") return { ok: false, reason: "unverified" };
  return exp === obs ? { ok: true } : { ok: false, reason: "mismatch" };
}

// re-export the substrate types this module builds ON (never forks).
export type { AttachmentTarget, AttachmentTransportHandle };

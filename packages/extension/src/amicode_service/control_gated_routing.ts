// CONTROL-GATED ROUTING (#1482, ADR 0034) — the Control-gated, peer-
// authenticated routing plane that COMPLETES the session multiplexer.
//
// This module COMPOSES:
//  - the SessionOwnerMap (per-session owner resolution from the N-peer projection)
//  - the LifecycleGrant system (Control scope verification)
//  - peer transports (late-bound URL resolution)
//
// into a single resolver whose output carries per-peer credentials (NEVER the
// hub credential) and enforces fail-closed routing:
//  - known remote owner → peer (with peer credential) OR unavailable/read-only
//  - NEVER local for a known remote owner
//
// Four target kinds:
//  - "local"       — no owner, or owner is this machine
//  - "peer"        — active Control grant + reachable transport + peer credential
//  - "unavailable" — known remote owner but grant/transport/scope prevents routing
//  - "read-only"   — revocation-pending or transport-down for a known remote owner
//
// The resolver reads grants LATE (per resolve call) so credential rotation,
// revocation, and re-admission are picked up immediately — never a boot-time
// snapshot.

import {
  SessionOwnerMap,
  extractSessionIdFromPath,
  OWNER_ROUTING_HEADER,
  type PeerTransport,
} from "./session_multiplexer";

// ── narrowed grant shape (injectable, no store dependency) ───────────────────

/** The narrowed grant view the resolver needs — injected so the resolver is
 *  unit-testable without a real on-disk grant store. */
export interface ControlGrantRead {
  scope: "observe" | "control" | "lifecycle-admin";
  state: "active" | "revocation-pending" | "revoked";
  token: string;
  machineId: string;
}

// ── target types ─────────────────────────────────────────────────────────────

/** The four-state resolution output. The caller (server.ts dispatch) pattern-
 *  matches on `kind` to decide proxy/503/passthrough. */
export type ControlGatedTarget =
  | { kind: "local" }
  | { kind: "peer"; machineId: string; url: string; peerCredential: string }
  | { kind: "unavailable"; machineId: string; reason: string }
  | { kind: "read-only"; machineId: string; reason: string };

// ── resolver options ─────────────────────────────────────────────────────────

export interface ControlGatedResolverOpts {
  ownerMap: SessionOwnerMap;
  localMachineId: string;
  /** Late-bound peer transports (URL + optional legacy token). */
  peerTransports: Record<string, PeerTransport>;
  /** Read the lifecycle grant for a peer — called PER RESOLVE so rotation is
   *  immediate. Returns undefined when no grant exists. */
  grantReader: (peerId: string) => ControlGrantRead | undefined;
  /** The hub credential token — carried here ONLY so AC1 can assert it is
   *  NEVER present in a peer resolution. Never used in outbound requests. */
  hubCredentialToken?: string;
}

// ── the resolver ─────────────────────────────────────────────────────────────

/** The Control-gated resolver: composes owner resolution + Control grant
 *  verification + peer credential resolution into a single, fail-closed
 *  routing decision. Every known remote owner either resolves to a peer with
 *  its OWN credential or returns a named unavailable/read-only state — NEVER
 *  falls through to local. */
export class ControlGatedResolver {
  private readonly opts: ControlGatedResolverOpts;

  constructor(opts: ControlGatedResolverOpts) {
    this.opts = opts;
  }

  /** Resolve one request to its Control-gated target. Pure: reads the owner
   *  map, grants, and transports via the injected functions — no direct I/O. */
  resolve(
    method: string,
    pathname: string,
    headers: Record<string, string | string[] | undefined>,
  ): ControlGatedTarget {
    // ── 0. Honesty surface: /amicode/fleet/* is ALWAYS local ──────────────
    if (pathname === "/amicode/fleet" || pathname.startsWith("/amicode/fleet/")) {
      return { kind: "local" };
    }

    // ── 1. Resolve the owner machine_id ───────────────────────────────────
    let machineId: string | undefined;

    // 1a. Path-based: extract session ID → look up owner
    const sessionId = extractSessionIdFromPath(pathname);
    if (sessionId) {
      machineId = this.opts.ownerMap.resolveOwner(sessionId);
    }

    // 1b. Header-based: X-Amicode-Owner routing header
    if (!machineId) {
      const headerVal = headers[OWNER_ROUTING_HEADER];
      if (typeof headerVal === "string" && headerVal.trim()) {
        machineId = headerVal.trim();
      }
    }

    // ── 2. No owner → local (fail-safe for keyless requests) ──────────────
    if (!machineId) return { kind: "local" };

    // ── 3. Owner is this machine → local ──────────────────────────────────
    if (machineId === this.opts.localMachineId) return { kind: "local" };

    // ── 4. Control grant verification (LATE per-resolve) ──────────────────
    //  A known remote owner WITHOUT an active Control grant is NEVER routed
    //  locally — it returns a named unavailable state. This is the AC2 gate:
    //  routing depends ONLY on the Control grant, not the attachment pointer.
    const grant = this.opts.grantReader(machineId);

    if (!grant) {
      return { kind: "unavailable", machineId, reason: "no-control-grant" };
    }

    // Fully revoked → unavailable (session no longer accessible)
    if (grant.state === "revoked") {
      return { kind: "unavailable", machineId, reason: "grant-revoked" };
    }

    // Revocation-pending → read-only (AC6: mutations suspended, session visible)
    if (grant.state === "revocation-pending") {
      return { kind: "read-only", machineId, reason: "revocation-pending" };
    }

    // Only "control" scope authorizes session routing; observe-only → unavailable
    if (grant.scope !== "control") {
      return { kind: "unavailable", machineId, reason: "insufficient-scope" };
    }

    // ── 5. Transport resolution (late-bound) ──────────────────────────────
    const peer = this.opts.peerTransports[machineId];
    const url = peer?.getUrl();

    if (!url) {
      // Transport down: AC6 — reads get read-only, writes get unavailable
      const isRead = isReadMethod(method);
      if (isRead) {
        return { kind: "read-only", machineId, reason: "transport-down" };
      }
      return { kind: "unavailable", machineId, reason: "transport-down" };
    }

    // ── 6. Fully resolved: peer target with peer-specific credential ──────
    //  AC1: the credential is the grant's own token — NEVER the hub credential.
    return {
      kind: "peer",
      machineId,
      url,
      peerCredential: grant.token,
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function isReadMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS";
}

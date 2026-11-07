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

// ── reconnect backoff (the child-exit / reconnect-backoff decision) ──────────

/** The per-peer reconnect backoff schedule: exponential from `baseMs`, capped
 *  at `capMs`. `attempt` is 1-based (the first retry after a child exit is
 *  attempt 1). Pure — the supervisor stamps `nextRetryMs` from it, and the
 *  driver (a real scheduler in production, the test directly) reads that. */
export function reconnectBackoffMs(attempt: number, opts?: { baseMs?: number; capMs?: number }): number {
  const base = opts?.baseMs ?? 500;
  const cap = opts?.capMs ?? 30_000;
  if (attempt < 1) return base;
  return Math.min(cap, base * 2 ** (attempt - 1));
}

// ── the peer identity + per-peer transport state ─────────────────────────────

/** A peer's stable identity plus its (mutable) reach coordinates. The transport
 *  is keyed by `identityKey` ALONE (AC2) — `sshAlias`/`machineId`/`transport`
 *  are reach/display attributes that may rotate without forking a transport. */
export interface PeerIdentity {
  /** The stable cryptographic fingerprint (#1477) — the transport's key. */
  identityKey: string;
  /** The roster machine_id — a reach attribute, NOT the trust key. */
  machineId: string;
  /** The ssh target / reach alias — mutable, NOT the key. */
  sshAlias: string;
  /** The transport hint (ssh | tailscale | direct). */
  transport: string;
}

/** One peer transport's named state (AC3 — each peer has its OWN). */
export type PeerTransportStatus =
  | "idle" // registered, not yet brought up
  | "connecting" // the forward is coming up
  | "healthy" // up + identity-verified + credential-forwarding allowed
  | "reconnecting" // a transient failure / child exit / endpoint rotation — backing off
  | "suspended" // target identity mismatch — credentials are NOT forwarded (AC4)
  | "failed"; // gave up (reconnect attempts exhausted, or no local port free)

/** The public snapshot of one peer's transport state. */
export interface PeerTransportState {
  identityKey: string;
  machineId: string;
  sshAlias: string;
  status: PeerTransportStatus;
  /** The distinct LOCAL loopback port allocated to this peer (AC1). */
  localPort?: number;
  /** The loopback URL callers dial to reach this peer (resolved LIVE, never
   *  persisted — the binding amendment). */
  localUrl?: string;
  /** The endpoint whose identity was last VERIFIED — rotation is a live URL
   *  that differs from this (AC5). */
  verifiedEndpoint?: string;
  /** The credential-forwarding gate: true ONLY when verified & healthy. A
   *  mismatch (AC4), a child exit (AC3), or a rotation (AC5) closes it. */
  credentialForwardingAllowed: boolean;
  /** Reconnect attempts since the last healthy state. */
  attempts: number;
  /** The backoff before the next reconnect attempt, when reconnecting. */
  nextRetryMs?: number;
  /** The last failure detail (diagnostics), when not healthy. */
  lastError?: string;
}

/** The transport bring-up seam — the real `bringUpSshAttachment` in production
 *  (SAME argv shape the single-attachment lifecycle uses), a mock in tests. It
 *  takes the caller-ALLOCATED `localPort` (AC1's distinct endpoint) — unlike
 *  the hub tunnel's same-port convention. */
export type PeerTransportFactory = (opts: {
  target: AttachmentTarget;
  remotePort: number;
  localPort: number;
}) => Promise<AttachmentTransportHandle>;

export interface PeerTransportSupervisorOpts {
  /** Bring up ONE peer's transport at an allocated local port. */
  factory: PeerTransportFactory;
  /** Probe the endpoint's OBSERVED identity fingerprint for the pin check
   *  (AC4). `undefined` = could-not-verify (refused, per the binding
   *  amendment). No default: production wiring supplies the real probe. */
  identityProbe: (peer: PeerIdentity, handle: AttachmentTransportHandle) => Promise<string | undefined>;
  /** The credential-injection seam, called ONLY on a verified endpoint —
   *  never on a mismatch/unverified one (AC4, the binding amendment). */
  forwardCredential?: (peer: PeerIdentity, handle: AttachmentTransportHandle) => void;
  /** The remote service port peers listen on (default 43117). */
  remotePort?: number;
  /** The base of the local loopback allocation band (default 43200). */
  localPortBase?: number;
  /** How many candidate ports to scan (default 512). */
  localPortRange?: number;
  /** Ports never handed to a peer — the hub tunnel's own local bind, etc.
   *  Default: the remote/hub port, so a peer never lands on the hub forward. */
  reservedPorts?: readonly number[];
  /** A real free-port probe (default: assume free — production supplies a
   *  socket probe; unit tests inject to exercise occupied-port paths). */
  isPortFree?: (port: number) => boolean;
  /** Max reconnect attempts before a peer transitions to `failed` (default 5). */
  maxReconnectAttempts?: number;
}

interface PeerEntry {
  state: PeerTransportState;
  handle?: AttachmentTransportHandle;
}

/** The managed per-peer transport supervisor. Holds N peer transports, keyed
 *  by stable identity_key (AC2), each with an independently allocated loopback
 *  endpoint (AC1) and its own named state (AC3). It stands up transports via
 *  the injected factory (the existing ssh-forward substrate) — it spawns no
 *  engine and never persists an endpoint URL. */
export class PeerTransportSupervisor {
  private readonly entries = new Map<string, PeerEntry>();
  private readonly factory: PeerTransportFactory;
  private readonly identityProbe: PeerTransportSupervisorOpts["identityProbe"];
  private readonly forwardCredential?: PeerTransportSupervisorOpts["forwardCredential"];
  private readonly remotePort: number;
  private readonly localPortBase: number;
  private readonly localPortRange: number;
  private readonly reserved: ReadonlySet<number>;
  private readonly isPortFree: (port: number) => boolean;
  private readonly maxReconnectAttempts: number;

  constructor(opts: PeerTransportSupervisorOpts) {
    this.factory = opts.factory;
    this.identityProbe = opts.identityProbe;
    if (opts.forwardCredential !== undefined) this.forwardCredential = opts.forwardCredential;
    this.remotePort = opts.remotePort ?? DEFAULT_PEER_REMOTE_PORT;
    this.localPortBase = opts.localPortBase ?? DEFAULT_LOCAL_PORT_BASE;
    this.localPortRange = opts.localPortRange ?? DEFAULT_LOCAL_PORT_RANGE;
    this.reserved = new Set(opts.reservedPorts ?? [this.remotePort]);
    this.isPortFree = opts.isPortFree ?? (() => true);
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
  }

  /** A snapshot of every managed peer transport's state (defensive copies). */
  list(): PeerTransportState[] {
    return [...this.entries.values()].map((e) => ({ ...e.state }));
  }

  /** One peer's state snapshot, or undefined when unknown. */
  get(identityKey: string): PeerTransportState | undefined {
    const e = this.entries.get(identityKey);
    return e ? { ...e.state } : undefined;
  }

  /** Whether a credential/nonce may be forwarded to this peer right now — the
   *  binding-amendment gate. False for an unknown, suspended, reconnecting, or
   *  rotated peer. */
  canForwardCredential(identityKey: string): boolean {
    return this.entries.get(identityKey)?.state.credentialForwardingAllowed ?? false;
  }

  /** Bring up (or refresh, keyed by identity) a peer transport: allocate a
   *  distinct loopback endpoint, stand up the forward, VERIFY the endpoint
   *  identity before forwarding any credential, and record the peer's state.
   *  Re-connecting the SAME identity_key replaces that transport in place
   *  (AC2) and is the explicit re-verify path after a rotation (AC5). */
  async connect(peer: PeerIdentity): Promise<PeerTransportState> {
    const key = peer.identityKey;
    // Keyed by identity: an existing live transport for this identity is torn
    // down and refreshed (never a second, forked transport for the same key).
    const prev = this.entries.get(key);
    if (prev?.handle) {
      await prev.handle.stop();
      prev.handle = undefined;
    }

    // Allocate a distinct local port and REGISTER synchronously (before the
    // first await) so a concurrent connect to another identity sees this port
    // as taken — the no-collision guarantee under concurrency (AC1).
    const handedOut = new Set<number>();
    for (const [k, e] of this.entries) {
      if (k !== key && typeof e.state.localPort === "number") handedOut.add(e.state.localPort);
    }
    const alloc = allocateLoopbackPort({
      base: this.localPortBase,
      range: this.localPortRange,
      isAvailable: (p) => !this.reserved.has(p) && !handedOut.has(p) && this.isPortFree(p),
    });

    const base: PeerTransportState = {
      identityKey: key,
      machineId: peer.machineId,
      sshAlias: peer.sshAlias,
      status: "connecting",
      credentialForwardingAllowed: false,
      attempts: 0,
    };
    if (!alloc.ok) {
      const failed: PeerTransportState = { ...base, status: "failed", lastError: "local-port-exhausted" };
      this.entries.set(key, { state: failed });
      return { ...failed };
    }
    base.localPort = alloc.port;
    this.entries.set(key, { state: base });

    // Stand up the transport at the allocated local port.
    let handle: AttachmentTransportHandle;
    try {
      handle = await this.factory({
        target: { sshAlias: peer.sshAlias, transport: peer.transport, machine_id: peer.machineId },
        remotePort: this.remotePort,
        localPort: alloc.port,
      });
    } catch (e) {
      const reconnecting: PeerTransportState = {
        ...base,
        status: "reconnecting",
        attempts: 1,
        nextRetryMs: reconnectBackoffMs(1),
        lastError: e instanceof Error ? e.message : String(e),
      };
      this.entries.set(key, { state: reconnecting });
      return { ...reconnecting };
    }

    const localUrl = handle.localUrl;
    // The identity pin (binding amendment): verify BEFORE any credential
    // crosses. A mismatch or an unverifiable endpoint SUSPENDS the transport
    // and forwards nothing (AC4).
    const observed = await this.identityProbe(peer, handle);
    const check = verifyEndpointIdentity(peer.identityKey, observed);
    if (!check.ok) {
      await handle.stop(); // an untrusted endpoint gets no traffic at all
      const suspended: PeerTransportState = {
        ...base,
        localUrl,
        status: "suspended",
        credentialForwardingAllowed: false,
        lastError: `identity-${check.reason}`,
      };
      this.entries.set(key, { state: suspended });
      return { ...suspended };
    }

    // Verified: healthy, gate open, credential forwarded exactly once.
    const healthy: PeerTransportState = {
      ...base,
      localUrl,
      status: "healthy",
      verifiedEndpoint: localUrl,
      credentialForwardingAllowed: true,
      attempts: 0,
    };
    this.entries.set(key, { state: healthy, handle });
    this.forwardCredential?.(peer, handle);
    return { ...healthy };
  }

  /** Tear down one peer's transport and forget it. Idempotent. */
  async disconnect(identityKey: string): Promise<void> {
    const e = this.entries.get(identityKey);
    if (!e) return;
    if (e.handle) await e.handle.stop();
    this.entries.delete(identityKey);
  }

  /** Record a child-exit / failure for ONE peer (AC3). Increments its attempt
   *  count and moves it to `reconnecting` (with a backoff) until the max is
   *  exceeded, then `failed`. Touches ONLY this peer — every other peer and
   *  local serving are untouched. Unknown key → undefined (no-op, no throw). */
  noteChildExit(identityKey: string, reason?: string): PeerTransportState | undefined {
    const e = this.entries.get(identityKey);
    if (!e) return undefined;
    if (e.state.status === "failed") return { ...e.state }; // terminal — do not keep counting
    // the child is gone: forget the handle and close the credential gate
    e.handle = undefined;
    const attempts = e.state.attempts + 1;
    const next: PeerTransportState = {
      ...e.state,
      attempts,
      credentialForwardingAllowed: false,
      ...(reason !== undefined ? { lastError: reason } : {}),
    };
    if (attempts > this.maxReconnectAttempts) {
      next.status = "failed";
      delete next.nextRetryMs;
    } else {
      next.status = "reconnecting";
      next.nextRetryMs = reconnectBackoffMs(attempts);
    }
    e.state = next;
    return { ...next };
  }

  /** Observe the peer's LIVE-resolved endpoint (AC5). A URL that differs from
   *  the last-verified endpoint is a ROTATION: it closes the credential gate
   *  and moves the peer to `reconnecting` — Control is NOT silently restored on
   *  the new endpoint (only an explicit re-verify via `connect` restores it).
   *  Observing the same verified endpoint is a no-op; an absent URL is a
   *  transient outage (gate closed, reconnecting). Unknown key → undefined. */
  observeEndpoint(identityKey: string, resolvedUrl: string | undefined): PeerTransportState | undefined {
    const e = this.entries.get(identityKey);
    if (!e) return undefined;
    if (resolvedUrl !== undefined && resolvedUrl === e.state.verifiedEndpoint) {
      return { ...e.state }; // no rotation — unchanged
    }
    const rotated: PeerTransportState = {
      ...e.state,
      status: "reconnecting",
      credentialForwardingAllowed: false, // never a silent restore
      lastError: resolvedUrl === undefined ? "endpoint-absent" : "endpoint-rotated",
    };
    if (resolvedUrl === undefined) delete rotated.localUrl;
    else rotated.localUrl = resolvedUrl; // observed dynamically, never persisted
    delete rotated.verifiedEndpoint; // nothing currently verified on the new endpoint
    e.state = rotated;
    e.handle = undefined; // the old handle no longer describes the live endpoint
    return { ...rotated };
  }
}

// re-export the substrate types this module builds ON (never forks).
export type { AttachmentTarget, AttachmentTransportHandle };

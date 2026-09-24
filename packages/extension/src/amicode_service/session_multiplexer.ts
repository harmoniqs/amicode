// SESSION MULTIPLEXER (#1440, ADR 0031 §D1): the per-session owner routing
// that RETIRES the single attachment pointer's one-target-for-all model.
//
// Today, ALL engine/`/amicode/*` traffic routes to ONE upstream chosen by a
// single global attachment pointer (server.ts:279-408). Opening a session on
// another machine does a FULL WINDOW RELOAD. This module inverts that model:
//
//   1. Each session carries an OWNER machine_id (from the fleet-wide
//      projection's amicode_owner tag — slice 2).
//   2. Session-pathed requests (e.g. /api/session/{id}/event) resolve the
//      owner from the path.
//   3. Path-less engine requests (file.write/file.read) carry the owner
//      machine_id as the X-Amicode-Owner routing header.
//   4. Keyless requests → local (fail-safe), NEVER to an arbitrary target.
//
// The multiplexer routes through the SAME origin (ADR 0027: single-origin) —
// it is a proxy, never a redirect. The app holds ONE base URL throughout.

import * as http from "node:http";
import type { SessionOwnerTag } from "./merged_projection";

// ── owner-routing header ─────────────────────────────────────────────────────

/** The routing header for path-less engine requests. The Work Column's bound
 *  session sets this on every request it makes. Absent → local. */
export const OWNER_ROUTING_HEADER = "x-amicode-owner";

// ── session ID extraction ────────────────────────────────────────────────────

/** Extract the session ID from an engine-format path. Recognizes:
 *    /api/session/{id}/event
 *    /api/session/{id}/message
 *    /api/session/{id}/prompt
 *    /api/session/{id}/tool
 *    /api/session/{id}/permission
 *    /api/session/{id}/<anything>
 *  Returns undefined for non-session paths. */
export function extractSessionIdFromPath(pathname: string): string | undefined {
  const m = pathname.match(/^\/api\/session\/([^/]+)\//);
  return m ? m[1] : undefined;
}

/** Extract the session ID from ANY real engine session-read path — mirroring
 *  the engine's OWN authoritative `getWorkspaceRouteSessionID`
 *  (packages/opencode/src/server/shared/workspace-routing.ts). The app emits
 *  BOTH client shapes, and — crucially — the BARE session-detail read carries
 *  NO trailing sub-segment (that is the request that renders "This session
 *  cannot be found" when it falls through to a local engine that never held the
 *  peer's session):
 *    /session/{id}                     (v1 legacy client — bare detail read)
 *    /session/{id}/message | …         (v1 messages / member calls)
 *    /api/session/{id}                 (v2 vendored client — bare detail read)
 *    /api/session/{id}/message | …     (v2 messages / member calls)
 *    /experimental/session/{id}/background
 *  `/session/status` is NOT a session id (the status poll), and a bare
 *  `/session` (the list) carries no id. Returns undefined for both.
 *
 *  DISTINCT from `extractSessionIdFromPath` above (the premium multiplexer's
 *  narrower `/api/session/{id}/<sub>`-only matcher, which misses the v1 shape
 *  AND the bare detail read) — left untouched so the armed path is unchanged. */
export function extractSessionIdFromReadPath(pathname: string): string | undefined {
  if (pathname === "/session/status") return undefined;
  const id =
    pathname.match(/^\/session\/([^/]+)(?:\/|$)/)?.[1] ??
    pathname.match(/^\/api\/session\/([^/]+)(?:\/|$)/)?.[1] ??
    pathname.match(/^\/experimental\/session\/([^/]+)\/background$/)?.[1];
  return id ?? undefined;
}

// ── session→owner map ────────────────────────────────────────────────────────

/** A session entry with owner tag (the fleet-wide projection's shape). */
export interface SessionEntry {
  id: string;
  amicode_owner?: SessionOwnerTag;
  [key: string]: unknown;
}

/** The per-session owner binding — maps session IDs to their owner machine_id.
 *  Populated from the fleet-wide projection's amicode_owner overlay (slice 2).
 *  A miss returns undefined, which the multiplexer interprets as "local". */
export class SessionOwnerMap {
  private readonly owners = new Map<string, string>();

  /** Rebuild the map from a fleet-wide projection's session list. */
  update(sessions: SessionEntry[]): void {
    this.owners.clear();
    for (const s of sessions) {
      if (typeof s.id === "string" && s.amicode_owner?.owner_machine_id) {
        this.owners.set(s.id, s.amicode_owner.owner_machine_id);
      }
    }
  }

  /** Look up the owner machine_id for a session. Undefined → local. */
  resolveOwner(sessionId: string): string | undefined {
    return this.owners.get(sessionId);
  }

  /** The DISTINCT owner machine_ids currently holding ≥1 owned session (#1511,
   *  §D1) — the fan-in membership's owner set. Order is unspecified; callers
   *  exclude `local` themselves. */
  ownerMachineIds(): string[] {
    return [...new Set(this.owners.values())];
  }

  /** The number of tracked sessions (for diagnostics). */
  get size(): number {
    return this.owners.size;
  }
}

// ── owner-map feed (#1449, W1b) ──────────────────────────────────────────────

/** The live loop that keeps a SessionOwnerMap populated (#1449, W1b, AC1).
 *
 *  The fleet-wide projection is PULL-ONLY — it is rebuilt per request at the
 *  /amicode/fleet/sessions route (index.ts), there is nothing to subscribe to.
 *  So per-session routing cannot lean on the sidebar being polled: it needs its
 *  OWN cadence. This feed rebuilds the projection on an interval and calls
 *  `ownerMap.update(projection.sessions)` — the caller (createAmicodeService)
 *  injects a `buildProjection` closure that wraps `buildFleetProjection` with the
 *  same serving-peer set the sessions route uses.
 *
 *  Honesty: a projection BUILD failure (a peer fan-out that threw) leaves the
 *  LAST-GOOD map intact — it never clears the map on error, so a transient blip
 *  does not silently reroute owned sessions to local. Only a SUCCESSFUL
 *  projection re-populates the map (clear + repopulate, the SessionOwnerMap.update
 *  contract). */
export interface OwnerMapFeedOpts {
  ownerMap: SessionOwnerMap;
  /** Build the fleet-wide projection whose `.sessions` carry the amicode_owner
   *  overlay. Injected so the feed is unit-testable without a real fan-out. */
  buildProjection: () => Promise<{ sessions: SessionEntry[] }>;
  /** The refresh cadence in ms. Default 5000. */
  intervalMs?: number;
  /** Observe a build failure (diagnostics only — the feed never throws). */
  onError?: (err: unknown) => void;
}

/** The default owner-map refresh cadence. */
export const OWNER_MAP_REFRESH_MS = 5000;

export class OwnerMapFeed {
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly opts: OwnerMapFeedOpts) {}

  /** Rebuild the projection ONCE and update the owner-map. Never throws: a
   *  build failure is reported via `onError` and the last-good map is kept. */
  async refreshOnce(): Promise<void> {
    let projection: { sessions: SessionEntry[] };
    try {
      projection = await this.opts.buildProjection();
    } catch (err) {
      this.opts.onError?.(err);
      return; // last-good map intact — never clear on a transient failure
    }
    if (this.stopped) return; // a stop() raced the in-flight build
    this.opts.ownerMap.update(projection.sessions ?? []);
  }

  /** Start the loop: fire an immediate refresh, then re-refresh on the
   *  interval. Idempotent — a second start() is a no-op. The interval is
   *  `unref`'d so it never keeps the process alive on its own. */
  start(): void {
    if (this.timer) return;
    this.stopped = false;
    void this.refreshOnce();
    this.timer = setInterval(() => void this.refreshOnce(), this.opts.intervalMs ?? OWNER_MAP_REFRESH_MS);
    this.timer.unref?.();
  }

  /** Halt the loop. Idempotent; safe to call before start(). */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// ── peer transport ───────────────────────────────────────────────────────────

/** A peer's transport coordinates — how to reach a remote machine. The URL is
 *  read LATE (per request) so a downed peer yields undefined (honest degraded),
 *  never a stale boot-time snapshot. */
export interface PeerTransport {
  getUrl(): string | undefined;
  /** Auth token for the peer (from the peer-token store, slice 1). */
  token?: string;
}

// ── observation-only read router (#1537, B2b read seam) ──────────────────────

/** A REACHABLE peer read target — proxy the read to `url` with `token`. */
export type ObservationReadPeerTarget = { kind: "peer"; machineId: string; url: string; token: string };

/** The resolution of an observation-mode read:
 *   - a REACHABLE peer target → proxy to the owner with its reader token;
 *   - the honest DEGRADED variant (owner is a KNOWN peer, but its transport is
 *     down — getUrl() undefined / no token) → the caller answers a named 503,
 *     NEVER local-dressed-as-peer (the #1382 invariant);
 *   - `undefined` (NOT a target) → LOCAL, the fail-safe: a write, a keyless /
 *     non-session path, /amicode/*, a local-owned or unowned session, or an
 *     owner that is not a known peer. The read falls through BYTE-IDENTICAL to
 *     the local engine. */
export type ObservationReadResolution = ObservationReadPeerTarget | { kind: "degraded"; machineId: string };

/** Options for the ObservationReadRouter. */
export interface ObservationReadRouterOpts {
  ownerMap: SessionOwnerMap;
  localMachineId: string;
  /** Late-bound peer transport by owner machine_id (fleet discipline: read per
   *  request). `undefined` → the owner is NOT a known/serving peer (→ local).
   *  A present transport whose `getUrl()`/`token` is absent is the honest
   *  DEGRADED case (owner known, transport momentarily down). */
  peer(machineId: string): PeerTransport | undefined;
}

/** The observation-only per-session owner router (#1537, B2b). On the
 *  OBSERVATION machine (no premium fleet plane; getMode stays "engine"), a
 *  peer-owned session's READ requests must reach the owner instead of falling
 *  through to a local engine that never held them (→ "This session cannot be
 *  found"). This resolves a GET/HEAD read to its owner peer using ONLY the
 *  path-borne session id (the empirically-verified owner signal — the app emits
 *  the id in the URL for both client shapes) resolved against the SessionOwnerMap.
 *
 *  Additive & fail-safe: anything that does not resolve to a reachable/degraded
 *  peer returns undefined and the caller falls through byte-identical to today.
 *  GET-only: writes NEVER route (remote writes are B2b, design-gated). */
export class ObservationReadRouter {
  private readonly ownerMap: SessionOwnerMap;
  private readonly localMachineId: string;
  private readonly peer: (machineId: string) => PeerTransport | undefined;

  constructor(opts: ObservationReadRouterOpts) {
    this.ownerMap = opts.ownerMap;
    this.localMachineId = opts.localMachineId;
    this.peer = opts.peer;
  }

  /** Resolve a read to its owner peer, or undefined for local (fall through).
   *
   *  Resolution order:
   *   0. NON-read (POST/PATCH/DELETE/…) → local (writes NEVER route)
   *   1. /amicode/* (the machine's own honesty + local surface) → local
   *   2. no session id extractable from the path → local
   *   3. owner unknown (unowned) → local
   *   4. owner == localMachineId (local-owned) → local
   *   5. owner is not a known peer → local
   *   6. owner is a known peer, transport down (no url/token) → DEGRADED (503)
   *   7. owner is a known reachable peer → the peer target */
  resolve(method: string, pathname: string): ObservationReadResolution | undefined {
    const m = (method || "GET").toUpperCase();
    if (m !== "GET" && m !== "HEAD") return undefined; // (0) writes never route
    // (1) never proxy the machine's OWN /amicode/* surface (honesty + local).
    //     Reads there are served by the local route table, never a peer.
    if (pathname === "/amicode" || pathname.startsWith("/amicode/")) return undefined;
    const sessionId = extractSessionIdFromReadPath(pathname); // (2)
    if (!sessionId) return undefined;
    const owner = this.ownerMap.resolveOwner(sessionId); // (3)
    if (!owner) return undefined;
    if (owner === this.localMachineId) return undefined; // (4)
    const peer = this.peer(owner); // (5)
    if (!peer) return undefined;
    const url = peer.getUrl();
    if (!url || !peer.token) return { kind: "degraded", machineId: owner }; // (6)
    return { kind: "peer", machineId: owner, url, token: peer.token }; // (7)
  }
}

// ── multiplexing proxy ───────────────────────────────────────────────────────

/** The resolved target for one request. The `resolveTarget` return is
 *  `ResolvedTarget | undefined`, with THREE distinct outcomes:
 *
 *   - REACHABLE peer — `{ machineId, url }`: proxy the request to `url`.
 *   - DEGRADED peer (#1448, W1a) — `{ machineId, unreachable: true }`: the owner
 *     is KNOWN (in the owner-map) but its transport `getUrl()` is currently
 *     undefined. This is the honest-degraded variant, DISTINCT from the
 *     `undefined` return below. W1b (#1449) turns it into a
 *     FLEET_PEER_UNREACHABLE 503 rather than silently serving local (the #1382
 *     silent-local-fallback the whole design forbids).
 *   - `undefined` (NOT a ResolvedTarget) — LOCAL, the fail-safe: keyless, the
 *     owner is local, or the owner is not in the peer set.
 *
 *  The two variants are discriminated by `unreachable`; the reachable variant
 *  carries `url`, the degraded one never does. */
export type ResolvedTarget =
  | { machineId: string; url: string; unreachable?: false }
  | { machineId: string; url?: undefined; unreachable: true };

/** #1448 (W1a): the narrow resolver seam the dispatch peer branch consults on
 *  the ATTACHED arm when AMICO_FLEET_MULTIPLEX is ON. Deliberately exposes ONLY
 *  `resolveTarget` — the per-session SSE relay is W1c and is NOT wired into
 *  dispatch here (AC4 structural guard: no SSE crosses the multiplexer). The
 *  SessionMultiplexProxy satisfies it structurally. */
export interface MultiplexResolver {
  resolveTarget(
    method: string,
    pathname: string,
    headers: Record<string, string | string[] | undefined>,
  ): ResolvedTarget | undefined;
}

/** Options for the SessionMultiplexProxy. */
export interface SessionMultiplexProxyOpts {
  ownerMap: SessionOwnerMap;
  peers: Record<string, PeerTransport>;
  localMachineId: string;
}

/** An SSE event stream handle — the test consumes events one at a time. */
export interface SseStreamHandle {
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

/** The session-aware multiplexing proxy. Routes each request to its session's
 *  owner, never to a single global target. The app holds ONE origin throughout
 *  (ADR 0027 single-origin); this proxy sits behind that origin and fans out.
 *
 *  Structural: no reloadRequired or attachSwitch signal exists — per-session
 *  routing removes the need for a global attach-swap and its window reload. */
export class SessionMultiplexProxy implements MultiplexResolver {
  private readonly ownerMap: SessionOwnerMap;
  private readonly peers: Record<string, PeerTransport>;
  private readonly localMachineId: string;

  constructor(opts: SessionMultiplexProxyOpts) {
    this.ownerMap = opts.ownerMap;
    this.peers = opts.peers;
    this.localMachineId = opts.localMachineId;
  }

  /** Resolve which peer should handle this request. Returns the peer's
   *  resolved URL + machine_id, or undefined for local (fail-safe).
   *
   *  Resolution order:
   *   0. Honesty surface (/amicode/fleet/*) → local ALWAYS (never proxied)
   *   1. Extract session ID from the path → look up owner
   *   2. Read X-Amicode-Owner header → use as owner
   *   3. No session, no header → local (undefined)
   *   4. Owner == localMachineId → local (undefined)
   *   5. Owner not in peers → local (undefined)
   *   6. Peer URL undefined → the DEGRADED variant (owner known, url undefined
   *      — #1448, W1a), NEVER undefined/local (the #1382 silent-local-fallback
   *      the design forbids; W1b turns this into a 503) */
  resolveTarget(
    _method: string,
    pathname: string,
    headers: Record<string, string | string[] | undefined>,
  ): ResolvedTarget | undefined {
    // 0. Honesty surface: /amicode/fleet/* is the machine's OWN truth — NEVER
    //    proxied to a peer, regardless of session owner or routing header.
    //    This is the multiplexer's equivalent of shouldProxyAmicodeToHost's
    //    /amicode/fleet/* exclusion (ADR 0027 §4).
    if (pathname === "/amicode/fleet" || pathname.startsWith("/amicode/fleet/")) {
      return undefined;
    }
    // 1. Path-based: extract session ID → owner
    const sessionId = extractSessionIdFromPath(pathname);
    let machineId: string | undefined;
    if (sessionId) {
      machineId = this.ownerMap.resolveOwner(sessionId);
    }
    // 2. Header-based: read X-Amicode-Owner
    if (!machineId) {
      const headerVal = headers[OWNER_ROUTING_HEADER];
      if (typeof headerVal === "string" && headerVal.trim()) {
        machineId = headerVal.trim();
      }
    }
    // 3. No owner → local
    if (!machineId) return undefined;
    // 4. Owner is local → local
    if (machineId === this.localMachineId) return undefined;
    // 5. Look up peer transport
    const peer = this.peers[machineId];
    if (!peer) return undefined;
    // 6. Resolve URL (late-bound). #1448 (W1a): owner KNOWN but URL undefined
    //    is the honest DEGRADED variant — NOT undefined/local. W1b (#1449) turns
    //    it into a 503 rather than silently serving local (the #1382 bug).
    const url = peer.getUrl();
    if (!url) return { machineId, unreachable: true };
    return { machineId, url };
  }

  /** Open an SSE event stream for a session. The multiplexer connects to the
   *  session's owner peer via http.get (not fetch — fetch may buffer SSE data
   *  in Node.js, causing missed events). Relays events with `session_id`
   *  attribution. Returns a handle the caller uses to consume events one at
   *  a time. No head-of-line blocking: each session's stream is independent. */
  openSseStream(sessionId: string): SseStreamHandle {
    const machineId = this.ownerMap.resolveOwner(sessionId);
    const peer = machineId ? this.peers[machineId] : undefined;
    const peerUrl = peer?.getUrl();

    // Pending events queue (resolved by next() callers)
    const queue: Array<{ resolve: (event: Record<string, unknown>) => void }> = [];
    const buffer: Array<Record<string, unknown>> = [];
    let closed = false;
    let req: http.ClientRequest | undefined;

    const push = (event: Record<string, unknown>) => {
      if (closed) return;
      // Tag with session_id for attribution
      const tagged = { ...event, session_id: sessionId };
      const waiter = queue.shift();
      if (waiter) {
        waiter.resolve(tagged);
      } else {
        buffer.push(tagged);
      }
    };

    // Connect to the peer's SSE stream using http.get (streaming-safe)
    if (peerUrl) {
      try {
        const target = new URL(`/api/session/${sessionId}/event`, peerUrl);
        req = http.get(target, (res) => {
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            if (closed) return;
            buf += chunk;
            // Split SSE events on double-newline
            let idx: number;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              // Parse the data: line
              const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine) {
                try {
                  const data = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
                  push(data);
                } catch { /* skip malformed */ }
              }
            }
          });
          res.on("end", () => { /* stream ended — nothing more to push */ });
          res.on("error", () => { /* stream error — nothing more to push */ });
        });
        req.on("error", () => { /* connection error — nothing to push */ });
      } catch {
        /* invalid URL — no stream */
      }
    }

    return {
      next(): Promise<Record<string, unknown>> {
        const buffered = buffer.shift();
        if (buffered) return Promise.resolve(buffered);
        if (closed) return Promise.reject(new Error("stream closed"));
        return new Promise((resolve) => { queue.push({ resolve }); });
      },
      close() {
        closed = true;
        req?.destroy();
        // Resolve any pending waiters with a closed marker
        for (const w of queue) {
          w.resolve({ _closed: true, session_id: sessionId });
        }
        queue.length = 0;
      },
    };
  }
}

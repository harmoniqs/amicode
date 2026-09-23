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

  /** The number of tracked sessions (for diagnostics). */
  get size(): number {
    return this.owners.size;
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

// ── multiplexing proxy ───────────────────────────────────────────────────────

/** The resolved target for one request: the peer's URL to proxy to, or
 *  undefined for local (fail-safe). */
export interface ResolvedTarget {
  machineId: string;
  url: string;
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
export class SessionMultiplexProxy {
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
   *   6. Peer URL undefined → undefined (honest degraded) */
  resolveTarget(
    method: string,
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
    // 6. Resolve URL (late-bound)
    const url = peer.getUrl();
    if (!url) return undefined;
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

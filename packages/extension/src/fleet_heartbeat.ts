// fleet_heartbeat.ts — periodic heartbeat producer (#1375, ADR 0026 single-writer).
//
// Each Amicode instance periodically re-POSTs its own roster row with a fresh
// `last_report` to `POST /amicode/roster`. No new routes — the path works for
// both server (local handler) and client (proxied through relay to keeper).
//
// Guards: no-op in standalone mode or without enrollment (resolveIdentity
// returns null). Error handling: swallow failures silently; next tick is the
// retry. Semantic: "this machine's Amicode instance is active".

/** Default heartbeat interval: 30 seconds. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Resolve this machine's Tailscale MagicDNS name from `tailscale status
 *  --self --json`. Returns the DNS name (without trailing dot) or undefined
 *  when tailscale CLI is unavailable or the response lacks a DNSName. Pure
 *  string transform over an injectable command runner. */
export function resolveTailscaleDnsName(
  runCommand: (cmd: string, args: string[]) => string,
): string | undefined {
  try {
    const raw = runCommand("tailscale", ["status", "--self", "--json"]);
    const self = JSON.parse(raw)?.Self;
    const dns: string | undefined = self?.DNSName;
    if (!dns || dns.trim() === "") return undefined;
    // Tailscale appends a trailing dot — strip it for URL construction.
    return dns.replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

/** DI seams for testability — every impure operation is injectable. */
export interface FleetHeartbeatDeps {
  /** Resolve this machine's identity for the roster row. Returns null when
   *  the machine is standalone or not enrolled (→ tick is a no-op). */
  resolveIdentity: () => {
    machine_id: string;
    name: string;
    server_mode: string;
    capabilities: string[];
    device_type?: string;
    sshAlias: string;
    transport: string;
    /** The URL peers should use to reach this machine's fleet service directly
     *  (e.g. MagicDNS HTTPS origin for tailscale). Absent for SSH peers. */
    peer_origin?: string;
  } | null;
  /** The fetch implementation (injectable for tests). */
  fetchImpl: typeof fetch;
  /** The local amicode service URL (e.g. "http://127.0.0.1:4095"). */
  serviceUrl: string;
  /** The Authorization header value for the local service. */
  authHeader: string;
  /** Injectable clock. */
  now: () => number;
  /** Injectable interval (ms) — defaults to HEARTBEAT_INTERVAL_MS. */
  intervalMs?: number;
  /** Injectable timer functions for testability. */
  timer?: {
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (handle: unknown) => void;
  };
  /** Peer roster sync — push this machine's row to each peer's hub service.
   *  Each peer listens on loopback, so we go through SSH. The callback
   *  receives the JSON-serialized row and pushes it to all known peers.
   *  Absent → local-only (no cross-machine sync). */
  pushToPeers?: (rowJson: string) => Promise<void>;
}

export class FleetHeartbeat {
  private deps: FleetHeartbeatDeps;
  private handle: unknown = undefined;
  private intervalMs: number;
  private timerApi: NonNullable<FleetHeartbeatDeps["timer"]>;

  constructor(deps: FleetHeartbeatDeps) {
    this.deps = deps;
    this.intervalMs = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.timerApi = deps.timer ?? {
      setInterval: (fn: () => void, ms: number) => globalThis.setInterval(fn, ms),
      clearInterval: (handle: unknown) => globalThis.clearInterval(handle as any),
    };
  }

  /** Fire tick immediately, then on interval. Idempotent. */
  start(): void {
    if (this.handle !== undefined) return;
    void this.tick();
    this.handle = this.timerApi.setInterval(() => void this.tick(), this.intervalMs);
    // Unref if the handle is a Node.js Timeout (never block exit)
    if (this.handle && typeof (this.handle as any).unref === "function") {
      (this.handle as any).unref();
    }
  }

  /** Clear the interval. Idempotent. */
  stop(): void {
    if (this.handle !== undefined) {
      this.timerApi.clearInterval(this.handle);
      this.handle = undefined;
    }
  }

  /** Alias for stop — matches VS Code Disposable convention. */
  dispose(): void {
    this.stop();
  }

  /** One heartbeat tick: resolve identity, build roster row, POST it locally
   *  AND push to peers (when wired). */
  async tick(): Promise<void> {
    try {
      const identity = this.deps.resolveIdentity();
      if (!identity) return;
      const now = this.deps.now();
      const row = {
        machine_id: identity.machine_id,
        name: identity.name,
        server_mode: identity.server_mode,
        capabilities: identity.capabilities,
        device_type: identity.device_type,
        sshAlias: identity.sshAlias,
        transport: identity.transport,
        health: "reachable" as const,
        last_report: new Date(now).toISOString(),
        ...(identity.peer_origin !== undefined ? { peer_origin: identity.peer_origin } : {}),
      };
      const rowJson = JSON.stringify(row);
      // Local POST — updates this machine's own roster.
      await this.deps.fetchImpl(`${this.deps.serviceUrl}/amicode/roster`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.deps.authHeader,
        },
        body: rowJson,
      });
      // Peer sync — push the same row to every known peer's hub service.
      // Swallowed independently: a peer being unreachable never blocks the
      // local update or other peers.
      if (this.deps.pushToPeers) {
        await this.deps.pushToPeers(rowJson).catch(() => {});
      }
    } catch {
      // Swallow silently — next tick is the retry.
    }
  }
}

// ── transport-aware peer push ───────────────────────────────────────────────

/** The minimal peer shape pushRowToPeer reads from a roster row. */
export interface PushPeerTarget {
  machine_id: string;
  sshAlias?: string;
  transport?: string;
  peer_origin?: string;
}

/** Push a serialized roster row to a single peer, dispatching on the peer's
 *  declared transport. When the peer has a `peer_origin` URL (tailscale or
 *  direct), POST via HTTPS directly; otherwise fall back to SSH + curl to
 *  the peer's loopback. Fire-and-forget: errors are swallowed silently.
 *
 *  Injectable deps for testability: `fetchImpl` for HTTPS, `execSsh` for
 *  the SSH + curl path (receives alias and the remote curl command string). */
export async function pushRowToPeer(opts: {
  rowJson: string;
  peer: PushPeerTarget;
  localPort: number;
  fetchImpl: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;
  execSsh: (alias: string, remoteCmd: string) => void;
}): Promise<void> {
  try {
    const { rowJson, peer, localPort, fetchImpl, execSsh } = opts;
    if (peer.peer_origin) {
      // HTTPS path — tailscale (MagicDNS origin) or direct (operator URL).
      await fetchImpl(`${peer.peer_origin}/amicode/roster`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rowJson,
      });
    } else {
      // SSH path — the legacy default: ssh <alias> curl ... 127.0.0.1.
      const alias = peer.sshAlias;
      if (!alias) return;
      const escaped = rowJson.replace(/'/g, "'\\''");
      const remoteCmd = `curl -sf -X POST http://127.0.0.1:${localPort}/amicode/roster -H 'Content-Type: application/json' -d '${escaped}'`;
      execSsh(alias, remoteCmd);
    }
  } catch {
    // swallow — peer sync is best-effort
  }
}

// fleet_heartbeat.ts — periodic heartbeat producer (#1375, ADR 0026 single-writer).
//
// Each Amicode instance periodically re-POSTs its own roster row with a fresh
// `last_report` to `POST /amicode/roster`. No new routes — the path works for
// both server (local handler) and client (proxied through relay to keeper).
//
// Guards: no-op in standalone mode or without enrollment (resolveIdentity
// returns null). Error handling: swallow failures silently; next tick is the
// retry. Semantic: "this machine's Amicode instance is active".

/** Default heartbeat interval: 60 seconds. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

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

  /** One heartbeat tick: resolve identity, build roster row, POST it. */
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
        health: "reachable" as const,
        last_report: new Date(now).toISOString(),
      };
      await this.deps.fetchImpl(`${this.deps.serviceUrl}/amicode/roster`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.deps.authHeader,
        },
        body: JSON.stringify(row),
      });
    } catch {
      // Swallow silently — next tick is the retry.
    }
  }
}

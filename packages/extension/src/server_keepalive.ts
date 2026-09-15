// ============================================================================
// Server keepalive — periodic ping to keep the detached server alive
// (#1147, ADR 0020).
//
// The detached server (spawned by #1146) survives the extension host's exit.
// While active, the extension pings the server's /keepalive route at a
// regular interval (well under the grace window). The server resets its
// self-shutdown timer on each ping.
//
// If the server disappears (connection refused), the keepalive detects it
// and triggers handshake cleanup so the next activation cold-spawns cleanly.
//
// Lifecycle:
//   - startKeepalive() — called after cold-spawn or adoption
//   - stopKeepalive()  — called on deactivate
//
// This module is pure infrastructure — no VS Code API dependency.
// All side effects are injected via KeepaliveDeps.
// ============================================================================

/** Default keepalive interval in milliseconds (10s — well under the 30s default grace). */
const KEEPALIVE_INTERVAL_MS = 10_000;

/** #1187: consecutive ping failures required before the server is considered
 *  gone. A single transient blip must never delete the handshake. */
const DEFAULT_FAILURE_THRESHOLD = 3;

/**
 * Injected dependencies for testability — every side effect is a seam.
 */
export interface KeepaliveDeps {
  /** POST to the server's /keepalive route. Returns true if the server is
   *  reachable (any HTTP response), false on connection refused / timeout. */
  pingServer: (port: number, password: string, graceSeconds: number) => Promise<boolean>;
  /** #1187: confirm the recorded server PID is ACTUALLY dead before treating a
   *  ping failure as server-gone. A daemonized server that is briefly
   *  unreachable is still alive — deleting its handshake would strand it and
   *  force a cold-spawn on the next reload. Injected (prod = isPidAlive). When
   *  absent, the PID guard is skipped (back-compat). */
  pidAlive?: (pid: number) => boolean;
  /** Called when the server is detected as gone (connection refused).
   *  The extension should delete the handshake file here. */
  onServerGone: () => void;
  /** Log a line to the output channel (diagnostic, not user-facing). */
  log: (line: string) => void;
}

export interface KeepaliveOptions {
  port: number;
  password: string;
  graceSeconds: number;
  /** #1187: the recorded server PID — used with deps.pidAlive to confirm the
   *  server is genuinely dead before deleting the handshake. */
  pid?: number;
  /** #1187: consecutive ping failures required before the server is considered
   *  gone. A single transient blip must never delete the handshake. Default 3. */
  failureThreshold?: number;
  deps: KeepaliveDeps;
}

// ── Module-level singleton state ─────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

/**
 * Start the keepalive ping loop. Replaces any existing keepalive.
 * Fires an immediate ping, then repeats at KEEPALIVE_INTERVAL_MS.
 */
export function startKeepalive(opts: KeepaliveOptions): void {
  // Stop any existing keepalive before starting a new one
  stopKeepalive();
  stopped = false;

  const { port, password, graceSeconds, pid, deps } = opts;
  const threshold = Math.max(1, opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD);
  let consecutiveFailures = 0;

  // #1187: a ping failure is NOT proof the server is gone. Delete the handshake
  // (via onServerGone) only after SUSTAINED failures AND a confirmation that the
  // recorded PID is actually dead. A daemonized server that is briefly
  // unreachable (busy under a long turn, momentary blip) is still alive —
  // deleting its handshake strands it, so the next reload cold-spawns onto the
  // occupied port (ServeError storm) instead of adopting it.
  const considerGone = (): void => {
    if (stopped) return;
    if (consecutiveFailures < threshold) {
      deps.log(`[keepalive] ping failed (${consecutiveFailures}/${threshold}) — not deleting handshake yet`);
      return;
    }
    if (pid !== undefined && deps.pidAlive?.(pid)) {
      deps.log(
        `[keepalive] ${consecutiveFailures} pings failed but PID ${pid} is alive — server unreachable, NOT deleting handshake`,
      );
      return;
    }
    deps.log(
      `[keepalive] server gone (port ${port}${pid !== undefined ? `, PID ${pid} not alive` : ""}) ` +
        `after ${consecutiveFailures} failed pings — cleaning up handshake`,
    );
    deps.onServerGone();
    stopKeepalive();
  };

  const ping = async (): Promise<void> => {
    if (stopped) return;
    let ok = false;
    try {
      ok = await deps.pingServer(port, password, graceSeconds);
    } catch (err) {
      // Defensive: pingServer should never throw; treat as a failure (not an
      // immediate server-gone — the same threshold + PID guard applies).
      ok = false;
      deps.log(`[keepalive] ping error: ${(err as Error).message}`);
    }
    if (stopped) return;
    if (ok) {
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    considerGone();
  };

  // Immediate first ping
  void ping();

  // Periodic pings
  timer = setInterval(() => void ping(), KEEPALIVE_INTERVAL_MS);
}

/**
 * Stop the keepalive ping loop. Safe to call when not running.
 */
export function stopKeepalive(): void {
  stopped = true;
  if (timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Minimum grace window (seconds) — lower than this risks false self-exits. */
const MIN_GRACE_SECONDS = 10;

/** Default grace window (seconds) — used when the setting is unset. */
const DEFAULT_GRACE_SECONDS = 30;

/**
 * Read the grace window from a VS Code-shaped configuration object.
 * Returns the effective grace in seconds (clamped to a minimum of 10s,
 * defaulting to 30s when unset).
 */
export function readGraceSeconds(cfg: { get<T>(key: string, defaultValue: T): T }): number {
  const raw = cfg.get<number>("server.graceSeconds", 0);
  if (!raw || !Number.isFinite(raw) || raw <= 0) return DEFAULT_GRACE_SECONDS;
  return Math.max(raw, MIN_GRACE_SECONDS);
}

// ── Production ping implementation ──────────────────────────────────────────
//
// TODO (#1147 engine-side): The engine needs a matching /keepalive route:
//   - Authenticated POST route (check the per-boot password via ServerAuth)
//   - Updates a lastPing timestamp in memory
//   - Reads graceSeconds from the request body (JSON { graceSeconds: number })
//   - A background timer checks: if now - lastPing > graceSeconds AND the
//     in-flight turn count (SessionRunState) is 0, self-exit with process.exit(0)
//     and delete the handshake file (deleteHandshake from server_handshake.ts)
//   - Unauthenticated calls get 401
//   - Until the engine route exists, the production ping will get a 404 — the
//     extension treats any HTTP response as "server alive" (it connected), so
//     the keepalive loop keeps running harmlessly. The self-shutdown timer is
//     the part that is not wired yet.
//

/**
 * POST to the server's /keepalive route with the per-boot password.
 * Returns true when the server is reachable (any HTTP response — even 404,
 * which means the route does not exist yet but the server is alive).
 * Returns false ONLY on connection refused / timeout / network error, which
 * means the server process has exited.
 *
 * This is the production implementation of KeepaliveDeps.pingServer —
 * tests inject a mock.
 */
export async function pingKeepalive(
  port: number,
  password: string,
  graceSeconds: number,
): Promise<boolean> {
  try {
    const { serverAuthHeader } = await import("./server_auth");
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 5_000);
    try {
      await fetch(`http://127.0.0.1:${port}/keepalive`, {
        method: "POST",
        signal: ctrl.signal,
        headers: {
          Authorization: serverAuthHeader(password),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ graceSeconds }),
      });
      // Any HTTP response means the server is alive — even 404 (route not
      // wired yet) or 401 (password mismatch). Only connection failures
      // indicate a dead server.
      return true;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // Connection refused, timeout, or any network error → server is gone
    return false;
  }
}

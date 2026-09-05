// AMICODE SERVICE wiring (#451, M1; #822 adds the engine upstream + the app
// shelf) — boot the extension-host amicode service at activation, alongside
// the fork opencode server (the parallel-run harness: both serve the amicode
// route surface; consumers stay on the fork until the M3 cutover, while the
// contract tests + dogfood probes hold the port to parity).
//
// vscode-free on purpose (the log sink is a structural interface, mirroring
// the service's own discipline) so the boot/lifecycle logic is unit-testable;
// the CALLER (extension.ts) resolves the engine context and the dist root —
// this module only wires what it is handed.
//
// Lifecycle notes:
//  - The service is STATELESS across requests (every route reads state at call
//    time via env overrides — same contract as the fork's routes), so unlike the
//    opencode server it needs NO restart on solver-mode switches, config
//    re-preps, or telemetry flips. One boot per activation; dispose stops it.
//  - The password is the service's OWN per-boot mint (server_auth idiom).
//    #822 SUPERSEDES the old total separation from the opencode server's
//    credential: the service now ALSO accepts the ENGINE token (on /amicode/*
//    routes and proxied paths alike) because the framed app bootstraps with
//    the engine credential and must work everywhere on this origin with zero
//    app-side change. This is an accepted-ALONGSIDE credential, not a shared
//    store: each surface still 401s everything but its own mints, and the
//    per-boot service mint (what the terminal env carries) still never
//    reaches the spawned engine's auth.
//  - The engine upstream is LATE-BOUND (a URL getter read per request): the
//    engine restarts on solver-mode switches and config re-preps while this
//    service deliberately does not, so the proxy must always resolve the
//    CURRENT engine, never a boot-time snapshot. During a restart gap the
//    getter yields undefined and the proxy answers the honest 503.
import { createAmicodeService } from "./amicode_service";
import type { AmicodeServiceServer } from "./amicode_service/server";

/** What consumers (terminal env, future iframe auth, dogfood probes) need. */
export interface AmicodeServiceHandle {
  url: string;
  authHeader: string;
}

export interface AmicodeServiceBoot extends AmicodeServiceHandle {
  service: AmicodeServiceServer;
}

/** The engine context the extension hands the service at boot (#822):
 *  the spawned opencode server's per-boot mint (the same value spawnEnv
 *  injects as OPENCODE_SERVER_PASSWORD) and its origin, read LATE (per
 *  request) because the engine restarts under the service's feet. */
export interface AmicodeServiceEngineContext {
  password: string;
  getUrl(): string | undefined;
}

export interface AmicodeServiceWiringOptions {
  /** Arm engine-token auth + the reverse proxy to the spawned engine. */
  engine?: AmicodeServiceEngineContext;
  /** The app-bundle dist root to serve statically (the shelf's needs-setup
   *  placeholder covers a missing dist honestly). Absent = no shelf (the
   *  pre-#822 boot shape, kept for parity-contract tests). */
  appDistRoot?: string;
}

/**
 * Boot the amicode service on an ephemeral loopback port. Never throws past
 * activation wiring: a boot failure is logged and returns undefined — the
 * extension must keep working with the fork server alone (parallel-run means
 * the service is additive, never load-bearing, until the M3 cutover).
 */
export async function startAmicodeService(
  log: {
    appendLine(line: string): void;
  },
  opts: AmicodeServiceWiringOptions = {},
): Promise<AmicodeServiceBoot | undefined> {
  try {
    const service = createAmicodeService({
      engine: opts.engine,
      shelf: opts.appDistRoot !== undefined ? { distRoot: opts.appDistRoot } : undefined,
    });
    const url = await service.start();
    const authNote = opts.engine !== undefined ? "per-boot Basic + engine token" : "per-boot Basic";
    const engineNote = opts.engine !== undefined ? "; engine proxy armed (late-bound upstream)" : "";
    const shelfNote = opts.appDistRoot !== undefined ? "; app shelf mounted" : "";
    log.appendLine(
      `[amicode-service] parallel-run: listening on ${url.toString()} (${service.routeCount} routes; auth: ${authNote})${engineNote}${shelfNote}`,
    );
    return { service, url: url.toString().replace(/\/$/, ""), authHeader: service.authHeader };
  } catch (err) {
    log.appendLine(`[amicode-service] boot FAILED (continuing without it): ${err}`);
    return undefined;
  }
}

/** Dispose wiring for ctx.subscriptions. */
export function amicodeServiceDisposal(boot: AmicodeServiceBoot | undefined): { dispose(): void } {
  return {
    dispose() {
      void boot?.service.stop().catch(() => undefined);
    },
  };
}

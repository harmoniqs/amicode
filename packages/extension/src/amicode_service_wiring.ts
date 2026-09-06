// AMICODE SERVICE wiring (#451, M1; #822 added the engine upstream + the app
// shelf; #823 executes the M3 cutover) — boot the extension-host amicode
// service at activation, alongside the spawned opencode engine. The service
// owns the /amicode/* route surface (stock canonical serves none), serves the
// built app dist at its origin (the shelf), and fronts the engine (the
// proxy) — every engine-origin UI consumer (chat panel iframe, deck panes,
// connections bridge) frames THIS origin at cutover (frameOriginUrl below),
// while the extension's own direct engine calls (SSE client, provider
// probes) keep their header-authenticated engine path.
//
// vscode-free on purpose (the log sink is a structural interface, mirroring
// the service's own discipline) so the boot/lifecycle logic is unit-testable;
// the CALLER (extension.ts) resolves the engine context and the dist root —
// this module only wires what it is handed.
//
// Lifecycle notes:
//  - The service is STATELESS across requests (every route reads state at call
//    time via env overrides — same contract as the fork's routes), so unlike the
//    engine it needs NO restart on solver-mode switches, config re-preps, or
//    telemetry flips. One boot per activation; dispose stops it.
//  - The password is the service's OWN per-boot mint (server_auth idiom).
//    Since #822 the service ALSO accepts the ENGINE token (on /amicode/*
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
import { fleetStagingSummary, stageFleetDataPlane } from "./amicode_service/fleet_staging";

/** What consumers (terminal env, dogfood probes, the frame picker) need. */
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
  /** #391: the fleet plane's staging input. Passing it arms NOTHING by
   *  itself — the entitlement-staged gate decides whether the fleet surfaces
   *  exist; the boot log carries the staging outcome either way. */
  fleet?: {
    entitlements?: string[] | null;
    entitlementConfigDir?: string;
    overlaySource?: string | null;
    hub: { getUrl: () => string | undefined };
    getMode?: () => "engine" | "fleet";
  };
}

/**
 * Boot the amicode service on an ephemeral loopback port. Never throws past
 * activation wiring: a boot failure is logged and returns undefined — the
 * extension then frames the engine origin directly (frameOriginUrl's
 * fallback), so the chat keeps working, degraded to the engine's own UI.
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
      fleet: opts.fleet,
    });
    const url = await service.start();
    const authNote = opts.engine !== undefined ? "per-boot Basic + engine token" : "per-boot Basic";
    const engineNote = opts.engine !== undefined ? "; engine proxy armed (late-bound upstream)" : "";
    const shelfNote = opts.appDistRoot !== undefined ? "; app shelf mounted" : "";
    // #391: the staging outcome is logged either way — an un-staged fleet
    // input is a NAMED outcome (which reason), never a silent no-op.
    const fleetNote =
      opts.fleet !== undefined
        ? `; ${fleetStagingSummary(
            stageFleetDataPlane({
              entitlements: opts.fleet.entitlements,
              entitlementConfigDir: opts.fleet.entitlementConfigDir,
              overlaySource: opts.fleet.overlaySource,
            }),
          )}`
        : "";
    log.appendLine(
      `[amicode-service] listening on ${url.toString()} (${service.routeCount} routes; auth: ${authNote})${engineNote}${shelfNote}${fleetNote}`,
    );
    return { service, url: url.toString().replace(/\/$/, ""), authHeader: service.authHeader };
  } catch (err) {
    log.appendLine(`[amicode-service] boot FAILED (framing the engine origin directly): ${err}`);
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

/**
 * #823 (the M3 cutover consumer flip): the origin every engine-origin UI
 * consumer frames — the amicode service's origin when it booted (the framed
 * app's document + assets come from the shelf; the connections bridge's
 * /amicode/* calls are native there; the engine is fronted by the proxy and
 * the framed app bootstraps with the engine's ?auth_token= carrier, which
 * the service accepts), else the engine origin (the honest degraded path
 * when the service failed to boot: the chat keeps working against the
 * engine's own UI). The service is STATELESS across engine restarts, so a
 * frame bound to it survives the engine gap — that, plus the shelf, is the
 * point of framing the service instead of the engine.
 */
export function frameOriginUrl(
  service: AmicodeServiceHandle | undefined,
  engineUrl: URL | undefined,
): URL | undefined {
  if (service !== undefined) return new URL(service.url);
  return engineUrl;
}

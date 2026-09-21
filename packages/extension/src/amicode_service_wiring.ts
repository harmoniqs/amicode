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
import { relayVersionGate, type RelayVersionGateOptions } from "./amicode_service/fleet_version_skew";
import {
  transportForSelection,
  resolveFleetTransportKind,
  hubUrlStringFromProvider,
  type FleetTransportKind,
  type FleetTransportProvider,
} from "./amicode_service/fleet_transport";
import type { FleetActivation } from "./fleet_activation";

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
   *  exist; the boot log carries the staging outcome either way. (#398
   *  extends the shape with the D6 tuning + D7 tunnel path + the transport
   *  timeouts, which the activation assembly fills in.) */
  fleet?: {
    entitlements?: string[] | null;
    entitlementConfigDir?: string;
    overlaySource?: string | null;
    hub: { getUrl: () => string | undefined };
    getMode?: () => "engine" | "fleet";
    /** #1261 (AC6): boot the fleet plane as a CLIENT relay (never-fork, no
     *  local engine) — honest hub-down, no standalone→engine flip. */
    client?: boolean;
    posture?: Partial<import("./amicode_service/fleet_posture").FleetPostureTuning>;
    tunnelConfigPath?: string;
    dataPlaneTimeoutMs?: number;
    writeTimeoutMs?: number;
    writeMaxRetries?: number;
    /** #1410 (ADR 0030 §D3): boot-time attachment recovery — the recovered
     *  transport's getUrl, threaded to createAmicodeService's fleet.attached
     *  so the D3 resolver routes to the attached device on reload. */
    attached?: { getUrl: () => string | undefined };
  };
  /** #398 (slice 4e): the fleet activation — config/env-driven (see
   *  fleet_activation.ts). A resolved snapshot OR a late-bound resolver
   *  (re-read per request by the hub getter, so a de-armed activation is
   *  the honest upstream absence, never a stale snapshot). When armed, the
   *  fleet option is assembled from it (hub getter + posture tuning + the
   *  tunnel config path + the staging inputs it carries) and handed to the
   *  entitlement-staged gate — which still decides whether fleet surfaces
   *  exist. When NOT armed (or absent), the fleet option is NEVER passed:
   *  byte-identical base (the H3 discipline extends to activation). */
  fleetActivation?: FleetActivation | (() => FleetActivation);
  /** #398: the fleet transport tuning the activation does not own — the
   *  client-enforced data-plane timeout and the write pipeline's budget.
   *  The harness tightens these for the kill/hang legs; production uses
   *  the defaults. #1260 adds `kind` — the `amicode.fleetTransport` provider
   *  selector (default `ssh`) — and `disabled`, the independently-disableable
   *  knob. An unset/`ssh` kind reproduces today's launchd-forward behavior; a
   *  disabled, unknown, or (in a build that registered a subset) unregistered
   *  provider yields the honest hub-down (no base URL bound), NEVER a silent
   *  fallback to another provider. */
  fleetTransport?: {
    dataPlaneTimeoutMs?: number;
    writeTimeoutMs?: number;
    writeMaxRetries?: number;
    /** The `amicode.fleetTransport` setting (default `ssh`). */
    kind?: string;
    /** Independently disabled providers. */
    disabled?: FleetTransportKind[];
  };
  /** Fixed port for the service. When set, the service binds to this port
   *  so the iframe origin stays stable across window reloads — preserving
   *  localStorage (settings, titlebar positions, etc.). Falls back to an
   *  ephemeral port if the fixed port is unavailable. */
  port?: number;
  /** S3 subagent model routing (#860): the settings surface's inputs. The
   *  caller (extension.ts) supplies the shipped role cards' dir + the
   *  LIVE-provider getter (the running engine's /config/providers, key-free
   *  ids only) — the credential gate's refresh loop. */
  modelRouting?: import("./amicode_service/model_routing").ModelRoutingDeps;
  /** #1261 (AC7): the version-skew relay-START gate. A client relay sets it
   *  (its pinned version + a host-version probe); the relay REFUSES to boot on
   *  a disagreement beyond tolerance (an actionable message, never a generic
   *  downstream timeout). Matching — or an unreadable host version (host down,
   *  deferred to hub-down) — boots normally. Absent = no gate (base boots). */
  versionGate?: RelayVersionGateOptions;
  /** #1410 (ADR 0030 §D3): boot-time attachment recovery. When a prior
   *  attachment pointer is found on disk at activation, the caller spins up
   *  the per-attachment transport and hands the result here. The wiring
   *  threads `getUrl` into the fleet plane's `attached` field — independent
   *  of the fleet activation state (the pointer can be valid on a machine
   *  whose activation config is not yet armed). */
  bootAttached?: { getUrl: () => string | undefined };
}

/**
 * Boot the amicode service on a loopback port. Uses the configured fixed
 * port when provided (stable origin → persistent localStorage), falling back
 * to an ephemeral port if the fixed port is busy. Never throws past
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
    // #1261 (AC7): the version-skew relay-START gate. Before wiring anything,
    // a client relay checks the host version against its pin — a disagreement
    // beyond tolerance REFUSES to boot with an actionable message (never a
    // generic downstream timeout). Unreadable / matching versions fall through.
    if (opts.versionGate !== undefined) {
      const gate = await relayVersionGate(opts.versionGate);
      if (!gate.start) {
        log.appendLine(`[amicode-service] relay-start REFUSED — version skew: ${gate.reason}`);
        return undefined;
      }
      log.appendLine(`[amicode-service] version gate: ${gate.reason}`);
    }
    // #398: resolve the activation ONCE for the boot decision (armed → the
    // fleet option is assembled; not armed → it is never passed), keeping
    // the resolver itself for the LATE-BOUND hub getter below.
    const resolveActivation = (): FleetActivation | undefined =>
      typeof opts.fleetActivation === "function" ? opts.fleetActivation() : opts.fleetActivation;
    const activation = resolveActivation();
    let fleet: AmicodeServiceWiringOptions["fleet"];
    let transportNote = "";
    if (activation !== undefined && activation.armed) {
      // #1260: the client↔host transport is a PLUGGABLE PROVIDER selected by
      // the amicode.fleetTransport setting (default `ssh`). The ssh provider
      // wraps the launchd/systemd `-L` forward — its resolveBaseUrl() is the
      // loopback hub URL, read LATE (per request) so a de-armed activation
      // yields undefined (the honest hub-down, never a stale snapshot). The hub
      // proxy consumes it through the existing getUrl seam. A disabled,
      // unknown, or unregistered provider binds NO base URL (the honest
      // hub-down), NEVER a silent fallback to another provider's URL.
      const transportSel = resolveFleetTransportKind({
        setting: opts.fleetTransport?.kind,
        ...(opts.fleetTransport?.disabled !== undefined ? { disabled: opts.fleetTransport.disabled } : {}),
      });
      const lateHubUrl = (): string | undefined => {
        const a = resolveActivation();
        return a !== undefined && a.armed ? a.hubUrl : undefined;
      };
      // #1260: each ok kind gets ITS OWN provider — ssh wraps the loopback
      // forward URL, tailscale the host's MagicDNS origin, direct the supplied
      // VPN/LAN URL — NEVER another kind's (the no-cross-provider-fallback law).
      // A not-ok selection (disabled / unknown / unregistered) binds NO URL, so
      // the hub proxy answers its honest hub-down, never a different provider's URL.
      const transport: FleetTransportProvider = transportForSelection(transportSel, lateHubUrl);
      transportNote = transportSel.ok
        ? `; transport: ${transportSel.kind}`
        : `; transport: ${opts.fleetTransport?.kind ?? "?"} unavailable — ${transportSel.reason} (honest hub-down, no fallback)`;
      fleet = {
        // staging inputs the activation carries (undefined = the machine's
        // real resolution — the production path; tests/harnesses inject)
        ...(activation.entitlements !== undefined ? { entitlements: activation.entitlements } : {}),
        ...(activation.entitlementConfigDir !== undefined
          ? { entitlementConfigDir: activation.entitlementConfigDir }
          : {}),
        ...(activation.overlaySource !== undefined ? { overlaySource: activation.overlaySource } : {}),
        // LATE-BOUND through the transport provider: re-resolve per request. A
        // de-armed activation (config cleared mid-session) is the honest
        // upstream absence — the hub proxy answers its named 503 and the
        // posture counts no-responses — never a stale boot-time snapshot.
        hub: {
          getUrl: () => hubUrlStringFromProvider(transport),
        },
        // D6 tuning: the named config keys, defaults = the fixture values.
        posture: activation.posture,
        // D7: the installed tunnel config (the stamped alias + generation)
        // — read per request by the status route and stamped on responses.
        ...(activation.tunnelConfigPath !== undefined ? { tunnelConfigPath: activation.tunnelConfigPath } : {}),
        ...(opts.fleetTransport?.dataPlaneTimeoutMs !== undefined
          ? { dataPlaneTimeoutMs: opts.fleetTransport.dataPlaneTimeoutMs }
          : {}),
        ...(opts.fleetTransport?.writeTimeoutMs !== undefined
          ? { writeTimeoutMs: opts.fleetTransport.writeTimeoutMs }
          : {}),
        ...(opts.fleetTransport?.writeMaxRetries !== undefined
          ? { writeMaxRetries: opts.fleetTransport.writeMaxRetries }
          : {}),
        // #1410 (ADR 0030 §D3): boot-time attachment recovery — thread the
        // caller's recovered transport into the fleet plane so the D3 resolver
        // routes to the attached device after a window reload. fleet.attached
        // (direct pass) wins over the top-level bootAttached (production path).
        ...((opts.fleet?.attached ?? opts.bootAttached) !== undefined
          ? { attached: opts.fleet?.attached ?? opts.bootAttached }
          : {}),
      };
    }
    const service = createAmicodeService({
      engine: opts.engine,
      shelf: opts.appDistRoot !== undefined ? { distRoot: opts.appDistRoot } : undefined,
      fleet: fleet ?? opts.fleet,
      modelRouting: opts.modelRouting,
    });
    let url: URL;
    if (opts.port && opts.port > 0) {
      try {
        url = await service.start(opts.port);
      } catch {
        // Fixed port unavailable — fall back to ephemeral so the service
        // always boots. localStorage won't persist, but the app still works.
        log.appendLine(`[amicode-service] port ${opts.port} busy, falling back to ephemeral`);
        url = await service.start();
      }
    } else {
      url = await service.start();
    }
    // #955: the auth mode is a NAMED posture in the log — "open" is the
    // fork hub's deployed tunnel/LAN boundary (anonymous by design, the SSH
    // mesh is the security boundary); the default phrasing is unchanged.
    const authNote =
      service.authMode === "open"
        ? "open-boundary (the tunnel/LAN posture)"
        : opts.engine !== undefined
          ? "per-boot Basic + engine token"
          : "per-boot Basic";
    const engineNote = opts.engine !== undefined ? "; engine proxy armed (late-bound upstream)" : "";
    const shelfNote = opts.appDistRoot !== undefined ? "; app shelf mounted" : "";
    // #398: the ACTIVATION outcome is logged either way — a not-armed
    // activation is a NAMED outcome (which reason), never a silent no-op;
    // an armed one reports the staging outcome (which may still refuse).
    const activationNote =
      opts.fleetActivation !== undefined && (activation === undefined || !activation.armed)
        ? `; fleet activation: not armed — ${activation?.reason ?? "unresolved"}`
        : "";
    // #391: the staging outcome is logged either way — an un-staged fleet
    // input is a NAMED outcome (which reason), never a silent no-op.
    const fleetInput = fleet ?? opts.fleet;
    const fleetNote =
      fleetInput !== undefined
        ? `; ${fleetStagingSummary(
            stageFleetDataPlane({
              entitlements: fleetInput.entitlements,
              entitlementConfigDir: fleetInput.entitlementConfigDir,
              overlaySource: fleetInput.overlaySource,
            }),
          )}`
        : "";
    log.appendLine(
      `[amicode-service] listening on ${url.toString()} (${service.routeCount} routes; auth: ${authNote})${engineNote}${shelfNote}${activationNote}${transportNote}${fleetNote}`,
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

/**
 * #1188: decide whether a live chat panel currently framed at `currentHref`
 * should re-frame to the service shelf. On a reload a panel can come up on the
 * ENGINE origin (stock opencode) before the amicode service is ready; once the
 * service is up, re-frame it. Comparison is by ORIGIN (path/query differences
 * don't matter). No service → false (honest degraded stays degraded); nothing
 * framed yet or a malformed href → false.
 */
export function shouldReframe(
  currentHref: string | undefined,
  serviceUrl: string | undefined,
): boolean {
  if (!serviceUrl || !currentHref) return false;
  try {
    return new URL(currentHref).origin !== new URL(serviceUrl).origin;
  } catch {
    return false;
  }
}

// AMICODE SERVICE (#451): route wiring. Each slice of the fork's
// httpapi/server.ts amicode mounts lands here as it ports; the route
// table mirrors the fork's paths and methods exactly (the app, widgets, and
// extension consumers keep hitting the same URLs they hit today — only the
// origin changes at cutover).
//
// Slice 1: GET/POST /amicode/profile (fork httpapi/server.ts @
// v1.18.10-amicode.11 — profile routes; note POST fields ride QUERY PARAMS,
// small strings, keeping handlers body-free like every other amicode route).
//
// Slice 2: the vault family — GET/POST /amicode/vaults (status relay +
// attach), GET /amicode/warrants + POST /amicode/approve (capability
// warrants: read from the ledger, mint via `amico ledger approve` — the CLI
// stays the single writer), GET /amicode/vault-files + /amicode/vault-file
// (read-only mount browser with the fail-closed loopback gate), and
// GET /amicode/resolve-file (chat file-reference resolver).
import { AmicodeServiceServer } from "./server";
import { profileResponse, saveProfile } from "./profile";
import { attachVault, status as vaultsStatus } from "./vaults";
import { approveBody, warrantsBody, type ApproveInput } from "./warrants";
import { vaultFileBody, vaultFilesBody } from "./vault_browser";
import { resolveFileBody } from "./file_resolve";
import {
  problemResponse,
  problemsResponse,
  runCardsResponse,
  runSeriesResponse,
  runStatusResponse,
} from "./problems";
import { campaignResponse, campaignsResponse } from "./campaign_ledger";
import { libraryBody, saveLibraryFile } from "./library";
import { widgetsResponse, widgetCodeResponse, forkWidgetResponse, loadRegistry } from "./widgets";
import { dashboardResponse, saveDashboardResponse } from "./dashboard";
import { widgetFrameHtml, WIDGET_CSP } from "./widget_frame_html";
import { AppShelf } from "./app_shelf";
import { EngineProxy } from "./engine_proxy";
import { HubProxy } from "./hub_proxy";
import { HubCredentialRead, mintRegistry, readHubCredential } from "./hub_credential";
import { buildMergedProjection, type UpstreamMode } from "./merged_projection";
import { FleetPostureDetector, type FleetPostureTuning } from "./fleet_posture";
import { handleFleetWrite, type FleetWriteDeps } from "./fleet_writes";
import { inspectTunnelConfigFile, TUNNEL_GENERATION_HEADER } from "./fleet_tunnel";
import { stageFleetDataPlane, type FleetStagingReceipt } from "./fleet_staging";
import { createProject, listProjects } from "./project";
import {
  addCustomConnectionResponse,
  catalogResponse,
  chooseProjectResponse,
  disconnectResponse,
  revalidateResponse,
  removeCustomConnectionResponse,
  startAuthResponse,
  statusResponse,
  submitCredentialResponse,
} from "./connections";
import { solverModeResponse } from "./solver_mode";
import { postureResponse, savePostureResponse, dismissPostureResponse } from "./posture";
import {
  modelRoutingResponse,
  saveModelRoutingResponse,
  saveRoutingOptInResponse,
  resetModelRoutingResponse,
  type ModelRoutingDeps,
} from "./model_routing";

export function registerProfileRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/profile", () => ({ body: profileResponse() }));

  server.add("POST", "/amicode/profile", ({ url }) => {
    const field = (k: string) => (url.searchParams.has(k) ? (url.searchParams.get(k) ?? "") : undefined);
    const body = saveProfile({
      name: field("name"),
      affiliation: field("affiliation"),
      focus: field("focus"),
      scholar: field("scholar"),
      affiliation_logo: field("affiliation_logo"),
    });
    return { body };
  });

  return server;
}

export function registerVaultRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/vaults", async () => ({ body: await vaultsStatus() }));

  server.add("POST", "/amicode/vaults", async ({ body }) => ({ body: await attachVault(body) }));

  server.add("GET", "/amicode/warrants", () => ({ body: warrantsBody() }));

  server.add("POST", "/amicode/approve", ({ body }) => {
    let parsed: ApproveInput = {};
    try {
      parsed = JSON.parse(body) as ApproveInput;
    } catch {
      return { body: JSON.stringify({ ok: false, error: "body must be JSON" }) };
    }
    return { body: approveBody(parsed) };
  });

  server.add("GET", "/amicode/vault-files", ({ url }) => ({
    body: vaultFilesBody(url.searchParams.get("mount") ?? undefined),
  }));

  server.add("GET", "/amicode/vault-file", ({ url }) => ({
    body: vaultFileBody(url.searchParams.get("mount") ?? undefined, url.searchParams.get("path") ?? undefined),
  }));

  server.add("GET", "/amicode/resolve-file", ({ url }) => ({
    body: resolveFileBody(url.searchParams.get("path") ?? undefined),
  }));

  return server;
}

export function registerProblemRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/problems", () => ({ body: problemsResponse() }));

  server.add("GET", "/amicode/problem", ({ url }) => ({
    body: problemResponse(url.searchParams.get("slug") ?? undefined),
  }));

  server.add("GET", "/amicode/run-status", ({ url }) => ({
    body: runStatusResponse(url.searchParams.get("slug") ?? undefined),
  }));

  server.add("GET", "/amicode/run-cards", () => ({ body: runCardsResponse() }));

  server.add("GET", "/amicode/run-series", ({ url }) => ({
    body: runSeriesResponse(url.searchParams.get("run") ?? undefined, url.searchParams.get("lab") ?? undefined),
  }));

  return server;
}

export function registerLibraryRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/library", () => ({ body: libraryBody() }));

  server.add("POST", "/amicode/library", ({ body }) => ({ body: saveLibraryFile(body) }));

  return server;
}

// Campaign routes (issue #658): read-only projections of the personal vault's
// session ledgers — the Campaign Inspector's data path. Same family pattern
// as the problem routes: one success shape per route, slug rides the query.
export function registerCampaignRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/campaigns", () => ({ body: campaignsResponse() }));

  server.add("GET", "/amicode/campaign", ({ url }) => ({
    body: campaignResponse(url.searchParams.get("slug") ?? undefined),
  }));

  return server;
}

export function registerWidgetRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/widgets", () => ({ body: widgetsResponse() }));

  // The frame document is served (not srcdoc) so it carries its OWN CSP
  // header — srcdoc would inherit the host app's CSP, which forbids the
  // inline runtime (see widget_frame_html.ts).
  server.add("GET", "/amicode/widget-frame", ({ url }) => {
    const r = widgetFrameHtml(url.searchParams.get("id") ?? undefined);
    return {
      body: r.html,
      contentType: "text/html",
      headers: { "content-security-policy": WIDGET_CSP },
    };
  });

  server.add("GET", "/amicode/widget-code", ({ url }) => ({
    body: widgetCodeResponse(url.searchParams.get("id") ?? undefined),
  }));

  server.add("POST", "/amicode/widget-fork", ({ body }) => ({ body: forkWidgetResponse(body) }));

  server.add("GET", "/amicode/dashboard", () => ({ body: dashboardResponse(loadRegistry().widgets) }));

  server.add("POST", "/amicode/dashboard", ({ body }) => ({
    body: saveDashboardResponse(body, loadRegistry().widgets),
  }));

  return server;
}

export function registerProjectRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("POST", "/amicode/project", ({ body }) => ({ body: createProject(body) }));

  server.add("GET", "/amicode/projects", () => ({ body: listProjects() }));

  return server;
}

export function registerConnectionRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/connections", () => ({ body: statusResponse() }));

  server.add("POST", "/amicode/connections/credential", async ({ body }) => ({
    body: await submitCredentialResponse(body),
  }));

  server.add("POST", "/amicode/connections/disconnect", ({ body }) => ({ body: disconnectResponse(body) }));

  server.add("POST", "/amicode/connections/revalidate", async ({ body }) => ({
    body: await revalidateResponse(body),
  }));

  server.add("POST", "/amicode/connections/choose-project", async ({ body }) => ({
    body: await chooseProjectResponse(body),
  }));

  server.add("POST", "/amicode/connections/auth", async ({ body }) => ({
    body: await startAuthResponse(body),
  }));

  server.add("GET", "/amicode/connections/catalog", () => ({ body: catalogResponse() }));

  server.add("POST", "/amicode/connections/add-custom", async ({ body }) => ({
    body: await addCustomConnectionResponse(body),
  }));

  server.add("POST", "/amicode/connections/remove", ({ body }) => ({
    body: removeCustomConnectionResponse(body),
  }));

  return server;
}

// Solver-mode route (#798): the release half of the toggle contract — the
// fork's POST /amicode/solver-mode, mounted in the connections family's
// neighborhood exactly as the fork's server.ts does (the app's status popover
// fires it fire-and-forget beside the connection actions). Its own family
// because its response shape is the sibling {ok, mode, error}, not a
// connection card.
export function registerSolverModeRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("POST", "/amicode/solver-mode", ({ body }) => ({ body: solverModeResponse(body) }));

  return server;
}

// Posture routes (S2, spec-20260907-011500 D2, #859): the plan-exit posture
// surface. GET /amicode/posture — the latest compiled plan's STAMPED
// posture_recommendation (a dumb reader: the indicator reads data, never
// re-derives) + the plan.auto_switch pref + the dismissal state.
// POST /amicode/posture — the pref write {auto_switch: confirm|auto}.
// POST /amicode/posture/dismiss — record the per-plan dismissal. Own family
// because the shape is the posture tuple, not a connection card.
export function registerPostureRoutes(server: AmicodeServiceServer): AmicodeServiceServer {
  server.add("GET", "/amicode/posture", () => ({ body: postureResponse() }));

  server.add("POST", "/amicode/posture", ({ body }) => ({ body: savePostureResponse(body) }));

  server.add("POST", "/amicode/posture/dismiss", ({ body }) => ({ body: dismissPostureResponse(body) }));

  return server;
}

// Model-routing routes (S3, spec-20260907-011500 D3, #860): the subagent
// model-routing settings surface. GET — per-role rows with provenance per
// row (user-set / fleet-locked / tuned / suggested / default), the
// display-only suggestions (credential-filtered against the LIVE providers),
// and the drift seat. POST — the user-set write; POST /opt-in — the
// zero-config fold's flag; POST /reset — clear the user-set row. The GET
// doubles as the credential snapshot's refresh loop (the dispatch seam
// re-checks it per dispatch). Own family because the shape is the role-row
// tuple, not a connection card or the posture tuple.
export function registerModelRoutingRoutes(
  server: AmicodeServiceServer,
  deps: ModelRoutingDeps = {},
): AmicodeServiceServer {
  server.add("GET", "/amicode/model-routing", async () => ({ body: await modelRoutingResponse(deps) }));

  server.add("POST", "/amicode/model-routing", async ({ body }) => ({
    body: await saveModelRoutingResponse(body, deps),
  }));

  server.add("POST", "/amicode/model-routing/opt-in", async ({ body }) => ({
    body: await saveRoutingOptInResponse(body, deps),
  }));

  server.add("POST", "/amicode/model-routing/reset", async ({ body }) => ({
    body: await resetModelRoutingResponse(body, deps),
  }));

  return server;
}

// ── #391: the fleet routes — STAGED SURFACES ────────────────────────────────
// Registered ONLY by the entitlement-staged path below (createAmicodeService's
// fleet option → stageFleetDataPlane). A boot without a staged fleet plane
// never mounts these: /amicode/fleet/* answers the base no-route 404, which
// is exactly the H3 byte-identity assertion. The routes are new fleet-class
// surfaces (ADR-0004 d.3's "data-plane routing" class) declared by the
// overlay manifest the staging gate validated.

export interface FleetRouteDeps {
  /** The late-bound routing mode (data-driven per request). */
  getMode(): UpstreamMode;
  /** The hub credential's NAMED read — per request, so a mid-session
   *  write/clear of the credential store is honored without a reboot. */
  readCredential(): HubCredentialRead;
  /** The engine side of the merged projection (the local engine remains a
   *  data source in fleet mode — the founding pain stays dead). */
  engine: { getUrl(): string | undefined; password?: string };
  /** The hub upstream for the proxy. */
  hub: { getUrl(): string | undefined };
  /** The staging receipt — provenance surfacing, never merged fields. */
  receipt: FleetStagingReceipt;
  /** Whether the engine mint is armed (for the mint registry). */
  engineArmed: boolean;
  /** #392 (D6): the posture detector — the status route reads its live
   *  snapshot (mid-session parity: posture changes are visible through the
   *  SAME contract, not just at boot) and the merged projection feeds it
   *  the hub side's outcomes + parity stamp. */
  monitor?: FleetPostureDetector;
  /** #392 (D7): the installed tunnel config's path — read per request so
   *  a rejoin is visible mid-session. */
  tunnelConfigPath?: string;
}

/** GET /amicode/fleet/status — the plane's honesty surface: the current
 *  routing mode, the D6 posture (a steady state with its named entry
 *  condition — mid-session live, never boot-frozen), the D7 tunnel stamp,
 *  the three named mints (D5), the hub credential's NAMED outcome, and the
 *  staging receipt. GET /amicode/fleet/sessions — the MERGED projection
 *  (D2): both stores, provenance-tagged, currency derived over what is
 *  actually fetched. */
export function registerFleetRoutes(server: AmicodeServiceServer, deps: FleetRouteDeps): AmicodeServiceServer {
  server.add("GET", "/amicode/fleet/status", () => {
    const mode = deps.getMode();
    const hubCredential = deps.readCredential();
    return {
      body: JSON.stringify({
        ok: true,
        mode,
        ...(deps.monitor ? { posture: deps.monitor.snapshot() } : {}),
        ...(deps.tunnelConfigPath !== undefined ? { tunnel: inspectTunnelConfigFile(deps.tunnelConfigPath) } : {}),
        mints: mintRegistry({ mode, engineArmed: deps.engineArmed, hubCredential }),
        hub_credential: hubCredential,
        staging: deps.receipt,
      }),
    };
  });

  server.add("GET", "/amicode/fleet/sessions", async () => {
    const started = Date.now();
    const projection = await buildMergedProjection({
      local: { getUrl: deps.engine.getUrl, password: deps.engine.password },
      hub: { getUrl: deps.hub.getUrl, credential: deps.readCredential() },
    });
    if (deps.monitor) {
      // the projection IS a data-plane request: its hub side feeds the
      // posture detector's outcome stream (transport-level absences only —
      // a missing credential or a 401 is D5's honesty surface, not D6's
      // degradation) and re-asserts D7's hub build parity.
      const hubRecord = projection.sources.hub;
      if (hubRecord.present) {
        deps.monitor.record({ kind: "responded", latencyMs: Date.now() - started });
        deps.monitor.noteHubVersion(hubRecord.version ?? null);
      } else if (hubRecord.reason === "no-upstream" || hubRecord.reason === "fetch-failed") {
        deps.monitor.record({ kind: "no-response", detail: hubRecord.reason });
      }
    }
    return { body: JSON.stringify(projection) };
  });

  return server;
}

/** The service with every ported slice mounted. The extension wiring slice
 *  boots this at activation; the contract tests boot it in-process.
 *
 *  #822 additions, both optional so the parity-contract boots stay
 *  byte-identical: `shelf` mounts the app-bundle static server (the built
 *  dist this origin serves the framed app from), `engine` arms engine-token
 *  auth acceptance + the reverse proxy to the spawned opencode server.
 *
 *  #391 adds `fleet` — the local-shell data plane's staging input. Passing
 *  it arms NOTHING by itself: the entitlement-staged gate
 *  (stageFleetDataPlane, the #394 resolver's dispatch) decides whether the
 *  fleet surfaces exist AT ALL. Without the entitlement (or without a lawful
 *  overlay declaration) the option is ignored entirely — the service is
 *  byte-identical to a base boot (the H3 assertion). With it, the D1 routing
 *  mode, the D2 merged projection, and the D5 hub credential stage. */
export function createAmicodeService(
  opts: {
    password?: string;
    shelf?: { distRoot?: string };
    engine?: { password?: string; getUrl?: () => string | undefined };
    /** S3 (#860): the model-routing settings surface's inputs — the shipped
     *  role cards (the suggestion source) + the live-provider getter (the
     *  credential gate's refresh loop). Absent → the surface renders empty
     *  roles (no cards known) with providers from the stored snapshot. */
    modelRouting?: ModelRoutingDeps;
    fleet?: {
      /** Resolved entitlements (injectable for tests); null resolves the
       *  machine's real set. */
      entitlements?: string[] | null;
      entitlementConfigDir?: string;
      overlaySource?: string | null;
      /** The hub upstream over the fleet tunnel (late-bound). */
      hub: { getUrl: () => string | undefined };
      /** The data-driven routing mode; default "fleet" (a staged plane with
       *  no getter runs fleet). */
      getMode?: () => UpstreamMode;
      /** #392 (D6): the client-enforced data-plane timeout for proxied
       *  reads (headers bound; SSE bodies ride past it). */
      dataPlaneTimeoutMs?: number;
      /** #392 (D3/D6): the write pipeline's timeout + retry budget. */
      writeTimeoutMs?: number;
      writeMaxRetries?: number;
      /** #392 (D6): posture tuning overrides (the named defaults
       *  otherwise). */
      posture?: Partial<FleetPostureTuning>;
      /** #392 (D7): the installed tunnel config (the stamped alias + the
       *  generation marker) — read per request; proxied responses (SSE
       *  included) carry its generation stamp. */
      tunnelConfigPath?: string;
    };
  } = {},
): AmicodeServiceServer {
  const server = new AmicodeServiceServer({
    password: opts.password,
    // The engine mint arms accept-both auth even before the URL getter
    // binds (the engine token is valid on /amicode/* from boot, not just
    // once the upstream is reachable).
    enginePassword: opts.engine?.password,
  });
  if (opts.shelf !== undefined) server.attachAppShelf(new AppShelf(opts.shelf));
  if (opts.engine?.getUrl !== undefined) server.attachEngineProxy(new EngineProxy({ getUrl: opts.engine.getUrl }));
  // #391: the fleet plane stages ONLY through the resolver's dispatch. No
  // entitlement → this block never arms anything → zero fleet surfaces,
  // byte-identical.
  if (opts.fleet !== undefined) {
    const staging = stageFleetDataPlane({
      entitlements: opts.fleet.entitlements,
      entitlementConfigDir: opts.fleet.entitlementConfigDir,
      overlaySource: opts.fleet.overlaySource,
    });
    if (staging.staged) {
      const readCredential = (): HubCredentialRead => readHubCredential();
      // #392 (D6): the posture detector — the outcome stream's consumer.
      // Every data-plane outcome (proxy, write pipeline, projection) feeds
      // it; the client-enforced timeouts live with the transport.
      const monitor = new FleetPostureDetector({ tuning: opts.fleet.posture });
      const tunnelConfigPath = opts.fleet.tunnelConfigPath;
      // #392 (D7): the tunnel generation stamp, read PER RESPONSE so a
      // mid-session rejoin changes what the client sees next.
      const tunnelStampHeaders = tunnelConfigPath
        ? (): Record<string, string> | undefined => {
            const ins = inspectTunnelConfigFile(tunnelConfigPath);
            return ins.stamped && ins.generation !== null ? { [TUNNEL_GENERATION_HEADER]: String(ins.generation) } : undefined;
          }
        : undefined;
      const rawGetMode = opts.fleet.getMode ?? ((): UpstreamMode => "fleet");
      // D6: the hub-down posture IS the base standalone posture — the
      // effective mode falls back to the local engine (a session created in
      // a hub-down window is a LOCAL session, D3), and recovery re-enters
      // fleet via the D2 transition rule (refetch-before-first-render —
      // the posture snapshot's refetch_epoch is the client's key).
      const getMode = (): UpstreamMode => {
        if (rawGetMode() !== "fleet") return rawGetMode();
        return monitor.snapshot().state === "standalone" ? "engine" : "fleet";
      };
      const writeDeps: FleetWriteDeps = {
        getUrl: opts.fleet.hub.getUrl,
        credential: readCredential,
        timeoutMs: opts.fleet.writeTimeoutMs ?? opts.fleet.dataPlaneTimeoutMs,
        maxRetries: opts.fleet.writeMaxRetries,
        onOutcome: (o) => monitor.record(o),
        ...(tunnelStampHeaders ? { responseStamp: tunnelStampHeaders } : {}),
      };
      server.attachFleetPlane({
        getMode,
        hub: new HubProxy({
          getUrl: opts.fleet.hub.getUrl,
          credential: readCredential,
          ...(opts.fleet.dataPlaneTimeoutMs !== undefined ? { timeoutMs: opts.fleet.dataPlaneTimeoutMs } : {}),
          onOutcome: (o) => monitor.record(o),
          ...(tunnelStampHeaders ? { responseStamp: tunnelStampHeaders } : {}),
        }),
        writes: { handle: (req, res) => handleFleetWrite(writeDeps, req, res) },
        onNoUpstream: () => monitor.record({ kind: "no-response", detail: "no-upstream" }),
      });
      registerFleetRoutes(server, {
        getMode,
        readCredential,
        engine: {
          getUrl: opts.engine?.getUrl ?? ((): string | undefined => undefined),
          password: opts.engine?.password,
        },
        hub: opts.fleet.hub,
        receipt: staging.receipt,
        engineArmed: opts.engine !== undefined,
        monitor,
        ...(tunnelConfigPath !== undefined ? { tunnelConfigPath } : {}),
      });
    }
  }
  registerProfileRoutes(server);
  registerVaultRoutes(server);
  registerProblemRoutes(server);
  registerCampaignRoutes(server);
  registerLibraryRoutes(server);
  registerWidgetRoutes(server);
  registerProjectRoutes(server);
  registerConnectionRoutes(server);
  registerSolverModeRoutes(server);
  registerPostureRoutes(server);
  registerModelRoutingRoutes(server, opts.modelRouting);
  return server;
}

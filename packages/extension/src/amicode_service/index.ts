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

/** The service with every ported slice mounted. The extension wiring slice
 *  boots this at activation; the contract tests boot it in-process.
 *
 *  #822 additions, both optional so the parity-contract boots stay
 *  byte-identical: `shelf` mounts the app-bundle static server (the built
 *  dist this origin serves the framed app from), `engine` arms engine-token
 *  auth acceptance + the reverse proxy to the spawned opencode server. */
export function createAmicodeService(
  opts: {
    password?: string;
    shelf?: { distRoot?: string };
    engine?: { password?: string; getUrl?: () => string | undefined };
  } = {},
): AmicodeServiceServer {
  const server = new AmicodeServiceServer(opts);
  if (opts.shelf !== undefined) server.attachAppShelf(new AppShelf(opts.shelf));
  if (opts.engine?.getUrl !== undefined) server.attachEngineProxy(new EngineProxy({ getUrl: opts.engine.getUrl }));
  registerProfileRoutes(server);
  registerVaultRoutes(server);
  registerProblemRoutes(server);
  registerCampaignRoutes(server);
  registerLibraryRoutes(server);
  registerWidgetRoutes(server);
  registerProjectRoutes(server);
  registerConnectionRoutes(server);
  registerSolverModeRoutes(server);
  return server;
}

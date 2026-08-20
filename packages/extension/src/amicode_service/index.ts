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
import { libraryBody, saveLibraryFile } from "./library";

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

/** The service with every ported slice mounted. The extension wiring slice
 *  boots this at activation; the contract tests boot it in-process. */
export function createAmicodeService(opts: { password?: string } = {}): AmicodeServiceServer {
  const server = new AmicodeServiceServer(opts);
  registerProfileRoutes(server);
  registerVaultRoutes(server);
  registerProblemRoutes(server);
  registerLibraryRoutes(server);
  return server;
}

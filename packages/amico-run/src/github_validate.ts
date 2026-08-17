// packages/amico-run/src/github_validate.ts — validator for the GitHub App
// connection panel (#403). Mirrors the pasqal_launch.ts / company-compute
// probe pattern: the panel collects app_id, installation_id, PEM file, writes
// ~/.amico/github.json + ~/.amico/github-app.pem (0600), and this validator
// exercises the REAL mint path (JWT → GET /app, installation-token mint) so
// the status card can report connected / invalid / unconfigured.
//
// SECURITY: same token-free stance as github_app.ts — the PEM and any minted
// token never appear in an error, log, or argv. The validator's ONLY carriage
// for secrets is the file it reads and the Authorization header it sends.

import { readFileSync } from "node:fs";
import { ConfigError } from "./types.js";
import {
  fetchInstallationToken,
  githubAppConfigFile,
  mintAppJwt,
  readGithubAppConfig,
  type FetchImpl,
} from "./github_app.js";

export type ValidateOutcome =
  | { ok: true; appId: string; installationId: string }
  | { ok: false; error: string };

/** Validate the GitHub App connection by exercising the real mint path.
 *  Reads the file contract written by the panel (or hand-written for headless),
 *  mints a JWT, and attempts the installation-token mint. No network in tests —
 *  fetchImpl is injectable (the pasqal validator pattern). */
export async function validateGithubAppConnection(opts: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  nowMs?: number;
} = {}): Promise<ValidateOutcome> {
  const env = opts.env ?? process.env;
  let cfg: ReturnType<typeof readGithubAppConfig>;
  try {
    cfg = readGithubAppConfig(env);
  } catch (e) {
    return { ok: false, error: e instanceof ConfigError ? e.message : String(e) };
  }
  let pem: string;
  try {
    pem = readFileSync(cfg.pemPath, "utf8");
  } catch {
    return {
      ok: false,
      error: `PEM private key not found or unreadable at ${cfg.pemPath} — re-download it from the GitHub App's settings page and fix pem_path, or remove the credential file to fall back to your own gh login`,
    };
  }
  let jwt: string;
  try {
    jwt = mintAppJwt(cfg.appId, pem, opts.nowMs ?? Date.now());
  } catch (e) {
    return { ok: false, error: e instanceof ConfigError ? e.message : String(e) };
  }
  // Also probe GET /app to confirm the App identity itself is valid — mirrors
  // #403 AC2 (JWT signature + GET /app, then installation-token mint).
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchImpl);
  try {
    const appRes = await fetchImpl("https://api.github.com/app", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (appRes.status === 401 || appRes.status === 403 || appRes.status === 404) {
      return {
        ok: false,
        error: `GitHub App not found or PEM mismatch (HTTP ${appRes.status}) — check app_id and that the PEM matches the App; or remove the credential file to fall back to your own gh login`,
      };
    }
    if (appRes.status < 200 || appRes.status >= 300) {
      return { ok: false, error: `GitHub App check failed (HTTP ${appRes.status}) — retry, or remove the credential file to fall back to your own gh login` };
    }
  } catch {
    return { ok: false, error: "GitHub App check did not answer within 15s — retry, or remove the credential file to fall back to your own gh login" };
  }
  try {
    await fetchInstallationToken(jwt, cfg.installationId, fetchImpl);
  } catch (e) {
    return { ok: false, error: e instanceof ConfigError ? e.message : String(e) };
  }
  return { ok: true, appId: cfg.appId, installationId: cfg.installationId };
}

/** Write the GitHub App credential file + PEM atomically (0600) — the panel's
 *  writer. Mirrors the pasqal credential writer's atomic 0600 discipline. */
export function writeGithubAppCredentials(opts: {
  env?: NodeJS.ProcessEnv;
  appId: string;
  installationId: string;
  pemPath: string;
  pemBody: string;
}): void {
  const env = opts.env ?? process.env;
  const file = githubAppConfigFile(env);
  // PEM first so a crash mid-write never leaves a config pointing at a missing PEM
  const { mkdirSync, writeFileSync, chmodSync, renameSync } = require("node:fs") as typeof import("node:fs");
  const { dirname, join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");
  // Resolve PEM path — if caller passed a relative or default, expand; else use exactly
  const pemFile = opts.pemPath.startsWith("~")
    ? join(homedir(), opts.pemPath.slice(1).replace(/^\//, ""))
    : opts.pemPath;
  mkdirSync(dirname(pemFile), { recursive: true });
  const pemTmp = `${pemFile}.tmp-${process.pid}`;
  writeFileSync(pemTmp, opts.pemBody, { mode: 0o600 });
  chmodSync(pemTmp, 0o600);
  renameSync(pemTmp, pemFile);

  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify({ app_id: opts.appId, installation_id: opts.installationId, pem_path: pemFile }, null, 2) + "\n",
    { mode: 0o600 },
  );
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

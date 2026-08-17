// packages/amico-run/src/github_app.ts
// GitHub App identity core (issue #399): Amicode's own `amico[bot]` face on
// GitHub, replacing "every gh call rides the researcher's personal login".
//
// The contract mirrors the Pasqal credential stance (pasqal_launch.ts): a
// JSON credential file at ~/.amico/github.json (keys: app_id, installation_id,
// pem_path), an env override for tests ($AMICO_GITHUB_FILE), and TOKEN-FREE
// actionable errors — here the secrets are the PEM and the installation
// token, and neither may ever appear in an error, a log line, or argv. The
// token's ONLY carriage is the GH_TOKEN env of the real `gh` child (gh_cli.ts)
// and the stdout git-credential protocol of git_credential_cli.ts.
//
// Token lifecycle: RS256 JWT (app id + 3-minute window) → POST
// /app/installations/{id}/access_tokens → {token, expires_at}, cached at
// ~/.amico/github-token.json (0600, atomic write) and reused until
// REUSE_SKEW_SECONDS of life remain. A cache that is absent or corrupt is
// never an error — it is re-minted. Only CONFIG faults (missing keys,
// unreadable PEM, mint rejected) are exit-64-class.
import { createPrivateKey, sign as cryptoSign, verify as cryptoVerify, generateKeyPairSync, KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ConfigError } from "./types.js";

/** GitHub caps App JWT lifetimes at 10 minutes; 3 minutes is ample for one
 *  mint, and a short window keeps a leaked JWT useless quickly. */
export const JWT_LIFETIME_SECONDS = 180;
/** GitHub's documented clock tolerance: issue the JWT 60s in the past so a
 *  slightly-ahead API server still accepts it. */
export const JWT_ISSUED_AT_SKEW_SECONDS = 60;
/** Reuse a cached installation token only while this much life remains
 *  (GitHub tokens live 1 hour). 5 minutes absorbs one gh invocation's
 *  runtime without ever serving a token that dies mid-command. */
export const REUSE_SKEW_SECONDS = 300;

export interface GithubAppConfig {
  appId: string;
  installationId: string;
  pemPath: string;
}

export interface InstallationToken {
  token: string; // ghs_… — secret; env/stdout carriage ONLY
  expiresAt: string; // ISO 8601 (GitHub returns UTC); not a secret
}

/** $AMICO_GITHUB_FILE overrides the config path (tests / sandbox isolation) —
 *  the pasqalCredentialFile idiom. */
export function githubAppConfigFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_GITHUB_FILE;
  if (v && v.trim() !== "") return v;
  return join(homedir(), ".amico", "github.json");
}

/** $AMICO_GITHUB_TOKEN_FILE overrides the cache path (tests). */
export function githubTokenCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.AMICO_GITHUB_TOKEN_FILE;
  if (v && v.trim() !== "") return v;
  return join(homedir(), ".amico", "github-token.json");
}

/** Shape-check a parsed config. Errors name KEYS and the FILE only — a value
 *  could be a mistyped path to the secret. Pure (no fs) so tests never touch
 *  a real credential file. */
export function parseGithubAppConfig(raw: unknown, file: string): GithubAppConfig {
  if (typeof raw !== "object" || raw === null)
    throw new ConfigError(`malformed GitHub App credential file at ${file} — expected a JSON object`);
  const d = raw as Record<string, unknown>;
  if (typeof d.app_id !== "string" || d.app_id === "" || typeof d.installation_id !== "string" || d.installation_id === "")
    throw new ConfigError(
      `GitHub App credential file at ${file} needs non-empty string keys "app_id" and "installation_id" — re-add the GitHub connection to rewrite it`,
    );
  if (typeof d.pem_path !== "string" || d.pem_path === "")
    throw new ConfigError(
      `GitHub App credential file at ${file} needs a non-empty string key "pem_path" pointing at the App's PEM private key — re-add the GitHub connection to rewrite it`,
    );
  return { appId: d.app_id, installationId: d.installation_id, pemPath: d.pem_path };
}

/** Read + parse the config file. Distinct ConfigError per failure mode. */
export function readGithubAppConfig(env: NodeJS.ProcessEnv = process.env): GithubAppConfig {
  const file = githubAppConfigFile(env);
  if (!existsSync(file))
    throw new ConfigError(
      `not connected — no GitHub App credential file at ${file} (remove the expectation or re-add the connection)`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(`malformed GitHub App credential file at ${file} — re-add the GitHub connection to rewrite it`);
  }
  return parseGithubAppConfig(raw, file);
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/** Mint the App JWT (pure: pem as string, injectable clock). RS256 per
 *  GitHub's App auth; claims iss=app_id, iat=now-60, exp=iat+180. */
export function mintAppJwt(appId: string, pem: string, nowMs: number = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const iat = Math.floor(nowMs / 1000) - JWT_ISSUED_AT_SKEW_SECONDS;
  const exp = iat + JWT_LIFETIME_SECONDS;
  const payload = b64url(JSON.stringify({ iat, exp, iss: appId }));
  const signingInput = `${header}.${payload}`;
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // The PEM text IS the secret — the error names the path, never the key.
    throw new ConfigError(`unreadable PEM private key — re-download it from the GitHub App's settings page and rewrite pem_path`);
  }
  const signature = cryptoSign("sha256", Buffer.from(signingInput, "utf8"), key).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Verify an App JWT against a public key (test-side assertion helper). */
export function verifyAppJwt(jwt: string, publicKey: KeyObject): boolean {
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return false;
  return cryptoVerify("sha256", Buffer.from(`${h}.${p}`, "utf8"), publicKey, Buffer.from(s, "base64url"));
}

/** Test helper: a throwaway RSA keypair, so fixtures never ship a real PEM. */
export function testKeyPair(): { privateKeyPem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }).toString(), publicKey };
}

/** True while the cached token has more than REUSE_SKEW_SECONDS of life. */
export function isCacheFresh(cache: InstallationToken, nowMs: number = Date.now(), skewSeconds = REUSE_SKEW_SECONDS): boolean {
  const exp = Date.parse(cache.expiresAt);
  return !Number.isNaN(exp) && exp - nowMs > skewSeconds * 1000;
}

/** Parse the access-token endpoint's body. The token never lands in an error. */
export function parseInstallationToken(json: string): InstallationToken {
  let d: unknown;
  try {
    d = JSON.parse(json);
  } catch {
    throw new ConfigError("GitHub App token mint returned a malformed body — retry, or remove the credential file to fall back to your own gh login");
  }
  const o = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
  if (typeof o.token !== "string" || o.token === "" || typeof o.expires_at !== "string" || o.expires_at === "")
    throw new ConfigError("GitHub App token mint returned no token/expiry — check the App's installation, or remove the credential file to fall back to your own gh login");
  return { token: o.token, expiresAt: o.expires_at };
}

export type FetchImpl = (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

/** POST /app/installations/{id}/access_tokens with the JWT as bearer. */
export async function fetchInstallationToken(jwt: string, installationId: string, fetchImpl: FetchImpl): Promise<InstallationToken> {
  const res = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`, // secret: header carriage ONLY
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (res.status !== 201)
    throw new ConfigError(
      `GitHub App token mint failed (HTTP ${res.status}) — check app_id/installation_id and that the PEM matches the App; or remove the credential file to fall back to your own gh login`,
    );
  return parseInstallationToken(JSON.stringify(await res.json()));
}

/** Cache read: absent or corrupt → undefined, NEVER an error (the cache is an
 *  optimization; a bad cache is re-minted, not diagnosed). */
export function readTokenCache(env: NodeJS.ProcessEnv = process.env): InstallationToken | undefined {
  const file = githubTokenCacheFile(env);
  if (!existsSync(file)) return undefined;
  try {
    const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof d.token === "string" && d.token !== "" && typeof d.expiresAt === "string" && d.expiresAt !== "")
      return { token: d.token, expiresAt: d.expiresAt };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Atomic 0600 cache write (tmp + rename, the esbuild-staging idiom). */
export function writeTokenCache(cache: InstallationToken, env: NodeJS.ProcessEnv = process.env): void {
  const file = githubTokenCacheFile(env);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600); // the tmp file's mode must survive however it was created
  renameSync(tmp, file);
}

/** The seams ensureInstallationToken needs; all injectable, all defaulted. */
export interface EnsureDeps {
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  fetchImpl?: FetchImpl;
  readPem?: (path: string) => string;
}

/** Cache-first token acquisition: fresh cache → reuse; else mint (config →
 *  JWT → API) → cache → return. The single entry point both CLIs share. */
export async function ensureInstallationToken(deps: EnsureDeps = {}): Promise<InstallationToken> {
  const env = deps.env ?? process.env;
  const cached = readTokenCache(env);
  const now = deps.nowMs ?? Date.now;
  if (cached && isCacheFresh(cached, now())) return cached;
  const cfg = readGithubAppConfig(env);
  let pem: string;
  try {
    pem = (deps.readPem ?? ((p: string) => readFileSync(p, "utf8")))(cfg.pemPath);
  } catch {
    throw new ConfigError(
      `PEM private key not found or unreadable at ${cfg.pemPath} — re-download it from the GitHub App's settings page and fix pem_path, or remove the credential file to fall back to your own gh login`,
    );
  }
  const jwt = mintAppJwt(cfg.appId, pem, now());
  const token = await fetchInstallationToken(jwt, cfg.installationId, deps.fetchImpl ?? (fetch as unknown as FetchImpl));
  writeTokenCache(token, env);
  return token;
}

/** Scan PATH for the REAL gh, skipping the directory this bundle's launcher
 *  lives in (a bare exec would recurse into the shim itself). Pure. */
export function resolveRealGh(pathValue: string | undefined, ownLauncherDir: string | undefined): string | undefined {
  const skip = ownLauncherDir ? realPathOrSelf(ownLauncherDir) : undefined;
  for (const dir of (pathValue ?? "").split(":").filter(Boolean)) {
    if (skip && realPathOrSelf(dir) === skip) continue;
    const candidate = join(dir, "gh");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function realPathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

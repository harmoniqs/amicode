// packages/amico-run/src/pasqal_connect.ts — `amico pasqal connect` (issue #194):
// browser sign-in for Pasqal Cloud via OAuth authorization-code + PKCE with a
// loopback callback (RFC 8252, the `gh auth login` pattern). The user's password
// never enters this process in any form — sign-in happens on Pasqal's own page;
// what comes back is a single-use code, exchanged in-process for a revocable
// token and persisted token-only (ADR 0001: atomic, 0600 at file birth).
//
// SECURITY invariants (the launcher/remote_config stance, extended):
//   - the access/refresh token never appears in argv, stdout JSON, an error
//     message, or a log line — errors quote OAuth `error` codes only, never bodies
//   - the callback listener binds 127.0.0.1 ONLY, ephemeral port by default:
//     the redirect URI is built from the port actually bound (bind-then-build),
//     so a squatter can force EADDRINUSE but never silently receive the code —
//     and a stolen code is unredeemable anyway without the in-process verifier
//   - a mismatched `state` is answered 400 and the attempt keeps waiting; only
//     the matching state resolves it
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";
import { pasqalCredentialFile } from "./pasqal_launch.js";
import { ConfigError } from "./types.js";

// Pasqal's published prod values (public in the pasqal-cloud SDK's endpoints.py).
// Env overrides exist for tests and preprod — and because the client below does
// not yet allow loopback redirects (probed 2026-07-21); the ask to Pasqal is a
// native client with any-port loopback matching, possibly under a NEW client id.
const DEFAULT_AUTH_BASE = "https://authenticate.pasqal.cloud";
const DEFAULT_CLIENT_ID = "PeZvo7Atx7IVv3iel59asJSb4Ig7vuSB";
const DEFAULT_AUDIENCE = "https://apis.pasqal.cloud/account/api/v1";
const SCOPE = "openid profile email offline_access";
const DEFAULT_TIMEOUT_MS = 300_000;

export interface PasqalAuthConfig {
  authBase: string;
  clientId: string;
  audience: string;
}

export function pasqalAuthConfig(env: NodeJS.ProcessEnv = process.env): PasqalAuthConfig {
  const pick = (v: string | undefined, fallback: string) => (v && v.trim() !== "" ? v : fallback);
  return {
    authBase: pick(env.AMICO_PASQAL_AUTH_BASE, DEFAULT_AUTH_BASE).replace(/\/$/, ""),
    clientId: pick(env.AMICO_PASQAL_CLIENT_ID, DEFAULT_CLIENT_ID),
    audience: pick(env.AMICO_PASQAL_AUDIENCE, DEFAULT_AUDIENCE),
  };
}

// ── PKCE ──────────────────────────────────────────────────────────────────────

export interface Pkce {
  verifier: string;
  challenge: string;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** RFC 7636: high-entropy verifier, S256 challenge. The verifier never leaves
 *  process memory — it is what makes an intercepted code worthless. */
export function generatePkce(): Pkce {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

export function buildAuthorizeUrl(
  cfg: PasqalAuthConfig,
  opts: { challenge: string; state: string; redirectUri: string },
): string {
  const u = new URL(`${cfg.authBase}/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", opts.redirectUri);
  u.searchParams.set("scope", SCOPE);
  u.searchParams.set("audience", cfg.audience);
  u.searchParams.set("code_challenge", opts.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", opts.state);
  return u.toString();
}

// ── loopback callback ─────────────────────────────────────────────────────────

const CALLBACK_PATH = "/callback";
const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>Amico — connected</title>
<body style="font:14px -apple-system,system-ui,sans-serif;padding:48px;color:#2f2f2d">
<h1 style="font-size:18px">Connected to Pasqal Cloud</h1>
<p>You can close this tab and return to your editor.</p>`;

export interface CallbackServer {
  port: number;
  /** Resolves with the authorization code on a state-matching callback; rejects
   *  (ConfigError) on user denial, timeout, or close(). */
  result: Promise<{ code: string }>;
  close(): void;
}

/** One-shot loopback listener. Binds 127.0.0.1 on `port` (default 0 = ephemeral,
 *  the squat-proof order: bind first, advertise the bound port after). */
export function startCallbackServer(opts: {
  state: string;
  timeoutMs?: number;
  port?: number;
}): Promise<CallbackServer> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolveStart, rejectStart) => {
    let settle: { resolve: (v: { code: string }) => void; reject: (e: Error) => void } | null = null;
    const result = new Promise<{ code: string }>((res, rej) => {
      settle = { resolve: res, reject: rej };
    });
    // The denial lane rejects while the caller is still awaiting the browser
    // round-trip — pre-arm a no-op handler so that gap is never an unhandled
    // rejection. Callers awaiting `result` still observe the rejection.
    void result.catch(() => {});
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const state = url.searchParams.get("state");
      if (state !== opts.state) {
        // Forged or stray callback: refuse it, keep waiting for the real one.
        res.writeHead(400, { "content-type": "text/plain" }).end("state mismatch — this window can be closed");
        return;
      }
      if (err) {
        // OAuth error codes are spec-defined short identifiers — safe to quote.
        res.writeHead(200, { "content-type": "text/html" }).end("<p>Sign-in was not completed. You can close this tab.</p>");
        finish(new ConfigError(`sign-in did not finish — Pasqal reported "${err}". Try again from the Connections panel`));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain" }).end("missing code — this window can be closed");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end(DONE_PAGE);
      finish(null, code);
    });

    const timer = setTimeout(() => {
      finish(new ConfigError(`sign-in timed out after ${Math.round(timeoutMs / 1000)}s — the browser tab was closed or never finished. Try again from the Connections panel`));
    }, timeoutMs);
    timer.unref?.();

    function finish(error: Error | null, code?: string): void {
      clearTimeout(timer);
      server.close();
      if (!settle) return;
      const s = settle;
      settle = null;
      if (error) s.reject(error);
      else s.resolve({ code: code as string });
    }

    server.on("error", (e) => {
      rejectStart(
        new ConfigError(
          `could not open the local sign-in listener${opts.port ? ` on port ${opts.port}` : ""}: ${(e as NodeJS.ErrnoException).code ?? "listen error"}`,
        ),
      );
    });
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        finish(new ConfigError("local sign-in listener bound to an unexpected address"));
        rejectStart(new ConfigError("local sign-in listener bound to an unexpected address"));
        return;
      }
      resolveStart({
        port: addr.port,
        result,
        close: () => finish(new ConfigError("sign-in was cancelled")),
      });
    });
  });
}

// ── token exchange ────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
}

/** POST the single-use code + verifier to the token endpoint. Failures quote the
 *  OAuth `error` code only — never the response body (token-free discipline). */
export async function exchangeCode(
  cfg: PasqalAuthConfig,
  opts: { code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch },
): Promise<TokenResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${cfg.authBase}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: cfg.clientId,
        code: opts.code,
        code_verifier: opts.verifier,
        redirect_uri: opts.redirectUri,
      }).toString(),
    });
  } catch {
    throw new ConfigError(`could not reach ${cfg.authBase} to finish sign-in — check your connection and try again`);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON body: fall through to the status-only error */
  }
  const d = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (!res.ok) {
    const oauthError = typeof d.error === "string" ? ` (${d.error})` : "";
    throw new ConfigError(`token exchange failed with HTTP ${res.status}${oauthError} — try connecting again`);
  }
  if (typeof d.access_token !== "string" || d.access_token === "")
    throw new ConfigError("token endpoint returned no access token — try connecting again");
  return {
    access_token: d.access_token,
    expires_in: typeof d.expires_in === "number" ? d.expires_in : undefined,
    refresh_token: typeof d.refresh_token === "string" ? d.refresh_token : undefined,
    id_token: typeof d.id_token === "string" ? d.id_token : undefined,
  };
}

// ── claims (unverified decode — display/expiry metadata only, never authz) ────

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** expires_at: prefer the endpoint's `expires_in`, else the JWT `exp` claim,
 *  else absent (the reader treats absent as "no expiry stored"). */
export function deriveExpiresAt(tok: TokenResponse, now: Date = new Date()): string | undefined {
  if (tok.expires_in !== undefined) return new Date(now.getTime() + tok.expires_in * 1000).toISOString();
  const exp = jwtPayload(tok.access_token)?.exp;
  if (typeof exp === "number") return new Date(exp * 1000).toISOString();
  return undefined;
}

/** Identity for the panel's "Connected as …" line, from the ID token's claims. */
export function deriveIdentity(tok: TokenResponse): string | undefined {
  if (!tok.id_token) return undefined;
  const claims = jwtPayload(tok.id_token);
  const email = claims?.email;
  if (typeof email === "string" && email !== "") return email;
  const sub = claims?.sub;
  return typeof sub === "string" && sub !== "" ? sub : undefined;
}

// ── persistence (ADR 0001: atomic + 0600 at file birth) ───────────────────────

export interface StoredPasqalCredentials {
  project_id: string;
  token: string;
  expires_at?: string;
  refresh_token?: string;
  identity?: string;
}

/** The tmp file is CREATED 0600 (mode at open — the default write mode is
 *  0o666 & ~umask), then renamed over the target: no reader ever sees a torn
 *  or over-permissioned file. `renameImpl` is injectable so tests can assert
 *  the tmp file's mode at birth, before the rename hides it. */
export function writePasqalCredentials(
  file: string,
  creds: StoredPasqalCredentials,
  renameImpl: (from: string, to: string) => void = renameSync,
): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2) + "\n", { mode: 0o600 });
  renameImpl(tmp, file);
}

// ── browser open ──────────────────────────────────────────────────────────────

export type BrowserOpen = (url: string) => Promise<boolean>;

/** Spawn the platform opener, detached. Resolves false (never throws) on any
 *  failure — the caller degrades to printing the URL and keeps waiting. */
export const defaultBrowserOpen: BrowserOpen = (url) =>
  new Promise((resolveP) => {
    const [bin, args] =
      process.platform === "darwin"
        ? ["open", [url]]
        : process.platform === "win32"
          ? ["cmd", ["/c", "start", "", url]]
          : ["xdg-open", [url]];
    try {
      const child = spawn(bin, args, { stdio: "ignore", detached: true });
      child.on("error", () => resolveP(false));
      child.on("spawn", () => {
        child.unref();
        resolveP(true);
      });
    } catch {
      resolveP(false);
    }
  });

// ── orchestration ─────────────────────────────────────────────────────────────

export interface ConnectOptions {
  projectId: string;
  noOpen?: boolean;
  timeoutMs?: number;
  port?: number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  browserOpen?: BrowserOpen;
  /** Where the authorize URL goes when the browser is not opened (or fails to).
   *  The CLI sends this to stderr — stdout stays reserved for the JSON result. */
  onAuthorizeUrl?: (url: string) => void;
}

export interface ConnectResult {
  file: string;
  identity?: string;
  expiresAt?: string;
}

export async function pasqalConnect(opts: ConnectOptions): Promise<ConnectResult> {
  const env = opts.env ?? process.env;
  const cfg = pasqalAuthConfig(env);
  const { verifier, challenge } = generatePkce();
  const state = b64url(randomBytes(16));

  const cb = await startCallbackServer({ state, timeoutMs: opts.timeoutMs, port: opts.port });
  try {
    const redirectUri = `http://127.0.0.1:${cb.port}${CALLBACK_PATH}`;
    const url = buildAuthorizeUrl(cfg, { challenge, state, redirectUri });
    if (opts.noOpen) {
      opts.onAuthorizeUrl?.(url);
    } else {
      const opened = await (opts.browserOpen ?? defaultBrowserOpen)(url);
      if (!opened) opts.onAuthorizeUrl?.(url);
    }

    const { code } = await cb.result;
    const tok = await exchangeCode(cfg, { code, verifier, redirectUri, fetchImpl: opts.fetchImpl });

    const file = pasqalCredentialFile(env);
    const stored: StoredPasqalCredentials = { project_id: opts.projectId, token: tok.access_token };
    const expiresAt = deriveExpiresAt(tok);
    const identity = deriveIdentity(tok);
    if (expiresAt !== undefined) stored.expires_at = expiresAt;
    if (tok.refresh_token !== undefined) stored.refresh_token = tok.refresh_token;
    if (identity !== undefined) stored.identity = identity;
    writePasqalCredentials(file, stored);
    return { file, identity, expiresAt };
  } finally {
    cb.close();
  }
}

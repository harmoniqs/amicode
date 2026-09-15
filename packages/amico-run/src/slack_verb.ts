// packages/amico-run/src/slack_verb.ts — the `amico slack login` verb (#1156):
// OAuth 2.0 PKCE flow for Slack user token acquisition. Starts a temporary
// HTTP server, opens the user's browser to Slack's authorize endpoint with a
// PKCE challenge and random state, receives the callback, exchanges the code
// for a user token (xoxp-*), and writes it to ~/.amico/slack.json (atomic,
// 0600). NO client_secret — PKCE only.
//
// SECURITY: no credential value ever appears in a log line. The token is
// written to disk through the same atomic-0600 pattern as credentials.ts.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { exec } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ── constants ─────────────────────────────────────────────────────────────────

/** Read the Slack App credentials from env / ~/.amico/slack-app.json.
 *  Priority: env vars → JSON file → empty. Both are needed for the OAuth
 *  exchange — Slack's oauth.v2.access requires client_secret even with PKCE. */
function readSlackAppCredentials(): { clientId: string; clientSecret: string } {
  const envId = process.env.AMICODE_SLACK_CLIENT_ID?.trim();
  const envSecret = process.env.AMICODE_SLACK_CLIENT_SECRET?.trim();
  if (envId) return { clientId: envId, clientSecret: envSecret ?? "" };
  try {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const { homedir } = require("node:os");
    const data = JSON.parse(readFileSync(join(homedir(), ".amico", "slack-app.json"), "utf8"));
    const id = typeof data.client_id === "string" ? data.client_id.trim() : "";
    const secret = typeof data.client_secret === "string" ? data.client_secret.trim() : "";
    return { clientId: id, clientSecret: secret };
  } catch {}
  return { clientId: "", clientSecret: "" };
}

/** Re-read on every call so the Connections panel's save is picked up without
 *  restarting the amico process. Exported for the config bridge's guard. */
export function getSlackClientId(): string {
  return readSlackAppCredentials().clientId;
}

/** @deprecated Use getSlackClientId() — kept for existing import sites. */
export const AMICODE_SLACK_CLIENT_ID = (() => readSlackAppCredentials().clientId)();

const CALLBACK_PORT = 54213;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/callback`;
const TIMEOUT_MS = 120_000;

/** User-scope permissions the Slack App requests (PKCE — user_scope, not scope). */
const USER_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "users:read",
  "chat:write",
  "search:read",
].join(",");

// ── PKCE helpers ──────────────────────────────────────────────────────────────

/** Random base64url string, 43–128 chars (RFC 7636 §4.1). */
function generateCodeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

/** S256 code_challenge = base64url(SHA-256(code_verifier)) (RFC 7636 §4.2). */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Crypto-random hex state for CSRF protection. */
function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ── credential file ───────────────────────────────────────────────────────────

/** $AMICO_SLACK_FILE override; default ~/.amico/slack.json — the same
 *  resolution as credentials.ts slackFile(). */
function slackFile(): string {
  const env = process.env.AMICO_SLACK_FILE;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".amico", "slack.json");
}

/** Atomic replace: write a sibling tmp with mode 0600, rename over target.
 *  Same pattern as credentials.ts atomicWriteFileSync. */
function atomicWrite(target: string, data: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// ── browser open ──────────────────────────────────────────────────────────────

/** Open a URL in the user's default browser — platform-aware fallback. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  exec(`${cmd} ${JSON.stringify(url)}`, (err) => {
    if (err) {
      // If browser launch fails, print the URL for manual copy-paste.
      console.error(`Could not open browser automatically. Visit this URL:\n  ${url}`);
    }
  });
}

// ── HTML responses ────────────────────────────────────────────────────────────

function successHtml(userName: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Amicode — Slack Connected</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#f5c542;margin-bottom:.5rem}p{color:#aaa}</style></head>
<body><div class="card"><h1>Connected</h1>
<p>Authenticated as <strong>${escapeHtml(userName)}</strong>.</p>
<p>You can close this tab and return to Amicode.</p></div></body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Amicode — Slack Error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;
height:100vh;margin:0;background:#0f0f0f;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#1a1a1a;border:1px solid #333}
h1{color:#e55;margin-bottom:.5rem}p{color:#aaa}</style></head>
<body><div class="card"><h1>Error</h1>
<p>${escapeHtml(message)}</p></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── token exchange ────────────────────────────────────────────────────────────

interface SlackOAuthResponse {
  ok: boolean;
  error?: string;
  authed_user?: {
    id: string;
    access_token: string;
  };
}

/** Exchange the authorization code for a user token via Slack's oauth.v2.access.
 *  Slack requires client_secret even with PKCE — the code_verifier is additive
 *  security, not a replacement for the secret. */
async function exchangeCode(code: string, codeVerifier: string): Promise<SlackOAuthResponse> {
  const creds = readSlackAppCredentials();
  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  });

  const res = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status} from Slack` };
  }

  return (await res.json()) as SlackOAuthResponse;
}

// ── lookup user name ──────────────────────────────────────────────────────────

/** Best-effort user name resolution via users.info. Falls back to the user ID. */
async function resolveUserName(token: string, userId: string): Promise<string> {
  try {
    const res = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return userId;
    const data = (await res.json()) as { ok: boolean; user?: { real_name?: string; name?: string } };
    if (!data.ok || !data.user) return userId;
    return data.user.real_name || data.user.name || userId;
  } catch {
    return userId;
  }
}

// ── the login flow ────────────────────────────────────────────────────────────

function loginUsage(): void {
  console.log("usage: amico slack login\n\nStarts the Slack OAuth PKCE flow to authenticate your user token.");
}

async function slackLogin(): Promise<{ code: number }> {
  const creds = readSlackAppCredentials();
  if (!creds.clientId) {
    console.error(
      "No Slack App configured.\n\n" +
      "Ask your Slack workspace admin to create an Amicode Slack App:\n" +
      "  1. Go to https://api.slack.com/apps → Create New App → From an app manifest\n" +
      "  2. Use the Amicode Slack App manifest (see docs)\n" +
      "  3. Copy the Client ID and Client Secret from Basic Information → App Credentials\n\n" +
      "Then either:\n" +
      "  • Set AMICODE_SLACK_CLIENT_ID and AMICODE_SLACK_CLIENT_SECRET in your environment, or\n" +
      "  • Connect via Settings → Connections → Slack in Amicode\n",
    );
    return { code: 1 };
  }
  if (!creds.clientSecret) {
    console.error(
      "Slack App Client ID is configured, but Client Secret is missing.\n\n" +
      "Slack's OAuth requires both. Find the Client Secret at:\n" +
      "  https://api.slack.com/apps → Your App → Basic Information → App Credentials\n\n" +
      "Then either:\n" +
      "  • Set AMICODE_SLACK_CLIENT_SECRET in your environment, or\n" +
      "  • Connect via Settings → Connections → Slack in Amicode\n",
    );
    return { code: 1 };
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  return new Promise<{ code: number }>((resolveP) => {
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolveP({ code });
    };

    // ── timeout ────────────────────────────────────────────────────
    const timeout = setTimeout(() => {
      console.error("Timed out waiting for Slack callback (120s). No authorization received.");
      server.close();
      settle(1);
    }, TIMEOUT_MS);

    // ── HTTP server ────────────────────────────────────────────────
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      // Only handle GET /callback
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }

      // Check for Slack error (user denied consent, etc.)
      const error = url.searchParams.get("error");
      if (error) {
        const desc = url.searchParams.get("error_description") ?? error;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml(`Slack authorization failed: ${desc}`));
        console.error(`Slack authorization denied: ${desc}`);
        clearTimeout(timeout);
        server.close();
        settle(1);
        return;
      }

      // Verify state matches (CSRF protection)
      const callbackState = url.searchParams.get("state");
      if (callbackState !== state) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml("State mismatch — possible CSRF attack. Please try again."));
        console.error("OAuth state mismatch — aborting.");
        clearTimeout(timeout);
        server.close();
        settle(1);
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml("No authorization code received from Slack."));
        console.error("No authorization code in callback.");
        clearTimeout(timeout);
        server.close();
        settle(1);
        return;
      }

      // Exchange code for token
      try {
        const tokenRes = await exchangeCode(code, codeVerifier);
        if (!tokenRes.ok || !tokenRes.authed_user?.access_token) {
          const msg = tokenRes.error ?? "unknown error";
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(errorHtml(`Token exchange failed: ${msg}`));
          console.error(`Slack token exchange failed: ${msg}`);
          clearTimeout(timeout);
          server.close();
          settle(1);
          return;
        }

        const token = tokenRes.authed_user.access_token;
        const userId = tokenRes.authed_user.id;

        // Write the credential — atomic, 0600
        const target = slackFile();
        atomicWrite(target, JSON.stringify({ token }, null, 2) + "\n");

        // Resolve the human-readable name (best-effort)
        const userName = await resolveUserName(token, userId);

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(successHtml(userName));
        console.log(`Slack authenticated as ${userName}. Token saved.`);

        clearTimeout(timeout);
        server.close();
        settle(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(errorHtml(`Unexpected error: ${msg}`));
        console.error(`Slack login error: ${msg}`);
        clearTimeout(timeout);
        server.close();
        settle(1);
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`Port ${CALLBACK_PORT} is already in use. Close the other process and try again.`);
      } else {
        console.error(`Server error: ${err.message}`);
      }
      clearTimeout(timeout);
      settle(1);
    });

    server.listen(CALLBACK_PORT, () => {
      // Build the authorize URL — re-read credentials so the Connections panel
      // save is picked up without process restart
      const creds = readSlackAppCredentials();
      const params = new URLSearchParams({
        client_id: creds.clientId,
        user_scope: USER_SCOPES,
        redirect_uri: REDIRECT_URI,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
      const authorizeUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

      console.log("Opening Slack authorization in your browser…");
      openBrowser(authorizeUrl);
      console.log(`\nIf the browser didn't open, visit:\n  ${authorizeUrl}\n`);
      console.log("Waiting for authorization callback…");
    });
  });
}

// ── verb dispatch ─────────────────────────────────────────────────────────────

/** The `amico slack` verb. Subcommands:
 *    amico slack login — start the OAuth PKCE flow */
export async function slackVerb(args: string[]): Promise<{ code: number }> {
  const sub = args[0];
  if (sub === "login") return slackLogin();
  if (sub === "--help" || sub === "-h") {
    loginUsage();
    return { code: 0 };
  }
  console.error(
    `amico slack: unknown subcommand ${sub ? `"${sub}"` : "(none)"}\n\nusage: amico slack login`,
  );
  return { code: 64 };
}

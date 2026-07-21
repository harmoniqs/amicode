// packages/amico-run/test/pasqal_connect.test.ts — browser sign-in (issue #194).
// SECURITY CONTRACT under test: the token never appears in the verb JSON, an
// error message, or any argv; the callback listener binds loopback only and
// refuses state mismatches; the credential file is born 0600 and atomic.
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { get as httpGet, createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpRoot } from "./helpers.js";
import {
  buildAuthorizeUrl,
  deriveExpiresAt,
  deriveIdentity,
  exchangeCode,
  generatePkce,
  pasqalAuthConfig,
  pasqalConnect,
  pkceChallenge,
  startCallbackServer,
  writePasqalCredentials,
  type TokenResponse,
} from "../src/pasqal_connect.js";
import { readPasqalCredentials } from "../src/pasqal_launch.js";
import { pasqalVerb } from "../src/pasqal_verb.js";
import { ConfigError } from "../src/types.js";

const TOKEN = "tok-sekret-never-printed";

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64url");
}

/** Unsigned JWT with the given payload — enough for the unverified-decode paths. */
function fakeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none" }))}.${b64url(JSON.stringify(payload))}.sig`;
}

function fetchJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** GET a URL, resolving status + body (the "browser" side of the callback). */
function browserGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, rejectP) => {
    httpGet(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolveP({ status: res.statusCode ?? 0, body }));
    }).on("error", rejectP);
  });
}

describe("pkce + authorize url", () => {
  it("generates a base64url verifier whose S256 challenge matches", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(pkceChallenge(verifier)).toBe(challenge);
  });

  it("builds the authorize URL with every required parameter", () => {
    const cfg = pasqalAuthConfig({});
    const u = new URL(
      buildAuthorizeUrl(cfg, { challenge: "chal", state: "st8", redirectUri: "http://127.0.0.1:7777/callback" }),
    );
    expect(u.origin).toBe("https://authenticate.pasqal.cloud");
    expect(u.pathname).toBe("/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(cfg.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7777/callback");
    expect(u.searchParams.get("code_challenge")).toBe("chal");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("st8");
    expect(u.searchParams.get("scope")).toContain("openid");
    expect(u.searchParams.get("audience")).toBe(cfg.audience);
  });

  it("env overrides beat the published prod defaults", () => {
    const cfg = pasqalAuthConfig({
      AMICO_PASQAL_AUTH_BASE: "http://127.0.0.1:9/",
      AMICO_PASQAL_CLIENT_ID: "cid-test",
      AMICO_PASQAL_AUDIENCE: "aud-test",
    });
    expect(cfg).toEqual({ authBase: "http://127.0.0.1:9", clientId: "cid-test", audience: "aud-test" });
  });
});

describe("loopback callback server", () => {
  it("resolves the code on a state-matching callback and answers a done page", async () => {
    const cb = await startCallbackServer({ state: "good-state" });
    const res = await browserGet(`http://127.0.0.1:${cb.port}/callback?code=abc123&state=good-state`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("close this tab");
    await expect(cb.result).resolves.toEqual({ code: "abc123" });
  });

  it("answers 400 to a state mismatch and KEEPS waiting for the real callback", async () => {
    const cb = await startCallbackServer({ state: "real" });
    const forged = await browserGet(`http://127.0.0.1:${cb.port}/callback?code=stolen&state=forged`);
    expect(forged.status).toBe(400);
    const genuine = await browserGet(`http://127.0.0.1:${cb.port}/callback?code=mine&state=real`);
    expect(genuine.status).toBe(200);
    await expect(cb.result).resolves.toEqual({ code: "mine" });
  });

  it("rejects with the OAuth error code on user denial — and only the code", async () => {
    const cb = await startCallbackServer({ state: "s" });
    await browserGet(`http://127.0.0.1:${cb.port}/callback?error=access_denied&state=s`);
    await expect(cb.result).rejects.toThrow(/access_denied/);
    await expect(cb.result).rejects.toBeInstanceOf(ConfigError);
  });

  it("times out with a distinct actionable message", async () => {
    const cb = await startCallbackServer({ state: "s", timeoutMs: 40 });
    await expect(cb.result).rejects.toThrow(/timed out/);
  });

  it("close() cancels the pending attempt", async () => {
    const cb = await startCallbackServer({ state: "s" });
    cb.close();
    await expect(cb.result).rejects.toThrow(/cancelled/);
  });
});

describe("token exchange", () => {
  const cfg = { authBase: "http://127.0.0.1:1", clientId: "cid", audience: "aud" };

  it("POSTs the code + verifier as form data and parses the token response", async () => {
    let seen: { url: string; body: string } | undefined;
    const tok = await exchangeCode(cfg, {
      code: "the-code",
      verifier: "the-verifier",
      redirectUri: "http://127.0.0.1:5/callback",
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(url), body: String(init?.body) };
        return fetchJson(200, { access_token: TOKEN, expires_in: 3600, refresh_token: "r1", id_token: "i1" });
      }) as typeof fetch,
    });
    expect(seen?.url).toBe("http://127.0.0.1:1/oauth/token");
    const form = new URLSearchParams(seen?.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("the-code");
    expect(form.get("code_verifier")).toBe("the-verifier");
    expect(form.get("redirect_uri")).toBe("http://127.0.0.1:5/callback");
    expect(form.get("client_id")).toBe("cid");
    expect(tok).toEqual({ access_token: TOKEN, expires_in: 3600, refresh_token: "r1", id_token: "i1" });
  });

  it("quotes ONLY the OAuth error code on failure — never the response body", async () => {
    const failing = (async () =>
      fetchJson(403, { error: "invalid_grant", error_description: `leaky ${TOKEN}` })) as typeof fetch;
    const err = await exchangeCode(cfg, {
      code: "c",
      verifier: "v",
      redirectUri: "r",
      fetchImpl: failing,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("invalid_grant");
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("treats a missing access_token as a distinct failure", async () => {
    const empty = (async () => fetchJson(200, { hello: "no token here" })) as typeof fetch;
    await expect(exchangeCode(cfg, { code: "c", verifier: "v", redirectUri: "r", fetchImpl: empty })).rejects.toThrow(
      /no access token/,
    );
  });
});

describe("claims", () => {
  it("prefers expires_in over the JWT exp claim", () => {
    const now = new Date("2026-07-21T00:00:00Z");
    const tok: TokenResponse = { access_token: fakeJwt({ exp: 4102444800 }), expires_in: 60 };
    expect(deriveExpiresAt(tok, now)).toBe("2026-07-21T00:01:00.000Z");
  });

  it("falls back to the JWT exp claim, then to absent", () => {
    expect(deriveExpiresAt({ access_token: fakeJwt({ exp: 4102444800 }) })).toBe("2100-01-01T00:00:00.000Z");
    expect(deriveExpiresAt({ access_token: "opaque-not-a-jwt" })).toBeUndefined();
  });

  it("reads identity from the id_token email, falling back to sub, else absent", () => {
    expect(deriveIdentity({ access_token: "a", id_token: fakeJwt({ email: "kate@harmoniqs.ai" }) })).toBe(
      "kate@harmoniqs.ai",
    );
    expect(deriveIdentity({ access_token: "a", id_token: fakeJwt({ sub: "auth0|123" }) })).toBe("auth0|123");
    expect(deriveIdentity({ access_token: "a" })).toBeUndefined();
  });
});

describe("credential write (ADR 0001)", () => {
  it("round-trips through the launcher's reader with mode 0600", () => {
    const dir = tmpRoot();
    const file = join(dir, "nested", "pasqal.json");
    writePasqalCredentials(file, { project_id: "p1", token: TOKEN, expires_at: "2099-01-01T00:00:00Z" });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const creds = readPasqalCredentials({ AMICO_PASQAL_FILE: file });
    expect(creds).toEqual({ projectId: "p1", token: TOKEN, expiresAt: "2099-01-01T00:00:00Z" });
  });

  it("the tmp file is BORN 0600 and no tmp residue survives the rename", () => {
    const dir = tmpRoot();
    const file = join(dir, "pasqal.json");
    let tmpModeAtBirth: number | undefined;
    writePasqalCredentials(file, { project_id: "p", token: TOKEN }, (from, to) => {
      tmpModeAtBirth = statSync(from).mode & 0o777; // stat BEFORE the rename hides it
      renameSync(from, to);
    });
    expect(tmpModeAtBirth).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["pasqal.json"]);
  });
});

// ── end to end: stub Auth0 + fake browser ─────────────────────────────────────

function stubTokenEndpoint(tok: Record<string, unknown>): Promise<{ base: string; server: Server; forms: URLSearchParams[] }> {
  return new Promise((resolveP) => {
    const forms: URLSearchParams[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        forms.push(new URLSearchParams(body));
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tok));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveP({ base: `http://127.0.0.1:${port}`, server, forms });
    });
  });
}

describe("pasqalConnect end to end", () => {
  it("browser callback → code exchange → credential file the launcher can read", async () => {
    const dir = tmpRoot();
    const file = join(dir, "pasqal.json");
    const stub = await stubTokenEndpoint({
      access_token: TOKEN,
      expires_in: 3600,
      refresh_token: "refresh-1",
      id_token: fakeJwt({ email: "kate@harmoniqs.ai" }),
    });
    try {
      const env = { AMICO_PASQAL_AUTH_BASE: stub.base, AMICO_PASQAL_CLIENT_ID: "cid-e2e", AMICO_PASQAL_FILE: file };
      const result = await pasqalConnect({
        projectId: "proj-e2e",
        env,
        // The "browser": parse the authorize URL, then hit the redirect back.
        browserOpen: async (url) => {
          const u = new URL(url);
          expect(u.origin).toBe(stub.base);
          const redirect = new URL(u.searchParams.get("redirect_uri") as string);
          expect(redirect.hostname).toBe("127.0.0.1");
          void browserGet(`${redirect.href}?code=code-e2e&state=${u.searchParams.get("state")}`);
          return true;
        },
      });
      expect(result.identity).toBe("kate@harmoniqs.ai");
      expect(result.file).toBe(file);
      const creds = readPasqalCredentials(env);
      expect(creds.projectId).toBe("proj-e2e");
      expect(creds.token).toBe(TOKEN);
      expect(Date.parse(creds.expiresAt as string)).toBeGreaterThan(Date.now());
      // The exchange carried the code and a verifier matching the challenge.
      expect(stub.forms[0].get("code")).toBe("code-e2e");
      expect(stub.forms[0].get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
      // Full stored shape, including the renewal + identity fields.
      const raw = JSON.parse(readFileSync(file, "utf8"));
      expect(raw.refresh_token).toBe("refresh-1");
      expect(raw.identity).toBe("kate@harmoniqs.ai");
    } finally {
      stub.server.close();
    }
  });

  it("degrades to onAuthorizeUrl when the browser fails to open, and still completes", async () => {
    const dir = tmpRoot();
    const file = join(dir, "pasqal.json");
    const stub = await stubTokenEndpoint({ access_token: TOKEN });
    try {
      const printed: string[] = [];
      const result = await pasqalConnect({
        projectId: "p",
        env: { AMICO_PASQAL_AUTH_BASE: stub.base, AMICO_PASQAL_FILE: file },
        browserOpen: async () => false, // spawn failure lane
        onAuthorizeUrl: (url) => {
          printed.push(url);
          const u = new URL(url);
          const redirect = new URL(u.searchParams.get("redirect_uri") as string);
          void browserGet(`${redirect.href}?code=c2&state=${u.searchParams.get("state")}`);
        },
      });
      expect(printed).toHaveLength(1);
      expect(existsSync(result.file)).toBe(true);
    } finally {
      stub.server.close();
    }
  });
});

describe("verb wiring", () => {
  it("requires --project with an actionable usage error", async () => {
    const { json, code } = await pasqalVerb(["connect"]);
    expect(code).toBe(64);
    expect((json as { error: string }).error).toContain("--project");
  });

  it("returns identity/expiry/file — and NEVER the token — in the ok JSON", async () => {
    const { json, code } = await pasqalVerb(["connect", "--project", "p1", "--no-open", "--timeout", "2"], {
      connectImpl: async (opts) => {
        expect(opts.projectId).toBe("p1");
        expect(opts.noOpen).toBe(true);
        expect(opts.timeoutMs).toBe(2000);
        return { file: "/x/pasqal.json", identity: "kate@harmoniqs.ai", expiresAt: "2099-01-01T00:00:00Z" };
      },
    });
    expect(code).toBe(0);
    expect(json).toEqual({
      verb: "pasqal",
      subcommand: "connect",
      ok: true,
      identity: "kate@harmoniqs.ai",
      expires_at: "2099-01-01T00:00:00Z",
      file: "/x/pasqal.json",
    });
    expect(JSON.stringify(json)).not.toContain(TOKEN);
  });

  it("maps ConfigError lanes (timeout / denial) to a token-free 64 result", async () => {
    const { json, code } = await pasqalVerb(["connect", "--project", "p"], {
      connectImpl: async () => {
        throw new ConfigError("sign-in timed out after 300s — the browser tab was closed or never finished. Try again from the Connections panel");
      },
    });
    expect(code).toBe(64);
    expect((json as { error: string }).error).toContain("timed out");
  });
});

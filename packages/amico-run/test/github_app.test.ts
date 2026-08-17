// GitHub App identity core (issue #399) — hermetic unit tests. No network:
// the fetch seam is a fake; keys are throwaway RSA pairs minted in-process
// (testKeyPair), so no PEM fixture ever ships. The token strings below are
// obvious fakes (ghs_test_…), and one assertion class explicitly checks that
// no error message can carry a real one.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  parseGithubAppConfig,
  readGithubAppConfig,
  mintAppJwt,
  verifyAppJwt,
  testKeyPair,
  isCacheFresh,
  parseInstallationToken,
  fetchInstallationToken,
  readTokenCache,
  writeTokenCache,
  ensureInstallationToken,
  resolveRealGh,
  type FetchImpl,
} from "../src/github_app.js";
import { ConfigError } from "../src/types.js";
import { tmpRoot } from "./helpers.js";

function fakeOk(token: string, expiresAt: string): { calls: number; impl: FetchImpl } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    impl: async () => {
      state.calls++;
      return { status: 201, json: async () => ({ token, expires_at: expiresAt }) };
    },
  };
}

const hourFromNow = () => new Date(Date.now() + 3600_000).toISOString();

describe("github_app config", () => {
  it("parses a valid config", () => {
    const cfg = parseGithubAppConfig({ app_id: "123456", installation_id: "789", pem_path: "/keys/amico.pem" }, "/f.json");
    expect(cfg).toEqual({ appId: "123456", installationId: "789", pemPath: "/keys/amico.pem" });
  });
  it("missing app_id/installation_id → ConfigError naming keys, never values", () => {
    expect(() => parseGithubAppConfig({ installation_id: "1", pem_path: "/p" }, "/f.json")).toThrow(/app_id.*installation_id/);
  });
  it("missing pem_path → ConfigError naming the key", () => {
    expect(() => parseGithubAppConfig({ app_id: "1", installation_id: "2" }, "/f.json")).toThrow(/pem_path/);
  });
  it("non-object → ConfigError", () => {
    expect(() => parseGithubAppConfig("nope", "/f.json")).toThrow(ConfigError);
  });
  it("readGithubAppConfig: absent file / malformed JSON / valid, via $AMICO_GITHUB_FILE", () => {
    const root = tmpRoot();
    const file = join(root, "github.json");
    const env = { AMICO_GITHUB_FILE: file };
    expect(() => readGithubAppConfig(env)).toThrow(/not connected/);
    writeFileSync(file, "{nope");
    expect(() => readGithubAppConfig(env)).toThrow(/malformed/);
    writeFileSync(file, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: join(root, "k.pem") }));
    expect(readGithubAppConfig(env).appId).toBe("1");
  });
});

describe("github_app JWT", () => {
  it("RS256 header, GitHub claim window, verifiable signature", () => {
    const { privateKeyPem, publicKey } = testKeyPair();
    const now = Date.parse("2026-08-17T12:00:00Z");
    const jwt = mintAppJwt("123456", privateKeyPem, now);
    const [h, p] = jwt
      .split(".")
      .slice(0, 2) // the third segment is the signature — binary, not JSON
      .map((x) => JSON.parse(Buffer.from(x, "base64url").toString("utf8")));
    expect(h).toEqual({ alg: "RS256", typ: "JWT" });
    expect(p.iss).toBe("123456");
    expect(p.iat).toBe(Math.floor(now / 1000) - 60);
    expect(p.exp - p.iat).toBe(180);
    expect(verifyAppJwt(jwt, publicKey)).toBe(true);
    // Deterministic tamper: flip the last signature char to a DIFFERENT char.
    const last = jwt.slice(-1);
    expect(verifyAppJwt(jwt.slice(0, -1) + (last === "A" ? "B" : "A"), publicKey)).toBe(false);
  });
  it("garbage PEM → ConfigError that never contains key material", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nnot a key\n-----END RSA PRIVATE KEY-----\n";
    try {
      mintAppJwt("1", pem);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain("not a key");
    }
  });
});

describe("github_app token cache", () => {
  it("fresh / stale / boundary, with the 5-minute reuse skew", () => {
    const now = Date.now();
    const at = (s: number) => new Date(now + s * 1000).toISOString();
    expect(isCacheFresh({ token: "t", expiresAt: at(600) }, now)).toBe(true);
    expect(isCacheFresh({ token: "t", expiresAt: at(100) }, now)).toBe(false);
    expect(isCacheFresh({ token: "t", expiresAt: at(301) }, now)).toBe(true);
    expect(isCacheFresh({ token: "t", expiresAt: "not-a-date" }, now)).toBe(false);
  });
  it("absent → undefined; corrupt → undefined (never an error); write is 0600 + round-trips", () => {
    const root = tmpRoot();
    const env = { AMICO_GITHUB_TOKEN_FILE: join(root, "tok.json") };
    expect(readTokenCache(env)).toBeUndefined();
    writeFileSync(env.AMICO_GITHUB_TOKEN_FILE, "{corrupt");
    expect(readTokenCache(env)).toBeUndefined();
    writeTokenCache({ token: "ghs_test_1", expiresAt: hourFromNow() }, env);
    expect(readTokenCache(env)).toEqual({ token: "ghs_test_1", expiresAt: expect.any(String) });
    expect(statSync(env.AMICO_GITHUB_TOKEN_FILE).mode & 0o777).toBe(0o600);
  });
});

describe("github_app mint", () => {
  it("parseInstallationToken: valid / malformed / missing keys", () => {
    expect(parseInstallationToken(JSON.stringify({ token: "ghs_test_2", expires_at: hourFromNow() })).token).toBe("ghs_test_2");
    expect(() => parseInstallationToken("<html>")).toThrow(ConfigError);
    expect(() => parseInstallationToken(JSON.stringify({ token: "x" }))).toThrow(ConfigError);
  });
  it("fetchInstallationToken: non-201 → token-free ConfigError naming the status", async () => {
    const impl: FetchImpl = async () => ({ status: 401, json: async () => ({ message: "Bad credentials" }) });
    try {
      await fetchInstallationToken("jwt", "1", impl);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toMatch(/HTTP 401/);
      expect((e as Error).message).not.toContain("Bad credentials");
    }
  });
});

describe("ensureInstallationToken", () => {
  it("mints once, caches, reuses while fresh, re-mints when stale", async () => {
    const root = tmpRoot();
    const { privateKeyPem } = testKeyPair();
    const pemFile = join(root, "k.pem");
    writeFileSync(pemFile, privateKeyPem);
    const env = {
      AMICO_GITHUB_FILE: (() => {
        const f = join(root, "github.json");
        writeFileSync(f, JSON.stringify({ app_id: "1", installation_id: "2", pem_path: pemFile }));
        return f;
      })(),
      AMICO_GITHUB_TOKEN_FILE: join(root, "tok.json"),
    };
    const fake = fakeOk("ghs_test_3", hourFromNow());
    const t1 = await ensureInstallationToken({ env, fetchImpl: fake.impl });
    expect(t1.token).toBe("ghs_test_3");
    expect(fake.calls).toBe(1);
    expect(existsSync(env.AMICO_GITHUB_TOKEN_FILE)).toBe(true);
    // Second call within freshness: served from cache, no second mint.
    await ensureInstallationToken({ env, fetchImpl: fake.impl });
    expect(fake.calls).toBe(1);
    // Expire the cache: re-mint, and the cache file is rewritten.
    const stale = { token: "ghs_test_4", expires_at: new Date(Date.now() - 1000).toISOString() };
    writeFileSync(env.AMICO_GITHUB_TOKEN_FILE, JSON.stringify(stale));
    const t2 = await ensureInstallationToken({ env, fetchImpl: fake.impl });
    expect(fake.calls).toBe(2);
    expect(readTokenCache(env)?.token).toBe(t2.token);
  });
  it("malformed config → ConfigError before any fetch", async () => {
    const root = tmpRoot();
    const env = { AMICO_GITHUB_FILE: join(root, "nope.json"), AMICO_GITHUB_TOKEN_FILE: join(root, "tok.json") };
    await expect(ensureInstallationToken({ env, fetchImpl: async () => expect.unreachable() as never })).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("resolveRealGh", () => {
  it("skips the shim's own launcher dir (recursion guard) and finds the next gh", () => {
    const root = tmpRoot();
    const own = join(root, "launcher");
    const other = join(root, "real-bin");
    mkdirSync(own, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(own, "gh"), "#!/bin/sh\nexit 99\n"); // would loop if picked
    writeFileSync(join(other, "gh"), "#!/bin/sh\nexit 0\n");
    expect(resolveRealGh(`${own}:${other}`, own)).toBe(join(other, "gh"));
  });
  it("no gh anywhere → undefined", () => {
    const root = tmpRoot();
    expect(resolveRealGh(root, join(root, "launcher"))).toBeUndefined();
  });
  it("empty PATH → undefined", () => {
    expect(resolveRealGh(undefined, undefined)).toBeUndefined();
  });
});

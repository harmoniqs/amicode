import { describe, it, expect } from "vitest";
import { mintServerPassword, serverAuthHeader, serverAuthToken, buildServerSpawnEnv } from "../src/server_auth";

// ============================================================================
// Per-boot server password (#163, ADR 0002 graft 1). The fork's route auth
// (vendored opencode, packages/opencode/src/server/auth.ts @ v1.17.3-amicode.5)
// is a verified no-op unless OPENCODE_SERVER_PASSWORD is set in the server's
// env — any localhost page could drive the amicode routes. The extension mints
// a cryptographically random password per activation and injects it into EVERY
// `opencode serve` spawn env; its own HTTP/SSE calls carry the matching Basic
// credential. In-memory only: no file, no setting, no log line.
// ============================================================================

describe("mintServerPassword (per-boot, in-memory only)", () => {
  it("mints a fresh value per activation — two mints differ (AC4)", () => {
    expect(mintServerPassword()).not.toBe(mintServerPassword());
  });
  it("is cryptographically sized and env/URL-safe (base64url, no padding)", () => {
    const pw = mintServerPassword();
    expect(pw.length).toBeGreaterThanOrEqual(43); // 32 random bytes → 43 base64url chars
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/); // survives env + auth_token query carriage unescaped
  });
});

describe("serverAuthHeader / serverAuthToken — the fork's Basic-auth contract", () => {
  // Shape verified against the fork's ServerAuth.header (default username
  // "opencode") and its auth middleware's AUTH_TOKEN_QUERY decoding — both
  // accept base64("opencode:<password>").
  it("header is Basic base64(opencode:<password>)", () => {
    expect(serverAuthHeader("s3cret")).toBe(`Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  });
  it("token (the app's ?auth_token= bootstrap) is the bare base64 pair", () => {
    expect(serverAuthToken("s3cret")).toBe(Buffer.from("opencode:s3cret").toString("base64"));
    // the two carriages must decode to the SAME credential
    expect(serverAuthHeader("s3cret")).toBe(`Basic ${serverAuthToken("s3cret")}`);
  });
  it("tolerates passwords containing colons (fork splits on the FIRST colon)", () => {
    const decoded = Buffer.from(serverAuthToken("se:cr:et"), "base64").toString();
    expect(decoded.slice(decoded.indexOf(":") + 1)).toBe("se:cr:et");
  });
});

describe("buildServerSpawnEnv — the env keys the extension ADDS to the spawn", () => {
  const opts = { amicoRunBinDir: "/ext/bin", configContent: '{"instructions":["/a/AGENTS.md"]}', serverPassword: "pw" };
  it("adds EXACTLY PATH + OPENCODE_CONFIG_CONTENT + OPENCODE_SERVER_PASSWORD (AC1)", () => {
    // Exactly the ADDED keys — the server inherits the host env by platform
    // design (ServerManager spreads process.env under these), so full-env
    // equality is a known-wrong assertion; the contract is what WE add.
    expect(Object.keys(buildServerSpawnEnv(opts)).sort()).toEqual([
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_PASSWORD",
      "PATH",
    ]);
  });
  it("carries a NON-EMPTY password — route auth must not stay a no-op (AC2)", () => {
    const env = buildServerSpawnEnv({ ...opts, serverPassword: mintServerPassword() });
    expect(env.OPENCODE_SERVER_PASSWORD.length).toBeGreaterThan(0);
    // and it is the minted value verbatim — no transformation on the way in
    expect(buildServerSpawnEnv(opts).OPENCODE_SERVER_PASSWORD).toBe("pw");
  });
  it("prepends amicoRunBinDir to PATH so the launcher resolves (existing spawn behavior)", () => {
    expect(buildServerSpawnEnv(opts).PATH).toBe(`/ext/bin:${process.env.PATH ?? ""}`);
    // no launcher dir → host PATH untouched (chat can author; solves warn at boot)
    expect(buildServerSpawnEnv({ ...opts, amicoRunBinDir: undefined }).PATH).toBe(process.env.PATH ?? "");
  });
  it("passes the config content through verbatim (the instructions/permission merge)", () => {
    expect(buildServerSpawnEnv(opts).OPENCODE_CONFIG_CONTENT).toBe(opts.configContent);
  });
});

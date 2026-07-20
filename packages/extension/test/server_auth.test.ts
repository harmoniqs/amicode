import { describe, it, expect } from "vitest";
import { mintServerPassword, serverAuthHeader, serverAuthToken, buildServerSpawnEnv } from "../src/server_auth";
import { buildOpencodeConfigContent } from "../src/opencode_config";

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
  it("honors a host-env OPENCODE_SERVER_USERNAME (the spawned server inherits it — fork parity)", () => {
    // The fork resolves its username from OPENCODE_SERVER_USERNAME ?? "opencode";
    // the server inherits the host env, so a dev override there must land in our
    // credential too or every extension call 401s.
    const prev = process.env.OPENCODE_SERVER_USERNAME;
    process.env.OPENCODE_SERVER_USERNAME = "alice";
    try {
      expect(serverAuthToken("pw")).toBe(Buffer.from("alice:pw").toString("base64"));
      expect(serverAuthHeader("pw")).toBe(`Basic ${Buffer.from("alice:pw").toString("base64")}`);
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
      else process.env.OPENCODE_SERVER_USERNAME = prev;
    }
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
  it("carries AMICO_PYTHON iff amicoPython is set — absent (never empty) otherwise, so the fork's python3 fallback is untouched", () => {
    // The fork's validator spawn resolves $AMICO_PYTHON → bare `python3`; the
    // provisioned venv interpreter rides this seam so no respawn path drops it.
    const withPython = buildServerSpawnEnv({ ...opts, amicoPython: "/ops/venvs/pasqal-connector/bin/python" });
    expect(withPython.AMICO_PYTHON).toBe("/ops/venvs/pasqal-connector/bin/python");
    expect(Object.keys(withPython).sort()).toEqual([
      "AMICO_PYTHON",
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_PASSWORD",
      "PATH",
    ]);
    // unset branch byte-identical to pre-provisioning behavior (AC7)
    expect("AMICO_PYTHON" in buildServerSpawnEnv(opts)).toBe(false);
    expect("AMICO_PYTHON" in buildServerSpawnEnv({ ...opts, amicoPython: undefined })).toBe(false);
  });
  it("passes the config content through verbatim (the instructions/permission merge)", () => {
    expect(buildServerSpawnEnv(opts).OPENCODE_CONFIG_CONTENT).toBe(opts.configContent);
  });
});

describe("no-persist / no-log seams (AC3) — the spawn env is the ONLY carriage", () => {
  // The channel scans live with the transports: server_manager.test.ts sweeps
  // everything ServerManager writes across a real spawned boot, and
  // sse_client.test.ts sweeps the SSE channel; chat_panel.test.ts pins that
  // the raw password never enters the webview html. These guard the two
  // remaining seams a future edit could leak through.
  it("mintServerPassword never writes the host process env (in-memory only)", () => {
    const prev = process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD;
    try {
      mintServerPassword();
      expect(process.env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.OPENCODE_SERVER_PASSWORD = prev;
    }
  });
  it("the password never enters OPENCODE_CONFIG_CONTENT (dumpable via `opencode debug config`)", () => {
    // Poison the env like the D11 key guard above it in opencode_config.test.ts:
    // if the config builder ever starts sourcing the password, this reds.
    const SENTINEL = mintServerPassword();
    const prev = process.env.OPENCODE_SERVER_PASSWORD;
    process.env.OPENCODE_SERVER_PASSWORD = SENTINEL;
    try {
      const content = buildOpencodeConfigContent(
        "/abs/AGENTS.md",
        "/ext/templates/t.jl",
        "/home/u/.amico/runs/default",
      );
      expect(content).not.toContain(SENTINEL);
    } finally {
      if (prev === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = prev;
    }
  });
});

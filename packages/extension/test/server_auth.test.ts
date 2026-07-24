import { describe, it, expect } from "vitest";
import {
  mintServerPassword,
  serverAuthHeader,
  serverAuthToken,
  buildServerSpawnEnv,
  buildTelemetryEnv,
  telemetryGateOpen,
  TELEMETRY_ENV_KEYS,
  type TelemetryContext,
} from "../src/server_auth";
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

// ============================================================================
// Run-corpus telemetry env (feat/telemetry-bearer-auth). opencode's OTLP
// exporter is dormant unless OTEL_EXPORTER_OTLP_ENDPOINT is set; the extension
// wakes it by ADDING env vars to the spawn — but ONLY behind the consent gate
// (enabled + consent answered + endpoint + a cloud bearer token). Auth is now
// `Authorization: Bearer <token from ~/.amico/cloud.json>` (REPLACES the shared
// x-amicode-key); identity = the submitter the ingest derives from the token
// server-side, so x-amicode-user is gone too. Only x-amicode-session remains.
// The var/header/attr names are a binding interface contract with the AWS ingest
// Lambda (BEARER_AUTH_SPEC.md).
// ============================================================================

describe("telemetryGateOpen — the ONE predicate the exporter env + span-generation flag share", () => {
  const full: TelemetryContext = {
    enabled: true,
    consentAnswered: true,
    endpoint: "https://ingest.example.com",
    token: "amico_tok",
    sessionId: "s",
    userId: "u",
    repo: "r",
    gitRef: "main",
  };
  it("true only when enabled + consent + endpoint + token ALL hold", () => {
    expect(telemetryGateOpen(full)).toBe(true);
  });
  it("false if ANY axis is missing (so config flag and exporter env can never diverge)", () => {
    expect(telemetryGateOpen(undefined)).toBe(false);
    expect(telemetryGateOpen({ ...full, enabled: false })).toBe(false);
    expect(telemetryGateOpen({ ...full, consentAnswered: false })).toBe(false);
    expect(telemetryGateOpen({ ...full, endpoint: "" })).toBe(false);
    expect(telemetryGateOpen({ ...full, token: "" })).toBe(false);
  });
});

describe("buildTelemetryEnv — the consent gate (4-axis truth table)", () => {
  // A fully-eligible context: all FOUR gate conditions hold (enabled + consent
  // answered + endpoint + non-empty cloud token). Flipping each off in turn must
  // close the gate; only the all-true row injects.
  const full: TelemetryContext = {
    enabled: true,
    consentAnswered: true,
    endpoint: "https://ingest.example.com",
    token: "amico_secrettoken",
    sessionId: "sess-123",
    userId: "user-abc",
    repo: "amicode",
    gitRef: "feat/x",
  };

  it("enabled + consent + endpoint + token → injects the full OTLP key set", () => {
    expect(Object.keys(buildTelemetryEnv(full)).sort()).toEqual([...TELEMETRY_ENV_KEYS].sort());
  });
  it("telemetry disabled → omits ALL (exporter stays dormant)", () => {
    expect(buildTelemetryEnv({ ...full, enabled: false })).toEqual({});
  });
  it("consent NOT answered → omits ALL, even though enabled defaults on (no transmit-before-consent)", () => {
    expect(buildTelemetryEnv({ ...full, consentAnswered: false })).toEqual({});
  });
  it("endpoint unconfigured → omits ALL", () => {
    expect(buildTelemetryEnv({ ...full, endpoint: "" })).toEqual({});
  });
  it("cloud token missing → omits ALL (no token-less 401-spam that looks on but captures nothing)", () => {
    expect(buildTelemetryEnv({ ...full, token: "" })).toEqual({});
  });
  it("undefined context → omits ALL", () => {
    expect(buildTelemetryEnv(undefined)).toEqual({});
  });
});

describe("buildTelemetryEnv — the interface contract (names, header/attr encoding)", () => {
  const full: TelemetryContext = {
    enabled: true,
    consentAnswered: true,
    endpoint: "https://ingest.example.com",
    token: "amico_secrettoken",
    sessionId: "sess-123",
    userId: "user-abc",
    repo: "amicode",
    gitRef: "feat/x",
  };

  it("endpoint passes through verbatim (the resolver already stripped any trailing slash)", () => {
    expect(buildTelemetryEnv(full).OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://ingest.example.com");
  });
  it("headers are Bearer auth + x-amicode-session ONLY, VERBATIM (not URL-encoded)", () => {
    expect(buildTelemetryEnv(full).OTEL_EXPORTER_OTLP_HEADERS).toBe(
      "Authorization=Bearer amico_secrettoken,x-amicode-session=sess-123",
    );
    // the token rides raw in the Authorization header value (no percent-encoding)
    expect(buildTelemetryEnv({ ...full, token: "amico_deadBEEF" }).OTEL_EXPORTER_OTLP_HEADERS).toContain(
      "Authorization=Bearer amico_deadBEEF",
    );
  });
  it("DROPS the shared x-amicode-key and x-amicode-user headers (identity = verified submitter server-side)", () => {
    const headers = buildTelemetryEnv(full).OTEL_EXPORTER_OTLP_HEADERS;
    expect(headers).not.toContain("x-amicode-key");
    expect(headers).not.toContain("x-amicode-user");
    // and it is exactly the two remaining pairs, nothing else
    expect(headers.split(",")).toHaveLength(2);
  });
  it("resource attributes carry the amicode.* keys with URL-ENCODED values + fixed client=vscode", () => {
    expect(buildTelemetryEnv(full).OTEL_RESOURCE_ATTRIBUTES).toBe(
      // git_ref "feat/x" → "feat%2Fx" so the "/" survives the comma-delimited list
      "amicode.user=user-abc,amicode.session=sess-123,amicode.repo=amicode,amicode.git_ref=feat%2Fx,amicode.client=vscode",
    );
  });
  it("URL-encodes attribute values that contain commas/spaces (else they'd corrupt the list)", () => {
    const attrs = buildTelemetryEnv({ ...full, repo: "my repo, v2" }).OTEL_RESOURCE_ATTRIBUTES;
    expect(attrs).toContain("amicode.repo=my%20repo%2C%20v2");
    // still exactly five attributes despite the comma in the value
    expect(attrs.split(",")).toHaveLength(5);
  });
  it("pins OTEL_EXPORTER_OTLP_COMPRESSION=none (block double-gzip / keep replay byte-faithful)", () => {
    expect(buildTelemetryEnv(full).OTEL_EXPORTER_OTLP_COMPRESSION).toBe("none");
  });
  it("caps attribute value length + batch size for the ingest's 6 MB request limit", () => {
    const env = buildTelemetryEnv(full);
    // honored by the fork's tracer (reconfigureLimits → spanLimits; BatchSpanProcessor env default)
    expect(env.OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT).toBe("16384");
    expect(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE).toBe("64");
  });
});

describe("buildServerSpawnEnv — telemetry integration (gate applied through the one builder)", () => {
  const base = { amicoRunBinDir: "/ext/bin", configContent: "{}", serverPassword: "pw" };
  const full: TelemetryContext = {
    enabled: true,
    consentAnswered: true,
    endpoint: "https://ingest.example.com",
    token: "amico_tok",
    sessionId: "s",
    userId: "u",
    repo: "r",
    gitRef: "main",
  };
  it("gate open → the base three keys PLUS the full OTLP key set", () => {
    const env = buildServerSpawnEnv({ ...base, telemetry: full });
    for (const k of TELEMETRY_ENV_KEYS) expect(env[k]).toBeDefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("pw"); // the password is never dropped
  });
  it("gate closed (consent unanswered) → NO OTLP key leaks into the spawn env", () => {
    const env = buildServerSpawnEnv({ ...base, telemetry: { ...full, consentAnswered: false } });
    for (const k of TELEMETRY_ENV_KEYS) expect(k in env).toBe(false);
  });
  it("no telemetry opt at all → identical to the pre-telemetry builder (three keys)", () => {
    expect(Object.keys(buildServerSpawnEnv(base)).sort()).toEqual([
      "OPENCODE_CONFIG_CONTENT",
      "OPENCODE_SERVER_PASSWORD",
      "PATH",
    ]);
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

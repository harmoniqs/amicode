import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  submitCloudCredential,
  runSetCloudKeyCommand,
  DEFAULT_CLOUD_URL,
  CLOUD_CONNECTION_ID,
  CREDENTIAL_ROUTE,
  SERVER_DOWN_MESSAGE,
  type CloudKeyUi,
  type SubmitOutcome,
} from "../src/cloud_key";

// Spy-wrap every node:fs export (calls through to the real implementation) so
// the AC1/AC3 tests can assert the command path performs ZERO writes anywhere —
// node:fs properties are non-configurable, so vi.spyOn can't wrap them directly.
vi.mock("node:fs", { spy: true });

const SECRET = "sk-super-secret-token-abc123";
const SERVER_URL = "http://127.0.0.1:43117/";
const BOOT_AUTH = "Basic b3BlbmNvZGU6dGVzdC1ib290LXBhc3N3b3Jk";

/** A one-shot fetch stub returning `status` + JSON `body`, recording the call. */
function routeFetch(
  status: number,
  body: unknown,
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new Error("no body");
        return body;
      },
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const connectedBody = { ok: true, connection: { id: CLOUD_CONNECTION_ID, state: "connected" } };

// ============================================================================
// submitCloudCredential — the wire contract with the fork's connections route
// (AC1: the command's ONLY side effect is this one POST; the server owns
// validate → write → HP flip).
// ============================================================================

describe("submitCloudCredential — request shape (AC1)", () => {
  it("POSTs once to the connections credential route on the LOCAL server", async () => {
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("http://127.0.0.1:43117/amicode/connections/credential");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("carries the #163 boot credential in Authorization — NOT the cloud token", async () => {
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl,
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(BOOT_AUTH);
    expect(headers["Authorization"]).not.toContain(SECRET);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("body is {id: company-compute, base_url (trailing-slash trimmed), token} — token ONLY in the body, never the URL", async () => {
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com///",
      token: SECRET,
      fetchImpl,
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      id: CLOUD_CONNECTION_ID,
      base_url: "https://api.example.com",
      token: SECRET,
    });
    expect(calls[0].url).not.toContain(SECRET);
  });
});

describe("submitCloudCredential — response mapping", () => {
  const submit = (status: number, body: unknown): Promise<SubmitOutcome> =>
    submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl: routeFetch(status, body).fetchImpl,
    });

  it("state connected, no error → connected (the #167 warning-free path)", async () => {
    expect((await submit(200, connectedBody)).kind).toBe("connected");
  });

  it("state connected + error field (hp-flip warning) → connected-warning, NOT clean success (review finding 1)", async () => {
    const r = await submit(200, {
      ok: true,
      connection: { id: CLOUD_CONNECTION_ID, state: "connected" },
      error: "HP switch could not be requested — no active session",
    });
    expect(r.kind).toBe("connected-warning");
    if (r.kind === "connected-warning") expect(r.message).toContain("HP switch");
  });

  it("state invalid → invalid, 'rejected' copy", async () => {
    const r = await submit(200, { ok: false, connection: { id: CLOUD_CONNECTION_ID, state: "invalid" }, error: "401" });
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") expect(r.message).toMatch(/rejected/);
  });

  it("state unreachable → error with copy distinct from the invalid class", async () => {
    const r = await submit(200, { ok: false, connection: { id: CLOUD_CONNECTION_ID, state: "unreachable" } });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).toMatch(/unreachable|reach/i);
      expect(r.message).not.toMatch(/rejected/);
    }
  });

  it("state error → error, surfacing the server's (token-free) detail", async () => {
    const r = await submit(200, {
      ok: false,
      connection: { id: CLOUD_CONNECTION_ID, state: "error" },
      error: "Solve Service answered HTTP 500",
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("HTTP 500");
  });

  it("local 401/403 (boot credential refused) → error with restart-shaped copy, not a save", async () => {
    const r = await submit(401, undefined);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toMatch(/401|refused/i);
  });

  it("unparseable body → error naming the HTTP status", async () => {
    const r = await submit(200, undefined);
    expect(r.kind).toBe("error");
    if (r.kind === "error") expect(r.message).toContain("200");
  });

  it("transport failure (local server down) → server-down with the actionable copy (AC4)", async () => {
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:43117");
    }) as unknown as typeof fetch;
    const r = await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl: throwingFetch,
    });
    expect(r.kind).toBe("server-down");
    if (r.kind === "server-down") expect(r.message).toBe(SERVER_DOWN_MESSAGE);
  });
});

describe("submitCloudCredential — token never leaks (review finding 5, adversarial)", () => {
  it("server error text embedding the token is redacted before surfacing", async () => {
    const { fetchImpl } = routeFetch(200, {
      ok: false,
      connection: { id: CLOUD_CONNECTION_ID, state: "error" },
      error: `Solve Service rejected bearer ${SECRET} (HTTP 500)`, // adversarial echo
    });
    const r = await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl,
    });
    expect(r.kind).toBe("error");
    if (r.kind === "error") {
      expect(r.message).not.toContain(SECRET);
      expect(r.message).toContain("HTTP 500"); // redaction, not blanket suppression
    }
  });

  it("hp-flip warning text embedding the token is redacted too", async () => {
    const { fetchImpl } = routeFetch(200, {
      ok: true,
      connection: { id: CLOUD_CONNECTION_ID, state: "connected" },
      error: `HP switch failed for ${SECRET}`,
    });
    const r = await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl,
    });
    expect(r.kind).toBe("connected-warning");
    if (r.kind === "connected-warning") expect(r.message).not.toContain(SECRET);
  });

  it("a thrown transport error embedding the token never surfaces it", async () => {
    const throwingFetch = (async () => {
      throw new Error(`ECONNREFUSED while sending ${SECRET}`); // adversarial echo
    }) as unknown as typeof fetch;
    const r = await submitCloudCredential({
      serverUrl: SERVER_URL,
      authorization: BOOT_AUTH,
      baseUrl: "https://api.example.com",
      token: SECRET,
      fetchImpl: throwingFetch,
    });
    expect(r.kind).toBe("server-down");
    if (r.kind === "server-down") expect(r.message).not.toContain(SECRET);
  });
});

// ============================================================================
// runSetCloudKeyCommand — the command core extension.ts wires to vscode.
// ============================================================================

/** Recording UI stub. `key` = what the input box resolves with. */
function uiStub(key: string | undefined): {
  ui: CloudKeyUi;
  inputOptions: Array<{ prompt: string; password: boolean; ignoreFocusOut: boolean }>;
  progressTitles: string[];
  info: string[];
  warn: string[];
  error: string[];
} {
  const rec = {
    inputOptions: [] as Array<{ prompt: string; password: boolean; ignoreFocusOut: boolean }>,
    progressTitles: [] as string[],
    info: [] as string[],
    warn: [] as string[],
    error: [] as string[],
  };
  const ui: CloudKeyUi = {
    showInputBox: (options) => {
      rec.inputOptions.push(options);
      return Promise.resolve(key);
    },
    withProgress: (title, task) => {
      rec.progressTitles.push(title);
      return task();
    },
    showInformationMessage: (m) => rec.info.push(m),
    showWarningMessage: (m) => rec.warn.push(m),
    showErrorMessage: (m) => rec.error.push(m),
  };
  return { ui, ...rec };
}

const SERVER = { url: SERVER_URL, authorization: BOOT_AUTH };

describe("runSetCloudKeyCommand — UX preserved (AC2)", () => {
  it("prompts with a password-masked, focus-proof input box", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(200, connectedBody).fetchImpl });
    expect(s.inputOptions.length).toBe(1);
    expect(s.inputOptions[0].password).toBe(true);
    expect(s.inputOptions[0].ignoreFocusOut).toBe(true);
    expect(s.inputOptions[0].prompt).toMatch(/cloud API key/i);
  });

  it("shows a progress notification while the server round-trip runs", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(200, connectedBody).fetchImpl });
    expect(s.progressTitles.length).toBe(1);
    expect(s.progressTitles[0]).toMatch(/Amicode/);
  });

  it("empty / cancelled input → no request, no toast", async () => {
    for (const key of [undefined, "", "   "]) {
      const s = uiStub(key);
      const { fetchImpl, calls } = routeFetch(200, connectedBody);
      await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl });
      expect(calls.length).toBe(0);
      expect([...s.info, ...s.warn, ...s.error]).toEqual([]);
    }
  });

  it("per-class toasts are pairwise distinct (success / warning / invalid / unreachable / server-down)", async () => {
    const messages: string[] = [];
    const run = async (status: number, body: unknown): Promise<void> => {
      const s = uiStub(SECRET);
      await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(status, body).fetchImpl });
      messages.push(...s.info, ...s.warn, ...s.error);
    };
    await run(200, connectedBody); // success
    await run(200, { ok: true, connection: { state: "connected" }, error: "HP switch skipped" }); // warning
    await run(200, { ok: false, connection: { state: "invalid" } }); // invalid
    await run(200, { ok: false, connection: { state: "unreachable" } }); // unreachable
    const down = uiStub(SECRET);
    await runSetCloudKeyCommand({ ui: down.ui, cloudUrl: "", server: undefined }); // server down
    messages.push(...down.info, ...down.warn, ...down.error);
    expect(messages.length).toBe(5);
    expect(new Set(messages).size).toBe(5);
  });

  it("no surfaced message in ANY class ever contains the token (review finding 5)", async () => {
    const bodies: Array<unknown> = [
      connectedBody,
      { ok: true, connection: { state: "connected" }, error: `warn ${SECRET}` },
      { ok: false, connection: { state: "invalid" }, error: `bad ${SECRET}` },
      { ok: false, connection: { state: "unreachable" }, error: `lost ${SECRET}` },
      { ok: false, connection: { state: "error" }, error: `boom ${SECRET}` },
    ];
    for (const body of bodies) {
      const s = uiStub(SECRET);
      await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(200, body).fetchImpl });
      for (const m of [...s.info, ...s.warn, ...s.error]) expect(m).not.toContain(SECRET);
    }
  });
});

describe("runSetCloudKeyCommand — outcome rendering", () => {
  it("connected → success toast mentioning High-Performance (Piccolissimo + Altissimo)", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(200, connectedBody).fetchImpl });
    expect(s.info.length).toBe(1);
    expect(s.info[0]).toMatch(/High-Performance/);
    expect(s.info[0]).toMatch(/Piccolissimo/);
    expect(s.warn).toEqual([]);
    expect(s.error).toEqual([]);
  });

  it("connected + hp-flip warning → WARNING toast, never the success toast (review finding 1)", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({
      ui: s.ui,
      cloudUrl: "",
      server: SERVER,
      fetchImpl: routeFetch(200, {
        ok: true,
        connection: { state: "connected" },
        error: "HP switch could not be requested — no active session",
      }).fetchImpl,
    });
    expect(s.info).toEqual([]); // the old command's bug: success toast over a failed flip
    expect(s.warn.length).toBe(1);
    expect(s.warn[0]).toMatch(/HP/);
    expect(s.error).toEqual([]);
  });

  it("invalid → error toast with 'rejected' copy", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({
      ui: s.ui,
      cloudUrl: "",
      server: SERVER,
      fetchImpl: routeFetch(200, { ok: false, connection: { state: "invalid" } }).fetchImpl,
    });
    expect(s.info).toEqual([]);
    expect(s.error.length).toBe(1);
    expect(s.error[0]).toMatch(/rejected/);
  });

  it("server not running (no ready URL) → actionable error, zero HTTP calls (AC4)", async () => {
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: undefined, fetchImpl });
    expect(calls.length).toBe(0);
    expect(s.error.length).toBe(1);
    expect(s.error[0]).toContain("Amico server not running");
    expect(s.error[0]).toMatch(/panel/i);
  });

  it("server up but connection refused mid-flight → the same actionable server-down class (AC4)", async () => {
    const s = uiStub(SECRET);
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: throwingFetch });
    expect(s.error.length).toBe(1);
    expect(s.error[0]).toContain("Amico server not running");
  });
});

describe("runSetCloudKeyCommand — single write path, single flip path (AC1 + AC3)", () => {
  let opsDir: string;
  let homeDir: string;
  let savedOps: string | undefined;

  beforeEach(() => {
    opsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudkey-ops-"));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudkey-home-"));
    savedOps = process.env.AMICODE_OPS_DIR;
    process.env.AMICODE_OPS_DIR = opsDir; // where solver-mode.json / entitlements.toml would land
  });

  afterEach(() => {
    if (savedOps === undefined) delete process.env.AMICODE_OPS_DIR;
    else process.env.AMICODE_OPS_DIR = savedOps;
    vi.restoreAllMocks();
    fs.rmSync(opsDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it("a successful connect performs exactly ONE HTTP call and ZERO filesystem writes", async () => {
    vi.clearAllMocks(); // drop the temp-dir setup calls; the command runs on a clean slate
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl });
    expect(calls.length).toBe(1); // the POST to the seam — the whole side-effect budget
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.chmodSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.appendFileSync)).not.toHaveBeenCalled();
  });

  it("no cloud.json / entitlements.toml / solver-mode.json appears anywhere the old command wrote (AC3: server owns the flip)", async () => {
    const s = uiStub(SECRET);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl: routeFetch(200, connectedBody).fetchImpl });
    expect(fs.readdirSync(opsDir)).toEqual([]); // no solver-mode.json, no entitlements.toml
    expect(fs.readdirSync(homeDir)).toEqual([]); // no ~/.amico/cloud.json equivalent
    expect(fs.existsSync(path.join(opsDir, "solver-mode.json"))).toBe(false);
    expect(fs.existsSync(path.join(opsDir, "entitlements.toml"))).toBe(false);
  });

  it("rotation while already HP: still one POST, still zero client-side flip writes (review finding 3 — server idempotence owns it)", async () => {
    // Simulate an existing HP state on disk; the command must not read, re-grant,
    // or re-request anything around it.
    fs.writeFileSync(path.join(opsDir, "solver-mode.json"), JSON.stringify({ mode: "hp", status: "ready" }));
    const before = fs.readFileSync(path.join(opsDir, "solver-mode.json"), "utf8");
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: SERVER, fetchImpl });
    expect(calls.length).toBe(1);
    expect(fs.readFileSync(path.join(opsDir, "solver-mode.json"), "utf8")).toBe(before); // untouched
    expect(fs.existsSync(path.join(opsDir, "entitlements.toml"))).toBe(false);
  });

  it("server down: zero HTTP calls AND zero writes — no fallback to a direct file write (AC4)", async () => {
    vi.clearAllMocks();
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "", server: undefined, fetchImpl });
    expect(calls.length).toBe(0);
    expect(vi.mocked(fs.writeFileSync)).not.toHaveBeenCalled();
    expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    expect(fs.readdirSync(opsDir)).toEqual([]);
  });
});

describe("cloud URL resolution (review finding 6 — single-sourced)", () => {
  it("DEFAULT_CLOUD_URL is the production Solve Service base URL", () => {
    expect(DEFAULT_CLOUD_URL).toBe("https://qy2gwqy5s5.execute-api.us-east-1.amazonaws.com");
  });

  it("an empty amicode.cloudUrl setting falls back to DEFAULT_CLOUD_URL in the POSTed base_url", async () => {
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "   ", server: SERVER, fetchImpl });
    expect(JSON.parse(String(calls[0].init?.body)).base_url).toBe(DEFAULT_CLOUD_URL);
  });

  it("a configured amicode.cloudUrl wins over the default", async () => {
    const s = uiStub(SECRET);
    const { fetchImpl, calls } = routeFetch(200, connectedBody);
    await runSetCloudKeyCommand({ ui: s.ui, cloudUrl: "https://staging.example.com/", server: SERVER, fetchImpl });
    expect(JSON.parse(String(calls[0].init?.body)).base_url).toBe("https://staging.example.com");
  });

  it("package.json no longer duplicates the production URL — cloud_key.ts is the single source", () => {
    const pkg = fs.readFileSync(path.resolve(__dirname, "..", "package.json"), "utf8");
    expect(pkg).not.toContain("qy2gwqy5s5"); // the URL lives ONLY in DEFAULT_CLOUD_URL
    const props = (JSON.parse(pkg) as { contributes: { configuration: { properties: Record<string, { default?: unknown; description?: string }> } } })
      .contributes.configuration.properties;
    expect(props["amicode.cloudUrl"].default).toBe("");
    expect(props["amicode.cloudUrl"].description).toMatch(/built-in production endpoint/i);
  });
});

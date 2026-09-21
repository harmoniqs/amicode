// fleet_enroll_verb.test.ts (#1319) — the enroll primitive: `amico fleet
// enroll`. A NEW suite, DISTINCT from the session-registry fleet_verb.test.ts
// (different domain: enroll writes fleet.json + a roster row; the registry
// writes neither). Each AC gets its own tracer-bullet cycle.
//
// The stub host below mirrors the #1318 host contract (GET/POST /amicode/roster
// + GET /global/health) as a loopback server, so verify-attach and roster
// registration run the REAL fetch path — amico-run cannot import the extension's
// test/support/stub_hub.ts, so this is its sibling.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { parseRosterRow, type RosterRow } from "@amicode/schema";
import {
  fleetEnroll,
  parseJoinToken,
  type FleetEnrollDeps,
  type JoinToken,
  type EnrollResult,
} from "../src/fleet_enroll_verb.js";

// VerbResult.json is typed `unknown`; this is the enroll verb's structured shape.
interface EnrollJson {
  ok: boolean;
  result?: EnrollResult;
  join_token?: JoinToken;
  join_token_path?: string;
  cause?: string;
  fix?: string;
  errors?: string[];
  stage?: string;
  wrote_nothing?: boolean;
  roster_health?: string;
  installer_ok?: boolean;
}
const j = (r: { json: unknown }): EnrollJson => r.json as EnrollJson;

// ── a loopback stub host (the #1318 roster contract + /global/health) ──────────
interface EnrollStubOptions {
  version?: string; // GET /global/health → version (default v1.18.29)
  requireAuth?: string; // 401 unless Authorization matches
  healthStatus?: number; // force a non-200 on /global/health (auth-rejected etc.)
  dead?: boolean; // never listen (transport-down); url points at a closed port
}
interface EnrollStub {
  url: string;
  host: string;
  port: number;
  rosterRows: () => RosterRow[];
  rosterPosts: () => RosterRow[];
  healthHits: () => number;
  stop: () => Promise<void>;
}

async function startEnrollStub(opts: EnrollStubOptions = {}): Promise<EnrollStub> {
  const version = opts.version ?? "v1.18.29";
  const rows: RosterRow[] = [];
  const posts: RosterRow[] = [];
  let health = 0;
  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const server = http.createServer((req, res) => {
    if (opts.requireAuth !== undefined && req.headers.authorization !== opts.requireAuth) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
      health += 1;
      if (opts.healthStatus && opts.healthStatus !== 200) {
        res.writeHead(opts.healthStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version }));
      return;
    }
    if (req.method === "GET" && (req.url === "/amicode/roster" || req.url?.startsWith("/amicode/roster?"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema_version: 1, rows }));
      return;
    }
    if (req.method === "POST" && (req.url === "/amicode/roster" || req.url?.startsWith("/amicode/roster?"))) {
      void readBody(req).then((raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad_request: body must be JSON" }));
          return;
        }
        const row = parseRosterRow(parsed);
        if (!row.ok) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "bad_request: not a well-formed roster row" }));
          return;
        }
        posts.push(row.row);
        // single-writer upsert by machine_id (mirrors #1318 upsertRosterRow)
        const i = rows.findIndex((r) => r.machine_id === row.row.machine_id);
        if (i >= 0) rows[i] = row.row;
        else rows.push(row.row);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, machine_id: row.row.machine_id, error: null }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  if (opts.dead) {
    // Bind then immediately close: the port is known but nothing listens →
    // fetch fails with ECONNREFUSED (the honest transport-down probe).
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
    });
    await new Promise<void>((r) => server.close(() => r()));
    return {
      url: `http://127.0.0.1:${port}`,
      host: "127.0.0.1",
      port,
      rosterRows: () => rows,
      rosterPosts: () => posts,
      healthHits: () => health,
      stop: async () => {},
    };
  }
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    rosterRows: () => rows,
    rosterPosts: () => posts,
    healthHits: () => health,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// A dep bundle that records every side effect and injects a fake identity, so a
// cycle can assert order + gating without touching the real machine.
interface Recorder {
  deps: FleetEnrollDeps;
  fleetWrites: { config: unknown; path: string }[];
  joinTokenWrites: { path: string; token: JoinToken }[];
  installerCalls: string[];
  transportSets: string[];
  engine: { spawns: number };
}
function recorder(over: Partial<FleetEnrollDeps> = {}): Recorder {
  const fleetWrites: { config: unknown; path: string }[] = [];
  const joinTokenWrites: { path: string; token: JoinToken }[] = [];
  const installerCalls: string[] = [];
  const transportSets: string[] = [];
  const engine = { spawns: 0 };
  const deps: FleetEnrollDeps = {
    machineId: () => "machine-abc",
    machineName: () => "workbench",
    capabilities: () => [],
    clientVersion: () => "v1.18.29",
    now: () => "2026-01-01T00:00:00.000Z",
    fleetConfigPath: "/tmp/nonexistent-enroll/fleet.json",
    writeFleetConfig: (config, path) => fleetWrites.push({ config, path }),
    writeJoinToken: (path, token) => joinTokenWrites.push({ path, token }),
    joinTokenOutPath: "/tmp/nonexistent-enroll/join-token.json",
    runInstaller: (role) => {
      installerCalls.push(role);
      return { ok: true };
    },
    setTransport: (kind) => transportSets.push(kind),
    mintFleetToken: () => "FLEET-SECRET",
    spawnEngine: () => {
      engine.spawns += 1;
    },
    retryDelayMs: [0, 0, 0],
    ...over,
  };
  return { deps, fleetWrites, joinTokenWrites, installerCalls, transportSets, engine };
}

const stubs: EnrollStub[] = [];
afterEach(async () => {
  while (stubs.length) await stubs.pop()!.stop();
});
async function stub(opts?: EnrollStubOptions): Promise<EnrollStub> {
  const s = await startEnrollStub(opts);
  stubs.push(s);
  return s;
}

describe("amico fleet enroll --as-server (#1319 AC1)", () => {
  it("provisions the hub service, mints the Fleet token, and emits a join token bundling {canonical, fleet_token, transport_hint, pin_version}", async () => {
    const rec = recorder();
    const r = await fleetEnroll(
      ["--as-server", "--host", "hub.example", "--port", "4096", "--ssh-alias", "hub", "--transport-hint", "ssh"],
      rec.deps,
    );
    expect(r.code).toBe(0);
    expect(j(r).ok).toBe(true);

    // fleet.json written role=server + canonical
    expect(rec.fleetWrites).toHaveLength(1);
    expect((rec.fleetWrites[0].config as { role: string }).role).toBe("server");
    expect((rec.fleetWrites[0].config as { canonical: unknown }).canonical).toEqual({
      host: "hub.example",
      port: 4096,
      sshAlias: "hub",
    });

    // the durable hub service is provisioned via the installer (server role)
    expect(rec.installerCalls).toContain("server");

    // the Fleet token is minted and the join token emitted with the 4 fields
    expect(rec.joinTokenWrites).toHaveLength(1);
    const token = rec.joinTokenWrites[0].token;
    expect(token.canonical).toEqual({ host: "hub.example", port: 4096, sshAlias: "hub" });
    expect(token.fleet_token).toBe("FLEET-SECRET");
    expect(token.transport_hint).toBe("ssh");
    expect(token.pin_version).toBe("v1.18.29");

    // the emitted join token is also surfaced on the result for #1320 to hand out
    expect(j(r).join_token).toEqual(token);
  });
});

// A ready-to-redeem join token pointing at a stub host.
function tokenFor(s: EnrollStub, over: Partial<JoinToken> = {}): JoinToken {
  return {
    canonical: { host: s.host, port: s.port, sshAlias: "hub" },
    fleet_token: "FLEET-SECRET",
    transport_hint: "ssh",
    pin_version: "v1.18.29",
    ...over,
  };
}

describe("amico fleet enroll <join-token> — client redeem happy path (#1319 AC2)", () => {
  it("writes fleet.json (role+canonical ONLY), registers the roster row, sets the transport, runs the installer, and reports success after verify-attach", async () => {
    const s = await stub({ version: "v1.18.29" });
    const rec = recorder();
    const token = tokenFor(s);
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(token)], rec.deps);

    expect(r.code).toBe(0);
    expect(j(r).ok).toBe(true);

    // fleet.json = role + canonical ONLY (no capabilities smuggled in)
    expect(rec.fleetWrites).toHaveLength(1);
    expect(rec.fleetWrites[0].config).toEqual({ role: "client", canonical: token.canonical });

    // the roster row registered on the host, contract-valid, server_mode=client
    expect(s.rosterRows()).toHaveLength(1);
    const row = s.rosterRows()[0];
    expect(row.machine_id).toBe("machine-abc");
    expect(row.name).toBe("workbench");
    expect(row.server_mode).toBe("client");
    expect(row.transport).toBe("ssh");
    expect(row.sshAlias).toBe("hub");
    expect(row.health).toBe("reachable");
    // capabilities live on the ROW, not fleet.json
    expect(row.capabilities).toEqual([]);

    // transport set + installer run (guard) as a client
    expect(rec.transportSets).toEqual(["ssh"]);
    expect(rec.installerCalls).toEqual(["client"]);

    // success reported only after verify-attach passed
    expect(j(r).result?.verify_attach).toEqual({ ok: true });
  });

  it("defaults the transport to tailscale when this machine's capabilities include `roaming` (else the token's hint)", async () => {
    const s = await stub({ version: "v1.18.29" });
    const rec = recorder({ capabilities: () => ["roaming"] });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], rec.deps);

    expect(r.code).toBe(0);
    expect(rec.transportSets).toEqual(["tailscale"]);
    expect(s.rosterRows()[0].transport).toBe("tailscale");
    expect(s.rosterRows()[0].capabilities).toEqual(["roaming"]);
  });
});

describe("amico fleet enroll — pin check refuses a skewed token BEFORE any write (#1319 AC4)", () => {
  it("rejects a join token whose pin_version disagrees with the host-version probe, writing NOTHING", async () => {
    const s = await stub({ version: "v2.0.0" }); // host is v2.x; token pins v1.18.29 → major skew
    const rec = recorder();
    const token = tokenFor(s, { pin_version: "v1.18.29" });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(token)], rec.deps);

    // refused, honestly
    expect(r.code).not.toBe(0);
    expect(j(r).ok).toBe(false);
    expect(j(r).cause).toBe("pin-mismatch");
    // the reason names BOTH versions (the pure versionSkewVerdict speaking)
    expect(j(r).errors?.join(" ")).toContain("1.18.29");
    expect(j(r).errors?.join(" ")).toContain("2.0.0");

    // BEFORE any file is written: no fleet.json, no roster row, no transport, no installer
    expect(j(r).wrote_nothing).toBe(true);
    expect(rec.fleetWrites).toEqual([]);
    expect(s.rosterRows()).toEqual([]);
    expect(rec.transportSets).toEqual([]);
    expect(rec.installerCalls).toEqual([]);
  });
});

describe("amico fleet enroll — verify-attach honest failure (#1319 AC3)", () => {
  it("transport down: the just-set transport is unreachable → cause=transport-down, row health=down, NO success", async () => {
    const s = await stub({ version: "v1.18.29" }); // canonical healthy → pin check passes
    // verify-attach probes the transport, which resolves to a dead port
    const rec = recorder({ resolveProbeOrigin: () => ({ ok: true, origin: "http://127.0.0.1:1" }) });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], rec.deps);

    expect(r.code).not.toBe(0);
    expect(j(r).ok).toBe(false);
    expect(j(r).cause).toBe("transport-down");
    expect(typeof j(r).fix).toBe("string"); // the specific fix accompanies the cause
    expect(j(r).result?.verify_attach).toEqual({ ok: false, cause: "transport-down" });
    // the roster row's health reflects the failure (re-posted), NOT a false green
    expect(s.rosterRows()).toHaveLength(1);
    expect(s.rosterRows()[0].health).toBe("down");
  });

  it("auth rejected: the transport reaches a host that 401s → cause=auth-rejected, row health=degraded, NO success", async () => {
    const canonical = await stub({ version: "v1.18.29" }); // pin check target (healthy)
    const rejecting = await stub({ healthStatus: 401 }); // what the transport actually reaches
    const rec = recorder({ resolveProbeOrigin: () => ({ ok: true, origin: rejecting.url }) });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(canonical))], rec.deps);

    expect(r.code).not.toBe(0);
    expect(j(r).cause).toBe("auth-rejected");
    expect(canonical.rosterRows()[0].health).toBe("degraded");
  });

  it("sshAlias unresolved: an ssh transport with no alias → cause=sshAlias-unresolved, NO success", async () => {
    const s = await stub({ version: "v1.18.29" });
    const rec = recorder();
    // transport_hint ssh + an EMPTY sshAlias → the default origin resolver refuses
    const token = tokenFor(s, { transport_hint: "ssh", canonical: { host: s.host, port: s.port, sshAlias: "" } });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(token)], rec.deps);

    expect(r.code).not.toBe(0);
    expect(j(r).cause).toBe("sshAlias-unresolved");
    expect(j(r).ok).toBe(false);
    expect(s.rosterRows()[0].health).toBe("degraded");
  });
});

describe("amico fleet enroll — idempotent re-run repairs in place (#1319 AC5)", () => {
  it("a second enroll on an already-enrolled machine produces NO duplicate roster row and no duplicate unit path", async () => {
    const s = await stub({ version: "v1.18.29" });
    const token = tokenFor(s);

    const first = await fleetEnroll(["--join-token-json", JSON.stringify(token)], recorder().deps);
    const rec2 = recorder();
    const second = await fleetEnroll(["--join-token-json", JSON.stringify(token)], rec2.deps);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    // single-writer upsert by machine_id → exactly ONE row after two runs
    expect(s.rosterRows()).toHaveLength(1);
    expect(s.rosterRows()[0].machine_id).toBe("machine-abc");
    // the re-run still repairs via the installer (idempotent), never a second mechanism
    expect(rec2.installerCalls).toEqual(["client"]);
    // two posts total (one per run), collapsed to one row — no duplication
    expect(s.rosterPosts().length).toBe(2);
  });
});

describe("amico fleet enroll — the enroll-result JSON shape #1320 consumes (#1319 AC6)", () => {
  it("client result has EXACTLY {machine_id,name,server_mode,capabilities,transport,verify_attach:{ok}}", async () => {
    const s = await stub({ version: "v1.18.29" });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], recorder().deps);
    const result = j(r).result!;
    expect(Object.keys(result).sort()).toEqual([
      "capabilities",
      "machine_id",
      "name",
      "server_mode",
      "transport",
      "verify_attach",
    ]);
    expect(Object.keys(result.verify_attach)).toEqual(["ok"]); // no cause on success
    expect(result.server_mode).toBe("client");
  });

  it("server result carries the same fixed shape (server_mode=server, verify_attach ok)", async () => {
    const r = await fleetEnroll(["--as-server", "--host", "hub", "--port", "4096", "--ssh-alias", "hub"], recorder().deps);
    const result = j(r).result!;
    expect(Object.keys(result).sort()).toEqual([
      "capabilities",
      "machine_id",
      "name",
      "server_mode",
      "transport",
      "verify_attach",
    ]);
    expect(result.server_mode).toBe("server");
    expect(result.verify_attach.ok).toBe(true);
  });

  it("on failure the verify_attach carries {ok:false, cause} — the exact shape, with the cause", async () => {
    const s = await stub({ version: "v1.18.29" });
    const rec = recorder({ resolveProbeOrigin: () => ({ ok: true, origin: "http://127.0.0.1:1" }) });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], rec.deps);
    expect(Object.keys(j(r).result!.verify_attach).sort()).toEqual(["cause", "ok"]);
    expect(j(r).result!.verify_attach.ok).toBe(false);
  });
});

describe("amico fleet enroll — never-fork: a client installs the guard and spawns NO engine (#1319, ADR 0005)", () => {
  it("enrolling as a client runs the installer (guard) and NEVER touches the engine-spawn seam", async () => {
    const s = await stub({ version: "v1.18.29" });
    const rec = recorder();
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], rec.deps);

    expect(r.code).toBe(0);
    // the guard is installed via the client installer (the never-fork enforcement)
    expect(rec.installerCalls).toEqual(["client"]);
    // and the enroll verb NEVER spawns a local engine (the tripwire stays untouched)
    expect(rec.engine.spawns).toBe(0);
  });
});

describe("amico fleet enroll — open-auth hub: no HTTP credentials sent (#1354 Bug 2)", () => {
  it("does NOT send an Authorization header to the hub (the SSH tunnel is the auth boundary)", async () => {
    const s = await stub({ version: "v1.18.29" });
    const authHeaders: (string | undefined)[] = [];
    const spyFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const hdrs = init?.headers as Record<string, string> | undefined;
      authHeaders.push(hdrs?.Authorization);
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const rec = recorder({ fetchImpl: spyFetch });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(s))], rec.deps);

    expect(r.code).toBe(0);
    expect(j(r).ok).toBe(true);
    // Every fetch call should have Authorization = undefined (open auth)
    expect(authHeaders.length).toBeGreaterThan(0); // at least the pin check + verify-attach
    expect(authHeaders.every((h) => h === undefined)).toBe(true);
  });
});

describe("amico fleet enroll — verify-attach retries on transient transport-down (#1354 Bug 3)", () => {
  it("retries up to 3 times on transport-down, then succeeds when the host comes up", async () => {
    const canonical = await stub({ version: "v1.18.29" }); // pin check target (healthy)
    const verifyTarget = await stub({ version: "v1.18.29" }); // verify-attach target
    let verifyProbeCount = 0;
    const rec = recorder({
      resolveProbeOrigin: () => ({ ok: true as const, origin: verifyTarget.url }),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        if (url.includes(`:${verifyTarget.port}/global/health`)) {
          verifyProbeCount++;
          if (verifyProbeCount <= 2) throw new TypeError("fetch failed");
        }
        return globalThis.fetch(input, init);
      }) as typeof fetch,
      retryDelayMs: [0, 0, 0],
    });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(canonical))], rec.deps);

    expect(r.code).toBe(0);
    expect(j(r).ok).toBe(true);
    expect(j(r).result?.verify_attach).toEqual({ ok: true });
    expect(verifyProbeCount).toBe(3); // 2 failures + 1 success
    expect(verifyTarget.healthHits()).toBe(1); // only the successful probe reached the stub
  });

  it("gives up after exhausting retries and reports transport-down", async () => {
    const canonical = await stub({ version: "v1.18.29" }); // pin check target (healthy)
    const rec = recorder({
      resolveProbeOrigin: () => ({ ok: true as const, origin: "http://127.0.0.1:1" }),
      retryDelayMs: [0, 0, 0],
    });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(canonical))], rec.deps);

    expect(r.code).not.toBe(0);
    expect(j(r).ok).toBe(false);
    expect(j(r).cause).toBe("transport-down");
    expect(j(r).result?.verify_attach).toEqual({ ok: false, cause: "transport-down" });
  });

  it("does NOT retry on auth-rejected (401)", async () => {
    const canonical = await stub({ version: "v1.18.29" }); // pin check target (healthy)
    const rejecting = await stub({ healthStatus: 401 }); // what the transport actually reaches
    const rec = recorder({
      resolveProbeOrigin: () => ({ ok: true as const, origin: rejecting.url }),
      retryDelayMs: [0, 0, 0],
    });
    const r = await fleetEnroll(["--join-token-json", JSON.stringify(tokenFor(canonical))], rec.deps);

    expect(r.code).not.toBe(0);
    expect(j(r).cause).toBe("auth-rejected");
    expect(rejecting.healthHits()).toBe(1); // no retries — fails immediately
  });
});

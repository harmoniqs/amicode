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

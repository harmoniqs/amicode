// amicode_service_multiplex_dispatch.test.ts — #1448 (Fleet Studio wiring W1a):
// insert the session multiplexer into the dispatch path behind the
// AMICO_FLEET_MULTIPLEX feature flag (default OFF), shadowing ONLY the attached
// arm of the D3 resolver, and introduce the distinct `unreachable`/degraded
// `ResolvedTarget` variant W1b (#1449) turns into a 503.
//
// Pins the four ACs:
//   AC1 — flag OFF (default): dispatch is byte-identical; resolveTarget is
//         NEVER called (structural, not behavioural).
//   AC2 — flag ON + empty owner-map: resolveTarget resolves LOCAL for every
//         path (identity); shadows ONLY the attached arm (/amicode/roster still
//         hits the keeper, /amicode/fleet/* stays local).
//   AC3 — ResolvedTarget carries a distinct unreachable/degraded variant (owner
//         known, getUrl() undefined) NOT conflated with the keyless/local
//         undefined.
//   AC4 — the local path stays on EngineProxy; the multiplexer's SSE relay is
//         NOT wired into dispatch (structural guard).
//
// Reuses the SessionOwnerMap / PeerTransport stubs from
// amicode_session_relay.integration.test.ts (the reuse map).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";

import {
  AmicodeServiceServer,
  fleetMultiplexEnabled,
  FLEET_MULTIPLEX_FLAG,
  type FleetPlane,
} from "../src/amicode_service/server";
import { createAmicodeService } from "../src/amicode_service";
import { HubProxy } from "../src/amicode_service/hub_proxy";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import {
  SessionMultiplexProxy,
  SessionOwnerMap,
  type MultiplexResolver,
} from "../src/amicode_service/session_multiplexer";
import { writeAttachmentPointerFile } from "../src/amicode_service/attachment_pointer";
import { writeKeeperPointerFile } from "../src/amicode_service/keeper_pointer";
import { writeHubCredential, readHubCredential } from "../src/amicode_service/hub_credential";
import { serverAuthHeader } from "../src/server_auth";

// ── a marker stub: returns a distinct marker for every request; records paths ──
interface Stub {
  url: string;
  marker: string;
  requests: string[];
  stop(): Promise<void>;
}
function startStub(marker: string): Promise<Stub> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        marker,
        requests,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// The staged fleet-data-plane overlay (mirrors amicode_service_fleet_data_plane
// / fleet_peer_e2e) — createAmicodeService only arms the fleet plane when the
// entitlement + a lawful overlay declaration stage it.
function writeDataPlaneManifest(sourceRoot: string): void {
  const dir = join(sourceRoot, "fleet_overlay", "overlays");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "fleet-data-plane.json"),
    JSON.stringify({
      overlay_id: "fleet-data-plane",
      overlay_version: 1,
      base_version: "v1.18.29",
      surfaces: [
        {
          surface_id: "data-plane-routing",
          fleet_class: "data-plane routing",
          fields: [
            { name: "upstream_mode", base_default: "engine" },
            { name: "hub_upstream", base_default: null },
            { name: "hub_credential_entry", base_default: null },
            { name: "merged_projection", base_default: null },
          ],
        },
      ],
    }),
  );
}

const PW = "multiplex-dispatch-1448";

let root: string;
let hubFile: string;
let keeperFile: string;
let attachmentFile: string;
let overlaySource: string;
let peerStub: Stub;
let keeperStub: Stub;
let engineStub: Stub;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amicode-multiplex-1448-"));
  hubFile = join(root, "fleet-hub.json");
  keeperFile = join(root, "keeper.json");
  attachmentFile = join(root, "attachment.json");
  overlaySource = join(root, "overlay-source");
  writeDataPlaneManifest(overlaySource);

  for (const k of [
    "AMICO_FLEET_HUB_FILE",
    "AMICO_FLEET_KEEPER_FILE",
    "AMICO_FLEET_ATTACHMENT_FILE",
    FLEET_MULTIPLEX_FLAG,
  ]) {
    savedEnv[k] = process.env[k];
  }
  process.env.AMICO_FLEET_HUB_FILE = hubFile;
  process.env.AMICO_FLEET_KEEPER_FILE = keeperFile;
  process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;
  delete process.env[FLEET_MULTIPLEX_FLAG]; // default OFF

  peerStub = await startStub("PEER-1448");
  keeperStub = await startStub("KEEPER-1448");
  engineStub = await startStub("ENGINE-1448");

  // The HubProxy credential (attached + keeper proxies read it per request).
  writeHubCredential({ baseUrl: peerStub.url, token: "hub-tok-1448" }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
  // A set attachment pointer → resolveAmicodeTarget returns "attached" for the
  // non-roster / non-honesty paths; a keeper pointer for /amicode/roster.
  writeAttachmentPointerFile({ sshAlias: "u@127.0.0.1", transport: "ssh", machine_id: "peer-1448" }, { attachmentFile });
  writeKeeperPointerFile({ sshAlias: "keeper-1448", transport: "ssh" }, { keeperFile });
});

afterEach(() => {
  delete process.env[FLEET_MULTIPLEX_FLAG]; // reset to the default OFF between tests
});

afterAll(async () => {
  await peerStub?.stop();
  await keeperStub?.stop();
  await engineStub?.stop();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A hand-built engine-armed (non-client) fleet plane in fleet mode, with real
 *  HubProxies for hub/attached/keeper pointing at the marker stubs, and an
 *  injected multiplex seam (a spy) so the flag-gating is directly observable. */
function buildFleetPlane(multiplex?: MultiplexResolver): FleetPlane {
  const cred = () => readHubCredential();
  return {
    getMode: () => "fleet",
    hub: new HubProxy({ getUrl: () => undefined, credential: cred }),
    attached: new HubProxy({ getUrl: () => peerStub.url, credential: cred }),
    keeper: new HubProxy({ getUrl: () => keeperStub.url, credential: cred }),
    ...(multiplex ? { multiplex } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// AC3 — the distinct unreachable/degraded ResolvedTarget variant (pure unit)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1448 AC3 — ResolvedTarget carries a distinct unreachable/degraded variant", () => {
  it("owner KNOWN but getUrl() undefined → the degraded variant (machineId set, unreachable:true, url undefined) — NOT undefined/local", () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-remote", amicode_owner: { owner_machine_id: "peer-x", owner_name: "X", is_local: false } }]);
    const proxy = new SessionMultiplexProxy({
      ownerMap,
      peers: { "peer-x": { getUrl: () => undefined } }, // owner in the map, url unresolvable
      localMachineId: "local",
    });
    const target = proxy.resolveTarget("POST", "/api/session/ses-remote/message", {});
    expect(target).toBeDefined();
    expect(target?.machineId).toBe("peer-x");
    expect(target?.unreachable).toBe(true);
    expect(target?.url).toBeUndefined();
  });

  it("keyless request → LOCAL (undefined) — NOT conflated with the degraded variant", () => {
    const proxy = new SessionMultiplexProxy({ ownerMap: new SessionOwnerMap(), peers: {}, localMachineId: "local" });
    expect(proxy.resolveTarget("POST", "/file/write", {})).toBeUndefined();
  });

  it("reachable peer → { machineId, url } with unreachable falsy", () => {
    const ownerMap = new SessionOwnerMap();
    ownerMap.update([{ id: "ses-remote", amicode_owner: { owner_machine_id: "peer-x", owner_name: "X", is_local: false } }]);
    const proxy = new SessionMultiplexProxy({
      ownerMap,
      peers: { "peer-x": { getUrl: () => "http://127.0.0.1:9" } },
      localMachineId: "local",
    });
    const target = proxy.resolveTarget("POST", "/api/session/ses-remote/message", {});
    expect(target?.url).toBe("http://127.0.0.1:9");
    expect(target?.unreachable).toBeFalsy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC1 — flag OFF (default): byte-identity; resolveTarget NEVER called
// ══════════════════════════════════════════════════════════════════════════════
describe("#1448 AC1 — flag OFF (default): dispatch byte-identical, resolveTarget never called", () => {
  it("single_attach_nonfleet_smoke: a non-fleet single-machine boot serves the local path through EngineProxy (multiplexer structurally uninvolved)", async () => {
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/session`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { marker: string }).marker).toBe(engineStub.marker);
    } finally {
      await server.stop();
    }
  });

  it("flag OFF + attached fleet plane: an attached-arm request routes to the peer via resolveAmicodeTarget WITHOUT calling the multiplexer's resolveTarget", async () => {
    expect(fleetMultiplexEnabled()).toBe(false); // default OFF
    const resolveSpy = vi.fn(() => undefined);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    server.attachFleetPlane(buildFleetPlane({ resolveTarget: resolveSpy }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const before = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/vaults`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker); // routed to the attached peer, as today
      expect(peerStub.requests.length).toBe(before + 1);
      expect(resolveSpy).not.toHaveBeenCalled(); // structural: OFF → never consulted
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC2 — flag ON + empty owner-map: LOCAL identity; shadows ONLY the attached arm
// ══════════════════════════════════════════════════════════════════════════════
describe("#1448 AC2 — flag ON + empty owner-map: LOCAL identity; shadows ONLY the attached arm", () => {
  it("flag ON: resolveTarget IS consulted on the attached arm and (empty owner-map) resolves LOCAL — the attached peer is NOT dialed", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    expect(fleetMultiplexEnabled()).toBe(true);
    const resolveSpy = vi.fn(() => undefined);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    server.attachFleetPlane(buildFleetPlane({ resolveTarget: resolveSpy }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/vaults`, { headers: { Authorization: serverAuthHeader(PW) } });
      await res.text();
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy.mock.calls[0][1]).toBe("/amicode/vaults"); // pathname arg
      expect(peerStub.requests.length).toBe(peerBefore); // LOCAL — the peer was NOT dialed
    } finally {
      await server.stop();
    }
  });

  it("flag ON: /amicode/roster still routes to the KEEPER — the multiplexer shadows ONLY the attached arm", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const resolveSpy = vi.fn(() => undefined);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    server.attachFleetPlane(buildFleetPlane({ resolveTarget: resolveSpy }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const keeperBefore = keeperStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/roster`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(((await res.json()) as { marker: string }).marker).toBe(keeperStub.marker);
      expect(keeperStub.requests.length).toBe(keeperBefore + 1);
      expect(resolveSpy).not.toHaveBeenCalled(); // multiplexer NOT consulted for the keeper arm
    } finally {
      await server.stop();
    }
  });

  it("flag ON: /amicode/fleet/* stays LOCAL — the honesty arm is untouched (multiplexer not consulted, no peer/keeper dial)", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const resolveSpy = vi.fn(() => undefined);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
    server.attachFleetPlane(buildFleetPlane({ resolveTarget: resolveSpy }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    const keeperBefore = keeperStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: serverAuthHeader(PW) } });
      await res.text();
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(peerStub.requests.length).toBe(peerBefore);
      expect(keeperStub.requests.length).toBe(keeperBefore);
    } finally {
      await server.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// AC4 — local stays on EngineProxy; NO SSE crosses the multiplexer (structural)
// ══════════════════════════════════════════════════════════════════════════════
describe("#1448 AC4 — local path on EngineProxy; the multiplexer's SSE relay is NOT wired into dispatch", () => {
  it("server.ts never wires the multiplexer's SSE relay into dispatch (structural source guard)", () => {
    const src = readFileSync(join(__dirname, "..", "src", "amicode_service", "server.ts"), "utf8");
    expect(src.includes("openSseStream")).toBe(false);
  });

  it("the multiplex seam the plane exposes has NO SSE method — a resolveTarget-only object is a valid MultiplexResolver", () => {
    const seam: MultiplexResolver = { resolveTarget: () => undefined };
    expect("openSseStream" in seam).toBe(false);
    expect(typeof seam.resolveTarget).toBe("function");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Production wiring — createAmicodeService builds AND wires the multiplex
// ══════════════════════════════════════════════════════════════════════════════
describe("#1448 — production dispatch wiring (createAmicodeService)", () => {
  function bootService(): AmicodeServiceServer {
    return createAmicodeService({
      password: PW,
      engine: { getUrl: () => engineStub.url },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => undefined },
        getMode: () => "fleet",
        attached: { getUrl: () => peerStub.url },
        keeper: { getUrl: () => keeperStub.url },
        posture: { hubDownConsecutiveNoResponses: 100, recoveryConsecutiveHealthy: 100 },
        dataPlaneTimeoutMs: 5000,
      },
    });
  }

  it("flag OFF (default): an attached-arm /amicode request routes to the peer (byte-identical to today)", async () => {
    delete process.env[FLEET_MULTIPLEX_FLAG];
    const svc = bootService();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const before = peerStub.requests.length;
    try {
      const res = await fetch(`${origin}/amicode/profile`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(((await res.json()) as { marker: string }).marker).toBe(peerStub.marker);
      expect(peerStub.requests.length).toBe(before + 1);
    } finally {
      await svc.stop();
    }
  });

  it("flag ON + empty owner-map: the same attached-arm request is served LOCALLY (identity); /amicode/roster still hits the keeper; /amicode/fleet/* stays local", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const svc = bootService();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const peerBefore = peerStub.requests.length;
    const keeperBefore = keeperStub.requests.length;
    try {
      // attached arm → LOCAL: served by the local profile route, NOT the peer
      const prof = await fetch(`${origin}/amicode/profile`, { headers: { Authorization: serverAuthHeader(PW) } });
      const profBody = (await prof.json()) as { marker?: string };
      expect(profBody.marker).not.toBe(peerStub.marker);
      expect(peerStub.requests.length).toBe(peerBefore); // peer NOT dialed

      // keeper arm → keeper (shadow only the attached arm)
      const roster = await fetch(`${origin}/amicode/roster`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(((await roster.json()) as { marker: string }).marker).toBe(keeperStub.marker);
      expect(keeperStub.requests.length).toBe(keeperBefore + 1);

      // honesty arm → local (the local fleet status route, no stub marker)
      const peerBeforeStatus = peerStub.requests.length;
      const keeperBeforeStatus = keeperStub.requests.length;
      const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: serverAuthHeader(PW) } });
      expect(status.status).toBe(200);
      const statusBody = (await status.json()) as { marker?: string; ok?: boolean };
      expect(statusBody.marker).toBeUndefined();
      expect(peerStub.requests.length).toBe(peerBeforeStatus);
      expect(keeperStub.requests.length).toBe(keeperBeforeStatus);
    } finally {
      await svc.stop();
    }
  });
});

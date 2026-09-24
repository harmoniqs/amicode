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
import {
  SseFanInDriver,
  type OpenUpstream,
  type SseFanInDriverDeps,
} from "../src/amicode_service/sse_fanin_driver";
import type { SseFrameSource } from "../src/amicode_service/sse_fanin_aggregator";
import { parseCompositeCursor } from "../src/amicode_service/sse_composite_cursor";
import { peerAuthHeader } from "../src/amicode_service/merged_projection";
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

// ══════════════════════════════════════════════════════════════════════════════
// #1519 (Fleet Studio wiring W1c) — wire the SSE fan-in aggregator into the
// /event route behind AMICO_FLEET_MULTIPLEX (ADR 0033 §D1–D4). Route-level,
// single-host, hermetic. The live cross-machine delivery is the opt-in two-peer
// E2E; here the UPSTREAM transport is faked (an injected opener) so the REAL
// route — dispatch → the flag-gated /event interception → the #1511 aggregator →
// the real downstream res — is exercised deterministically.
// ══════════════════════════════════════════════════════════════════════════════

/** An SSE stub: on GET it emits a fixed frame list as text/event-stream then
 *  ends the response (so a byte-identity read completes). Records the path,
 *  the ?lastEventID it received (the #1264 cursor), and the Authorization. */
interface SseStub {
  url: string;
  requests: Array<{ path: string; lastEventID: string | null; auth?: string }>;
  stop(): Promise<void>;
}
function startSseStub(frames: string[]): Promise<SseStub> {
  const requests: SseStub["requests"] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    requests.push({
      path: u.pathname,
      lastEventID: u.searchParams.get("lastEventID"),
      auth: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const f of frames) res.write(f);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** A single delimiter-inclusive SSE frame block from lines. */
function sseFrame(...lines: string[]): string {
  return lines.join("\n") + "\n\n";
}

/** Bounded, timeout-safe live SSE read of the downstream: pull whole frames
 *  until `maxFrames` or the window elapses. Never hangs (the fan-in downstream
 *  never ends on its own). Mirrors the two-peer E2E's readSseFrames. */
async function readSseFrames(
  url: string,
  headers: Record<string, string>,
  opts: { maxFrames: number; timeoutMs: number },
): Promise<string[]> {
  const frames: string[] = [];
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs) });
    if (!res.ok || res.body === null) return frames;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (frames.length < opts.maxFrames) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0 && frames.length < opts.maxFrames) {
          frames.push(buf.slice(0, idx + 2));
          buf = buf.slice(idx + 2);
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
  } catch {
    /* timeout / transport blip — return whatever whole frames we got */
  }
  return frames;
}

// ── AC1 — route-level flag-OFF byte-identity (WRITTEN FIRST; the #1264 guard) ──
describe("#1519 AC1 — /event route flag-OFF byte-identity (#1264 regression guard)", () => {
  it("flag OFF: /event streams frame-for-frame through the engine proxy, exactly as today", async () => {
    delete process.env[FLEET_MULTIPLEX_FLAG];
    const F1 = sseFrame("event: message", 'data: {"a":1}', "id: 1");
    const F2 = sseFrame("event: message", 'data: {"b":2}', "id: 2");
    const engine = await startSseStub([F1, F2]);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engine.url }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      // the stub ends the response, so the full body is finite: assert BYTE identity
      const body = await (await fetch(`${origin}/event`, { headers: { Authorization: serverAuthHeader(PW) } })).text();
      expect(body).toBe(F1 + F2); // no id rewrite, no namespacing, no composite — verbatim
      expect(engine.requests[0].path).toBe("/event");
    } finally {
      await server.stop();
      await engine.stop();
    }
  });

  it("flag ON but no fleet plane (fleet-of-one): /event is STILL byte-identical — the flag alone never perturbs a single-machine stream", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    expect(fleetMultiplexEnabled()).toBe(true);
    const F1 = sseFrame("event: message", 'data: {"x":1}', "id: 7");
    const engine = await startSseStub([F1]);
    const server = new AmicodeServiceServer({ password: PW }); // no fleet plane → no eventFanIn seam
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engine.url }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      const body = await (await fetch(`${origin}/event`, { headers: { Authorization: serverAuthHeader(PW) } })).text();
      expect(body).toBe(F1);
    } finally {
      await server.stop();
      await engine.stop();
    }
  });

  it("flag OFF: the #1264 ?lastEventID cursor rides through to the engine UNCHANGED (opaque, frame-for-frame path preserved)", async () => {
    delete process.env[FLEET_MULTIPLEX_FLAG];
    const engine = await startSseStub([sseFrame("data: {}", "id: 9")]);
    const server = new AmicodeServiceServer({ password: PW });
    server.attachEngineProxy(new EngineProxy({ getUrl: () => engine.url }));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      await (await fetch(`${origin}/event?lastEventID=42`, { headers: { Authorization: serverAuthHeader(PW) } })).text();
      expect(engine.requests[0].lastEventID).toBe("42"); // the opaque cursor reaches the engine verbatim
    } finally {
      await server.stop();
      await engine.stop();
    }
  });
});

// ── fan-in test scaffolding (AC2–AC5): an injected upstream opener drives the
//    #1511 aggregator CORE deterministically; the downstream is a REAL /event. ──

/** A controllable frame source: `push(frame)` feeds a frame; `end()` ends it.
 *  Stays OPEN between pushes (a real SSE stream never ends on its own), so the
 *  fan-in connection persists until the downstream closes or the arm is closed. */
interface Ctl {
  push(frame: string): void;
  end(): void;
  closed(): boolean;
  source: SseFrameSource;
}
function controllableSource(preload: string[] = []): Ctl {
  const queue: string[] = [...preload];
  const waiters: Array<(v: string | null) => void> = [];
  let ended = false;
  let closedByDriver = false;
  const drainNull = () => {
    let w: ((v: string | null) => void) | undefined;
    while ((w = waiters.shift())) w(null);
  };
  return {
    push(frame: string) {
      if (ended) return;
      const w = waiters.shift();
      if (w) w(frame);
      else queue.push(frame);
    },
    end() {
      ended = true;
      drainNull();
    },
    closed() {
      return closedByDriver;
    },
    source: {
      next(): Promise<string | null> {
        const f = queue.shift();
        if (f !== undefined) return Promise.resolve(f);
        if (ended) return Promise.resolve(null);
        return new Promise((resolve) => waiters.push(resolve));
      },
      close() {
        closedByDriver = true;
        ended = true;
        drainNull();
      },
    },
  };
}

/** Read up to `maxFrames` whole SSE frames from an ALREADY-fetched Response
 *  (fetch-then-push-then-read). The fetch's own AbortSignal.timeout is the hang
 *  guard: a stalled read rejects and returns whatever whole frames arrived. */
async function drainSseFrames(res: Response, opts: { maxFrames: number }): Promise<string[]> {
  const frames: string[] = [];
  if (res.body === null) return frames;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (frames.length < opts.maxFrames) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0 && frames.length < opts.maxFrames) {
        frames.push(buf.slice(0, idx + 2));
        buf = buf.slice(idx + 2);
      }
    }
  } catch {
    /* abort / transport end — return the whole frames we got */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  return frames;
}

/** An engine-armed (non-client) fleet plane in "engine" mode carrying ONLY the
 *  fan-in seam — so `/event` reaches the flag-gated interception, and every
 *  other path is untouched. getMode "engine" means a DECLINED fan-in falls to
 *  the engine proxy (byte-identical), never a fleet-hub detour. */
function fanInPlane(driver: SseFanInDriver): FleetPlane {
  return {
    getMode: () => "engine",
    hub: new HubProxy({ getUrl: () => undefined, credential: () => readHubCredential() }),
    eventFanIn: driver,
  };
}

/** Build a driver with an injected opener that records each open and returns a
 *  controllable source per namespace, plus sane owner/token/reachability
 *  defaults. `owners` seeds the SessionOwnerMap with remote-owned sessions. */
function makeFanInDriver(opts: {
  ownerMap: SessionOwnerMap;
  opened: Array<{ namespace: string; url: string; authHeader?: string; lastEventId?: string }>;
  arms: Map<string, Ctl>;
  preload?: Record<string, string[]>;
  reachable?: (id: string) => boolean;
  overrides?: Partial<SseFanInDriverDeps>;
}): SseFanInDriver {
  const openUpstream: OpenUpstream = (r) => {
    const c = controllableSource(opts.preload?.[r.namespace] ?? []);
    opts.arms.set(r.namespace, c);
    opts.opened.push({ namespace: r.namespace, url: r.url, authHeader: r.authHeader, lastEventId: r.lastEventId });
    return c.source;
  };
  return new SseFanInDriver({
    ownerMap: opts.ownerMap,
    localMachineId: "macbook",
    localEventUrl: () => "http://local.invalid",
    peerBaseUrl: (id) => `http://${id}.invalid`,
    peerToken: (id) => ({ ok: true, credential: { baseUrl: `http://${id}.invalid`, token: `tok-${id}` } }),
    reachable: opts.reachable ?? (() => true),
    openUpstream,
    reconcileMs: 1_000_000, // tests drive reconcile() directly — no timer races
    ...opts.overrides,
  });
}

/** Seed a SessionOwnerMap with remote-owned sessions. */
function ownerMapWith(pairs: Array<[string, string]>): SessionOwnerMap {
  const m = new SessionOwnerMap();
  m.update(pairs.map(([id, owner]) => ({ id, amicode_owner: { owner_machine_id: owner, owner_name: owner, is_local: false } })));
  return m;
}

const READ_TIMEOUT = 5000;

// ── AC2 — flag-ON fan-in: local arm + one authed upstream per owner-peer ──────
describe("#1519 AC2 — flag-ON fan-in onto the single downstream /event", () => {
  it("opens the local arm + one authed upstream SSE per owner-peer, streaming the namespaced composite onto one res", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const ownerMap = ownerMapWith([["s1", "studio"]]);
    const opened: Array<{ namespace: string; url: string; authHeader?: string; lastEventId?: string }> = [];
    const arms = new Map<string, Ctl>();
    const driver = makeFanInDriver({
      ownerMap,
      opened,
      arms,
      preload: {
        local: [sseFrame("event: message", 'data: {"src":"local"}', "id: 5")],
        studio: [sseFrame("event: message", 'data: {"src":"studio"}', "id: 9")],
      },
    });
    const server = new AmicodeServiceServer({ password: PW });
    server.attachFleetPlane(fanInPlane(driver));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/event`, {
        headers: { Authorization: serverAuthHeader(PW) },
        signal: AbortSignal.timeout(READ_TIMEOUT),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      // handle() ran → local + studio arms opened; the peer authed with ITS OWN token
      expect(opened.map((o) => o.namespace).sort()).toEqual(["local", "studio"]);
      const studio = opened.find((o) => o.namespace === "studio")!;
      expect(studio.authHeader).toBe(peerAuthHeader("tok-studio"));
      // the origin's local/hub credential (PW) is NEVER forwarded to a peer upstream
      expect(studio.authHeader?.includes(PW)).toBe(false);

      const frames = await drainSseFrames(res, { maxFrames: 2 });
      const text = frames.join("");
      // both arms fanned onto the ONE downstream response
      expect(text).toContain('"src":"local"');
      expect(text).toContain('"src":"studio"');
      // the LAST frame carries the full composite id (round-trippable, §D3)
      const ids = [...text.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);
      const composite = parseCompositeCursor(ids[ids.length - 1]);
      expect(composite.get("local")).toBe("5");
      expect(composite.get("studio")).toBe("9");
    } finally {
      await server.stop();
    }
  });
});

// ── AC3 — arm lifecycle: newly-owned arm opens; a lost peer's arm closes + a
//    honest comment frame; the downstream connection is never dropped ─────────
describe("#1519 AC3 — live arm lifecycle honours the SessionOwnerMap", () => {
  it("a newly-owned peer's arm opens; a peer that goes dark closes + emits the honest comment, without dropping the downstream", async () => {
    process.env[FLEET_MULTIPLEX_FLAG] = "1";
    const ownerMap = ownerMapWith([["s1", "studio"]]);
    const dark = new Set<string>(); // peers whose transport has gone dark
    const opened: Array<{ namespace: string; url: string; authHeader?: string; lastEventId?: string }> = [];
    const arms = new Map<string, Ctl>();
    const driver = makeFanInDriver({ ownerMap, opened, arms, reachable: (id) => !dark.has(id) });
    const server = new AmicodeServiceServer({ password: PW });
    server.attachFleetPlane(fanInPlane(driver));
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/event`, {
        headers: { Authorization: serverAuthHeader(PW) },
        signal: AbortSignal.timeout(8000),
      });
      expect(res.status).toBe(200);
      // initial membership: local + the one owner-peer
      expect(opened.map((o) => o.namespace).sort()).toEqual(["local", "studio"]);

      // (1) a NEWLY-OWNED peer → its arm opens live on the SAME connection.
      ownerMap.update([
        { id: "s1", amicode_owner: { owner_machine_id: "studio", owner_name: "studio", is_local: false } },
        { id: "s2", amicode_owner: { owner_machine_id: "mini", owner_name: "mini", is_local: false } },
      ]);
      driver.reconcile();
      expect(opened.map((o) => o.namespace)).toContain("mini");
      expect(arms.get("studio")!.closed()).toBe(false); // studio still live

      // (2) a LOST peer (owned but transport dark) → its arm closes + a honest
      //     comment frame is emitted; the downstream stays open.
      dark.add("studio");
      driver.reconcile();
      expect(arms.get("studio")!.closed()).toBe(true); // the real upstream was torn down

      // (3) the downstream is NOT dropped: mini keeps flowing after studio drops.
      arms.get("mini")!.push(sseFrame("event: message", 'data: {"src":"mini"}', "id: 3"));
      const frames = await drainSseFrames(res, { maxFrames: 2 });
      const text = frames.join("");
      expect(text).toContain(": amicode.fleet source studio unavailable"); // honest, not a silent gap
      expect(text).toContain('"src":"mini"'); // the surviving arm still delivers
    } finally {
      await server.stop();
    }
  }, 15000);
});

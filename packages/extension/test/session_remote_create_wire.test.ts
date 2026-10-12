// session_remote_create_wire.test.ts — #1643 (completes #1484 AC3), AC6/AC4.
//
// The CONNECTED wire test: it proves the app-produced x-amicode-owner header
// routes a path-less session-create POST to the owning peer through the REAL
// multiplexer + server dispatch — not the ends in isolation. This is the seam
// the AC3-shipped-incomplete finding was about: the multiplexer consumed the
// header (proven since #1449 for session-PATHED requests); here we prove the
// PATH-LESS create POST — the exact request session.create issues — routes on
// the header the app now emits (remote-create-arm.ts attachOwnerHeaderIfArmed).
//
//   AC6 — header-armed create POST routes to the owning peer (lands there)
//   AC4 — a peer that drops mid-create yields FLEET_PEER_UNREACHABLE 503,
//         never a local ghost session, never a silent local fallback (#1382)
//   AC3 — a create POST with NO owner header resolves LOCAL (byte-unchanged)
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  SessionOwnerMap,
  SessionMultiplexProxy,
  OWNER_ROUTING_HEADER,
} from "../src/amicode_service/session_multiplexer";
import {
  AmicodeServiceServer,
  FLEET_MULTIPLEX_FLAG,
  FLEET_PEER_UNREACHABLE_ERROR,
  type FleetPlane,
} from "../src/amicode_service/server";
import { HubProxy } from "../src/amicode_service/hub_proxy";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import { readHubCredential, writeHubCredential } from "../src/amicode_service/hub_credential";
import { writeAttachmentPointerFile } from "../src/amicode_service/attachment_pointer";
import { writeKeeperPointerFile } from "../src/amicode_service/keeper_pointer";
import { serverAuthHeader } from "../src/server_auth";
// The app-side producer const, asserted byte-equal to the consumer const.
import { OWNER_HEADER } from "../../app-bundle/overlay/packages/app/src/components/remote-create-header";

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

const PW = "remote-create-wire-1643";
let root: string;
let attachmentFile: string;
let keeperFile: string;
let hubFile: string;
let peerA: Stub;
let peerDown: Stub;
let engineStub: Stub;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amicode-1643-wire-"));
  attachmentFile = join(root, "attachment.json");
  keeperFile = join(root, "keeper.json");
  hubFile = join(root, "hub.json");
  for (const k of ["AMICO_FLEET_ATTACHMENT_FILE", "AMICO_FLEET_KEEPER_FILE", "AMICO_FLEET_HUB_FILE", FLEET_MULTIPLEX_FLAG]) {
    saved[k] = process.env[k];
  }
  process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;
  process.env.AMICO_FLEET_KEEPER_FILE = keeperFile;
  process.env.AMICO_FLEET_HUB_FILE = hubFile;
  process.env[FLEET_MULTIPLEX_FLAG] = "1";
  peerA = await startStub("PEER-A");
  peerDown = await startStub("PEER-DOWN");
  engineStub = await startStub("LOCAL-ENGINE");
  // A set attachment pointer → resolveAmicodeTarget returns "attached" for the
  // non-roster / non-honesty paths, which is the ONLY arm the multiplexer
  // shadows. Without it the create POST never reaches resolveTarget.
  writeAttachmentPointerFile({ sshAlias: "u@127.0.0.1", transport: "ssh", machine_id: "peer-a" }, { attachmentFile });
  writeKeeperPointerFile({ sshAlias: "keeper", transport: "ssh" }, { keeperFile });
  writeHubCredential({ baseUrl: peerA.url, token: "hub-tok-1643" }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
});

afterAll(async () => {
  await Promise.all([peerA?.stop(), peerDown?.stop(), engineStub?.stop()]);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function bootServer(): AmicodeServiceServer {
  const ownerMap = new SessionOwnerMap();
  const mux = new SessionMultiplexProxy({
    ownerMap,
    peers: {
      // peer-a reachable; peer-down owner known but url undefined (unreachable).
      "peer-a": { getUrl: () => peerA.url, token: "tok-a" },
      "peer-down": { getUrl: () => undefined, token: "tok-down" },
    },
    localMachineId: "local-machine",
  });
  const cred = () => readHubCredential();
  const plane: FleetPlane = {
    getMode: () => "fleet",
    hub: new HubProxy({ getUrl: () => undefined, credential: cred }),
    attached: new HubProxy({ getUrl: () => peerA.url, credential: cred }),
    keeper: new HubProxy({ getUrl: () => undefined, credential: cred }),
    multiplex: mux,
  };
  const server = new AmicodeServiceServer({ password: PW });
  server.attachEngineProxy(new EngineProxy({ getUrl: () => engineStub.url }));
  server.attachFleetPlane(plane);
  return server;
}

describe("#1643 connected wire — the produced owner header routes the create", () => {
  it("the producer header const byte-matches the multiplexer's routing header const", () => {
    // The single most load-bearing invariant of the wire: if these drift, the
    // app emits a header nobody routes on (the exact AC3-incomplete failure).
    expect(OWNER_HEADER).toBe(OWNER_ROUTING_HEADER);
  });

  it("AC6: a path-less create POST carrying x-amicode-owner routes to the owning peer (lands there, not local)", async () => {
    const server = bootServer();
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const engineBefore = engineStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW), [OWNER_HEADER]: "peer-a" },
        body: JSON.stringify({ agent: "build" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(peerA.marker);
      expect(peerA.requests.some((r) => r.startsWith("POST") && r.includes("/session"))).toBe(true);
      // it did NOT land on the local engine
      expect(engineStub.requests.length).toBe(engineBefore);
    } finally {
      await server.stop();
    }
  });

  it("AC4: an owner header naming an UNREACHABLE peer yields FLEET_PEER_UNREACHABLE 503 — no local ghost", async () => {
    const server = bootServer();
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const engineBefore = engineStub.requests.length;
    try {
      const res = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW), [OWNER_HEADER]: "peer-down" },
        body: JSON.stringify({ agent: "build" }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toBe(FLEET_PEER_UNREACHABLE_ERROR);
      // never a local ghost session
      expect(engineStub.requests.length).toBe(engineBefore);
    } finally {
      await server.stop();
    }
  });

  it("AC3: a create POST with NO owner header resolves LOCAL (byte-unchanged create path)", async () => {
    const server = bootServer();
    const origin = (await server.start()).toString().replace(/\/$/, "");
    const peerBefore = peerA.requests.length;
    try {
      const res = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW) },
        body: JSON.stringify({ agent: "build" }),
      });
      expect(((await res.json()) as { marker: string }).marker).toBe(engineStub.marker);
      // no peer was dialed
      expect(peerA.requests.length).toBe(peerBefore);
    } finally {
      await server.stop();
    }
  });
});

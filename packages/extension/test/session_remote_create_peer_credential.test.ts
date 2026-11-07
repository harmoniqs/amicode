// session_remote_create_peer_credential.test.ts — the credential half of the
// remote-create wire (companion to session_remote_create_wire.test.ts).
//
// The wire test (#1643) proved the x-amicode-owner header ROUTES a path-less
// create POST to the owning peer. But its peer stub returns 200 to ANY request
// without validating auth — so it never caught that the fleet plane dialed the
// peer with the HUB credential instead of the peer's OWN reader token. A real
// peer engine (ServerAuth.authorized: accepts only its own per-boot password or
// a token IT issued) 401s the hub token → the user's "Failed to create session
// → 401 Unauthorized" on every create (the selector pre-selects the attached
// peer, so even a "local"-feeling create is a remote pick).
//
// This test makes the peer stub AUTH-AWARE: it accepts ONLY serverAuthHeader of
// its own peer token and 401s everything else — mirroring the real peer engine.
// A create POST must therefore reach the peer bearing the PEER token, not the
// hub credential.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  SessionOwnerMap,
  SessionMultiplexProxy,
} from "../src/amicode_service/session_multiplexer";
import {
  AmicodeServiceServer,
  FLEET_MULTIPLEX_FLAG,
  type FleetPlane,
} from "../src/amicode_service/server";
import { HubProxy } from "../src/amicode_service/hub_proxy";
import { EngineProxy } from "../src/amicode_service/engine_proxy";
import { readHubCredential, writeHubCredential } from "../src/amicode_service/hub_credential";
import { writeAttachmentPointerFile } from "../src/amicode_service/attachment_pointer";
import { writeKeeperPointerFile } from "../src/amicode_service/keeper_pointer";
import { serverAuthHeader } from "../src/server_auth";
import { OWNER_HEADER } from "../../app-bundle/overlay/packages/app/src/components/remote-create-header";

/** An AUTH-AWARE peer stub: accepts ONLY the expected Authorization header
 *  (its own peer token, Basic-encoded), 401s anything else — the real peer
 *  engine's contract. Records the auth header it saw for assertion. */
interface AuthStub {
  url: string;
  seenAuth: string[];
  stop(): Promise<void>;
}
function startAuthStub(acceptHeader: string): Promise<AuthStub> {
  const seenAuth: string[] = [];
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    seenAuth.push(auth);
    if (auth !== acceptHeader) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "PEER-A" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        seenAuth,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const PW = "peer-cred-wire";
const PEER_TOKEN = "peer-a-reader-token";
const HUB_TOKEN = "hub-token-not-the-peer";
let root: string;
let attachmentFile: string;
let keeperFile: string;
let hubFile: string;
let peerA: AuthStub;
let engineStub: { url: string; stop(): Promise<void> };
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amicode-peer-cred-"));
  attachmentFile = join(root, "attachment.json");
  keeperFile = join(root, "keeper.json");
  hubFile = join(root, "hub.json");
  for (const k of ["AMICO_FLEET_ATTACHMENT_FILE", "AMICO_FLEET_KEEPER_FILE", "AMICO_FLEET_HUB_FILE", FLEET_MULTIPLEX_FLAG]) {
    saved[k] = process.env[k];
  }
  // The peer stub accepts ONLY its own token, Basic-encoded (the real engine).
  peerA = await startAuthStub(serverAuthHeader(PEER_TOKEN));
  const eng = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, marker: "LOCAL-ENGINE" }));
  });
  await new Promise<void>((r) => eng.listen(0, "127.0.0.1", r));
  const engPort = (eng.address() as AddressInfo).port;
  engineStub = { url: `http://127.0.0.1:${engPort}`, stop: () => new Promise((r) => eng.close(() => r())) };

  process.env.AMICO_FLEET_ATTACHMENT_FILE = attachmentFile;
  process.env.AMICO_FLEET_KEEPER_FILE = keeperFile;
  process.env.AMICO_FLEET_HUB_FILE = hubFile;
  process.env[FLEET_MULTIPLEX_FLAG] = "1";
  writeAttachmentPointerFile({ sshAlias: "u@127.0.0.1", transport: "ssh", machine_id: "peer-a" }, { attachmentFile });
  writeKeeperPointerFile({ sshAlias: "keeper", transport: "ssh" }, { keeperFile });
  // The hub credential exists (and points at peer-a's url) but its TOKEN is the
  // hub's, NOT the peer's — the pre-fix code would attach THIS and 401.
  writeHubCredential({ baseUrl: peerA.url, token: HUB_TOKEN }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
});

afterAll(async () => {
  await Promise.all([peerA?.stop(), engineStub?.stop()]);
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
      // peer-a reachable, carrying its OWN reader token.
      "peer-a": { getUrl: () => peerA.url, token: PEER_TOKEN },
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

describe("remote-create peer credential — dial the peer with ITS token, not the hub cred", () => {
  it("a header-armed create POST reaches the peer bearing serverAuthHeader(peer.token) and gets 200", async () => {
    const server = bootServer();
    const origin = (await server.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader(PW), [OWNER_HEADER]: "peer-a" },
        body: JSON.stringify({ agent: "build" }),
      });
      // Pre-fix: the peer saw the HUB token and 401'd → this was 401 (the bug).
      expect(res.status).toBe(200);
      expect(((await res.json()) as { marker: string }).marker).toBe("PEER-A");
      // The peer must have seen ITS OWN token, never the hub token.
      expect(peerA.seenAuth).toContain(serverAuthHeader(PEER_TOKEN));
      expect(peerA.seenAuth).not.toContain(serverAuthHeader(HUB_TOKEN));
    } finally {
      await server.stop();
    }
  });
});

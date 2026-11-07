// fleet_session_status_e2e.test.ts — #1766 END TO END (service half). Drives
// the REAL GET /amicode/fleet/session-status handler (createAmicodeService's
// observation-only boot, its live OwnerMapFeed) against a STUBBED peer owner
// that reports a pinned session busy in its directory, then:
//   1. asserts the real handler's response is EXACTLY the committed fixture the
//      app-side half consumes (packages/app-bundle/overlay/.../
//      fleet-session-status.e2e-fixture.ts) — so the two halves cannot drift;
//   2. runs that live response through the APP's own parse
//      (fleet-session-status.ts, import-free, loaded across packages) and checks
//      it yields busy for that exact session id.
// The app half (fleet-session-status.e2e.test.ts, bun) takes the same fixture
// through parse + runFleetReseed + the real ServerSession reconcile into the
// store. Session ids are the engine's raw ids end to end: the id the app pins
// is the owner-map key AND the key in the owner's own status answer.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import {
  E2E,
  FLEET_STATUS_E2E_RESPONSE,
} from "../../app-bundle/overlay/packages/app/src/context/fleet-session-status.e2e-fixture";
import { parseFleetStatusResponse } from "../../app-bundle/overlay/packages/app/src/context/fleet-session-status";

interface Stub {
  url: string;
  statusReads: Array<{ directory: string | null; auth: string | undefined }>;
  stop(): Promise<void>;
}

/** An engine stub: lists `sessions` (record `directory` verbatim) on
 *  /experimental/session and answers /session/status?directory=<d> from
 *  `statusByDirectory` (an unloaded directory → `{}`), behind `credential`. */
function startEngine(
  sessions: Array<{ id: string; directory: string }>,
  statusByDirectory: Record<string, Record<string, unknown>>,
  credential: string,
): Promise<Stub> {
  const statusReads: Stub["statusReads"] = [];
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== serverAuthHeader(credential)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://stub");
    res.setHeader("content-type", "application/json");
    if (u.pathname === "/experimental/session") {
      const archived = u.searchParams.get("archived") === "true";
      res.end(JSON.stringify(archived ? [] : sessions.map((s) => ({ ...s, title: s.id, time: { created: 1, updated: 2 } }))));
      return;
    }
    if (u.pathname === "/session/status") {
      const directory = u.searchParams.get("directory");
      statusReads.push({ directory, auth: req.headers.authorization });
      res.end(JSON.stringify(statusByDirectory[directory ?? ""] ?? {}));
      return;
    }
    if (u.pathname === "/global/health") {
      res.end(JSON.stringify({ healthy: true, version: "v1.18.29" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, statusReads, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("#1766 — end to end: real fleet read handler → the app's parse", () => {
  let root: string;
  let local: Stub;
  let peer: Stub;
  let savedHubFile: string | undefined;
  const ENGINE_PW = "engine-mint-e2e-1766";
  const PEER_TOKEN = "tok-peer-e2e-1766";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1766-e2e-"));
    savedHubFile = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = join(root, "hub-cred-absent.json");
    local = await startEngine([{ id: E2E.localSession, directory: E2E.localDirectory }], {}, ENGINE_PW);
    peer = await startEngine(
      [
        { id: E2E.peerBusySession, directory: E2E.peerDirectory },
        { id: E2E.peerQuietSession, directory: E2E.peerDirectory },
      ],
      // the stubbed OWNER reports the pinned session busy, keyed by the SAME raw id
      { [E2E.peerDirectory]: { [E2E.peerBusySession]: { type: "busy" } } },
      PEER_TOKEN,
    );
  });

  afterAll(async () => {
    await local.stop();
    await peer.stop();
    if (savedHubFile === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFile;
    rmSync(root, { recursive: true, force: true });
  });

  it("the real handler's answer is exactly the fixture, and the app's parse turns it into busy for that exact session id", async () => {
    const svc = createAmicodeService({
      password: "service-own-mint",
      engine: { password: ENGINE_PW, getUrl: () => local.url },
      fleet: {
        hub: { getUrl: () => undefined },
        observationOnly: true,
        fleetPeers: {
          localMachineId: E2E.localMachine,
          getServingPeers: () => [{ machineId: E2E.peerMachine }],
          readPeerToken: (id: string) =>
            id === E2E.peerMachine
              ? { ok: true as const, credential: { baseUrl: peer.url, token: PEER_TOKEN } }
              : { ok: false as const },
          rosterLookup: (id: string) => ({ name: id }),
        },
      },
    });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      // the app's request: its pinned ids, viewed first, one `ids` parameter
      const url = `${origin}/amicode/fleet/session-status?ids=${encodeURIComponent(E2E.pinnedIds.join(","))}`;
      let status = 0;
      let body: unknown;
      const deadline = Date.now() + 5000;
      // the OwnerMapFeed fills asynchronously — exactly the cold-start lag the
      // app's `unknown` retries absorb; poll until the owner map has caught up
      for (;;) {
        const res = await fetch(url, { headers: { Authorization: `Basic ${serverAuthToken(ENGINE_PW)}` } });
        status = res.status;
        body = await res.json();
        const unresolved = (body as { unresolved?: Array<{ id: string }> }).unresolved ?? [];
        if (unresolved.length === FLEET_STATUS_E2E_RESPONSE.unresolved.length || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      // (1) the real handler emits EXACTLY what the app half consumes
      expect(status).toBe(200);
      expect(body).toEqual(FLEET_STATUS_E2E_RESPONSE);
      // the owner was asked in the session's exact directory, with ITS token
      expect(peer.statusReads.length).toBeGreaterThan(0);
      for (const r of peer.statusReads) {
        expect(r.directory).toBe(E2E.peerDirectory);
        expect(r.auth).toBe(serverAuthHeader(PEER_TOKEN));
      }

      // (2) the app's own parse of the live response
      const parsed = parseFleetStatusResponse(status, body);
      expect(parsed.kind).toBe("ok");
      if (parsed.kind !== "ok") return;
      expect(parsed.statuses[E2E.peerBusySession]).toEqual({ type: "busy" });
      expect(parsed.statuses[E2E.peerQuietSession]).toEqual({ type: "idle" }); // idle by absence
      expect(parsed.statuses[E2E.unknownSession]).toBeUndefined(); // omitted, never idle
      expect(parsed.dropped).toBe(0);
    } finally {
      await svc.stop();
    }
  });
});

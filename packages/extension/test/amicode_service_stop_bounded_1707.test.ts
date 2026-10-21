// #1707: stop() must be BOUNDED. A bare server.close() waits for every open
// keep-alive socket to end — and the hub frontdoor holds long-lived pooled
// backend sockets to the service origin, so a stop could park the unit in
// "deactivating" anywhere between 6 seconds and systemd's SIGKILL (three
// wedged hub stops on 2026-10-04). This pins the contract: a held-open socket
// (the frontdoor's pooled connection, simulated as a raw client that sends
// half a request line and waits) can NOT stall stop() beyond the grace —
// the sockets are destroyed and the promise resolves.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import { createAmicodeService, type AmicodeServiceServer } from "../src/amicode_service";

/** The mock engine (the auth-mode test's harness shape): /session answers JSON. */
async function startMockEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, engine: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A held-open socket: connects, sends half a request header, waits forever —
 * exactly the shape of the frontdoor's parked pooled connection. */
function openHeldSocket(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    sock.once("connect", () => {
      sock.write("GET /session HTTP/1.1\r\nHost: 127.0.0.1\r\n"); // no blank line: the server must wait for more
      resolve(sock);
    });
    sock.once("error", reject);
  });
}

describe("amicode service — bounded stop (#1707, the frontdoor-socket wedge)", () => {
  let engine: Awaited<ReturnType<typeof startMockEngine>>;

  beforeAll(async () => {
    engine = await startMockEngine();
  });

  afterAll(async () => {
    await engine.stop();
  });

  it("stop() resolves within the grace even with a held-open keep-alive socket", async () => {
    const service: AmicodeServiceServer = createAmicodeService({
      authMode: "open",
      engine: { getUrl: () => engine.url },
    });
    await service.start(0);
    const port = (service.server!.address() as AddressInfo).port;
    const held = await openHeldSocket(port);
    try {
      // The held socket's destruction is the fix working; either way it must
      // not outlive the stop.
      const heldClosed = new Promise<void>((r) => held.once("close", r));

      // STOP_GRACE_MS is 2000; allow generous harness slack, but far under the
      // minutes-long wedge this replaces.
      const bounded = await Promise.race([
        service.stop().then(() => "stopped" as const),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
      ]);
      expect(bounded).toBe("stopped");
      await Promise.race([heldClosed, new Promise<void>((r) => setTimeout(r, 2000))]);
      expect(held.destroyed).toBe(true);
    } finally {
      held.destroy();
      if (service.server) await service.stop().catch(() => undefined);
    }
  });

  it("stop() stays fast with no held sockets (the 6-second stops stay 6-second)", async () => {
    const service = createAmicodeService({
      authMode: "open",
      engine: { getUrl: () => engine.url },
    });
    await service.start(0);
    const t0 = Date.now();
    await service.stop();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

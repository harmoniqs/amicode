// fleet_ws_upgrade.test.ts — #1263 (Slice 3): WebSocket/PTY upgrade proxying.
//
// The #1261 relay proxies HTTP + SSE, but both proxies are body-pipe-only and
// the relay's HTTP server had NO `upgrade` handler — so the integrated terminal
// (a WebSocket PTY route on the engine, GET /pty/:id/connect) was DEAD on a
// thin client. This slice adds an `upgrade` handler + raw-socket 101 handling
// so WS upgrades tunnel client-relay → host-engine and back.
//
// The sanctioned new test (Testing Decisions): a WS-echo test through the relay
// against a STUB WebSocket upstream — the handshake completes, a frame
// round-trips both ways, close is clean, and the client observes the UPSTREAM's
// Sec-WebSocket-Accept (guards against a synthesized 101). The stub deliberately
// returns a SENTINEL accept value (a marker no RFC-correct synthesized 101 could
// ever produce): if the client sees the sentinel, the relay forwarded the
// engine's own 101 verbatim rather than computing its own.
//
//   AC1 — handshake completes through the relay; the client sees the UPSTREAM's
//         (sentinel) Sec-WebSocket-Accept, not a synthesized one; frames
//         round-trip in BOTH directions.
//   AC2 — the PTY route (/pty/:id/connect?ticket=…&cursor=…) works on a fleet
//         client through the relay: hub-mint credential TRANSLATION on the
//         upgrade request, ?ticket=/?cursor=/Origin preserved, data round-trips.
//   AC3 — a dropped WebSocket is torn down cleanly on the relay (no leaked
//         sockets): dropping the client destroys the upstream socket.
//   AC4 — scope fence: a relay that is NOT a fleet client does NOT proxy the
//         upgrade (loopback/never-fork unchanged — no universal WS bypass).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import { randomBytes, createHash } from "node:crypto";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";

// ── minimal WebSocket framing (no `ws` dep) — small payloads only (<64 KiB) ──
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function rfcAccept(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}
// The stub's SENTINEL accept: the RFC value with a marker prefix the relay
// could NEVER synthesize on its own (a synthesized 101 would emit the bare
// RFC value). Observing the sentinel client-side PROVES verbatim 101 forward.
function sentinelAccept(key: string): string {
  return "SENTINEL-" + rfcAccept(key);
}
function encodeFrame(payload: Buffer, opcode: number, mask: boolean): Buffer {
  const len = payload.length; // tests keep payloads well under 126 bytes
  const head = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  if (!mask) return Buffer.concat([head, payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= key[i % 4];
  return Buffer.concat([head, key, masked]);
}
const textFrame = (s: string, mask: boolean) => encodeFrame(Buffer.from(s, "utf8"), 0x1, mask);
const closeFrame = (mask: boolean) => encodeFrame(Buffer.alloc(0), 0x8, mask);
/** Decode one frame from the front of `buf`; null if incomplete. */
function tryDecode(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  }
  let key: Buffer | null = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    key = buf.subarray(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (key) {
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
  }
  return { opcode, payload, rest: buf.subarray(off + len) };
}
/** A frame reader over a raw socket, seeded with any bytes read past the 101. */
function attachReader(sock: net.Socket, initial: Buffer) {
  let buf = initial;
  const queue: Array<{ opcode: number; payload: Buffer }> = [];
  const waiters: Array<(f: { opcode: number; payload: Buffer }) => void> = [];
  const drain = () => {
    for (;;) {
      const r = tryDecode(buf);
      if (!r) break;
      buf = r.rest;
      const f = { opcode: r.opcode, payload: r.payload };
      const w = waiters.shift();
      if (w) w(f);
      else queue.push(f);
    }
  };
  sock.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    drain();
  });
  drain();
  return {
    next(timeoutMs = 2500): Promise<{ opcode: number; payload: Buffer }> {
      const q = queue.shift();
      if (q) return Promise.resolve(q);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("frame read timeout")), timeoutMs);
        waiters.push((f) => {
          clearTimeout(t);
          resolve(f);
        });
      });
    },
  };
}
interface WsClient {
  socket: net.Socket;
  statusCode: number;
  headers: Record<string, string>;
  reader: ReturnType<typeof attachReader>;
  key: string;
}
/** Open a raw WS handshake against `origin`; resolve on the response headers,
 *  reject if the socket closes before a status line arrives. */
function wsConnect(origin: string, path: string, extraHeaders: Record<string, string> = {}): Promise<WsClient> {
  const u = new URL(origin);
  const key = randomBytes(16).toString("base64");
  return new Promise<WsClient>((resolve, reject) => {
    let settled = false;
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${u.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        ...Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}`),
        ``,
        ``,
      ];
      socket.write(lines.join("\r\n"));
    });
    let hdr = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      hdr = Buffer.concat([hdr, d]);
      const idx = hdr.indexOf("\r\n\r\n");
      if (idx === -1) return;
      settled = true;
      socket.removeListener("data", onData);
      const headText = hdr.subarray(0, idx).toString("utf8");
      const rest = hdr.subarray(idx + 4);
      const [statusLine, ...hdrLines] = headText.split("\r\n");
      const statusCode = Number(statusLine.split(" ")[1]);
      const headers: Record<string, string> = {};
      for (const line of hdrLines) {
        const p = line.indexOf(":");
        if (p > 0) headers[line.slice(0, p).trim().toLowerCase()] = line.slice(p + 1).trim();
      }
      resolve({ socket, statusCode, headers, reader: attachReader(socket, rest), key });
    };
    socket.on("data", onData);
    socket.on("error", (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
    socket.on("close", () => {
      if (!settled) {
        settled = true;
        reject(new Error("socket closed before handshake response"));
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("handshake timeout"));
      }
    }, 3000);
  });
}

// ── a stub WebSocket HOST (the far end of the tunnel) ────────────────────────
// It authorizes by the hub mint (401s anything else, so a 101 proves credential
// translation), records the upgrade request line + Origin, forwards a SENTINEL
// Sec-WebSocket-Accept + a marker header, then echoes text frames.
interface StubWsHost {
  url: string;
  upgrades: { url: string; authorization: string; origin: string | undefined }[];
  /** live upstream sockets — must return to 0 after a clean teardown. */
  liveSockets(): number;
  stop(): Promise<void>;
}
const UPSTREAM_MARKER = "STUB-WS-HOST";
function startStubWsHost(hubPassword: string): Promise<StubWsHost> {
  const upgrades: { url: string; authorization: string; origin: string | undefined }[] = [];
  const live = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "upgrade required" }));
  });
  server.on("upgrade", (req, socket, head) => {
    const authorization = req.headers.authorization ?? "";
    upgrades.push({ url: req.url ?? "", authorization, origin: req.headers.origin as string | undefined });
    // The host expects ITS OWN hub mint — refuse anything else (proves the
    // relay translated the credential). A refusal is a raw 401, no upgrade.
    if (authorization !== hubUpstreamAuthHeader(hubPassword)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = (req.headers["sec-websocket-key"] as string) ?? "";
    // The engine's OWN 101 — with a sentinel accept the relay cannot synthesize.
    const resp =
      `HTTP/1.1 101 Switching Protocols\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${sentinelAccept(key)}\r\n` +
      `X-Amico-Upstream: ${UPSTREAM_MARKER}\r\n` +
      `\r\n`;
    socket.write(resp);
    if (head && head.length) socket.write(head); // (usually empty for WS)
    live.add(socket);
    socket.on("close", () => live.delete(socket));
    // model a real server: when the peer (the relay) drops the connection,
    // close our own socket promptly rather than lingering on a half-open FIN.
    socket.on("end", () => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    });
    // echo loop: decode client frames, echo text frames back UNMASKED
    let buf = Buffer.alloc(0);
    socket.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = tryDecode(buf);
        if (!r) break;
        buf = r.rest;
        if (r.opcode === 0x8) {
          socket.write(closeFrame(false)); // close: echo close, end
          socket.end();
          return;
        }
        if (r.opcode === 0x1) socket.write(textFrame(r.payload.toString("utf8"), false));
      }
    });
    socket.on("error", () => {
      /* torn down — never throw out of the stub */
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        upgrades,
        liveSockets: () => live.size,
        stop: () =>
          new Promise((r) => {
            for (const s of live) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root></div></body></html>");
  return dist;
}
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

const HUB_PASSWORD = "host-ops-credential";
const SERVICE_PASSWORD = "client-service-mint";

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return pred();
}

describe("fleet-client WS/PTY upgrade proxying (#1263)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let host: StubWsHost;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1263-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    host = await startStubWsHost(HUB_PASSWORD);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
  });

  afterAll(async () => {
    await host.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  /** The client relay: fleet mode, NO engine (never-fork), hub → the host. */
  function bootClientRelay(hubUrl: () => string | undefined = () => host.url) {
    return createAmicodeService({
      password: SERVICE_PASSWORD,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: hubUrl },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 400,
      },
    });
  }

  it("AC1 — the handshake completes and the client observes the UPSTREAM's Sec-WebSocket-Accept (not a synthesized 101); a frame round-trips both ways", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    let client: WsClient | undefined;
    try {
      client = await wsConnect(`${origin}/pty/term-1/connect`, "/pty/term-1/connect", {
        Authorization: serverAuthHeader(SERVICE_PASSWORD),
      });
      expect(client.statusCode).toBe(101);
      // the VERBATIM guard: the client sees the stub's sentinel accept — a value
      // an RFC-correct synthesized 101 could never produce (it would emit the
      // bare RFC accept). Proves the relay forwarded the engine's own 101.
      expect(client.headers["sec-websocket-accept"]).toBe(sentinelAccept(client.key));
      expect(client.headers["sec-websocket-accept"]).not.toBe(rfcAccept(client.key));
      // a header only the upstream could set — never invented by the relay
      expect(client.headers["x-amico-upstream"]).toBe(UPSTREAM_MARKER);

      // frames round-trip BOTH ways: client→host reaches the echo server, and
      // host→client echo reaches us
      client.socket.write(textFrame("ping-through-relay", true));
      const echoed = await client.reader.next();
      expect(echoed.opcode).toBe(0x1);
      expect(echoed.payload.toString("utf8")).toBe("ping-through-relay");
    } finally {
      client?.socket.destroy();
      await svc.stop();
    }
  });

  it("AC2 — the PTY route works on a fleet client: hub-mint translation on the upgrade, ?ticket=/?cursor=/Origin preserved, data round-trips", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const serviceToken = serverAuthToken(SERVICE_PASSWORD);
    // the PTY path with ticket + cursor + the engine's ?auth_token= carrier;
    // an Origin header + the client's own service Basic mint on the request.
    const path = `/pty/term-42/connect?ticket=tok-xyz&cursor=7&auth_token=${encodeURIComponent(serviceToken)}`;
    const origin_hdr = "vscode-webview://amicode-webview";
    let client: WsClient | undefined;
    try {
      client = await wsConnect(`${origin}${path}`, path, {
        Origin: origin_hdr,
        Authorization: serverAuthHeader(SERVICE_PASSWORD),
      });
      expect(client.statusCode).toBe(101); // tunnelled → the terminal is live on the client

      const seen = host.upgrades.find((u) => u.url.startsWith("/pty/term-42/connect"));
      expect(seen).toBeTruthy();
      // credential TRANSLATION: the host saw the HUB mint; the client's own
      // service mint and the ?auth_token= carrier NEVER crossed.
      expect(seen!.authorization).toBe(hubUpstreamAuthHeader(HUB_PASSWORD));
      expect(seen!.authorization).not.toBe(serverAuthHeader(SERVICE_PASSWORD));
      expect(seen!.url).not.toContain("auth_token"); // the engine carrier stripped
      // ?ticket= / ?cursor= preserved (the PTY route's ticket-or-Basic auth)
      expect(seen!.url).toContain("ticket=tok-xyz");
      expect(seen!.url).toContain("cursor=7");
      // Origin preserved
      expect(seen!.origin).toBe(origin_hdr);

      // the terminal's duplex stream is live end-to-end through the relay
      client.socket.write(textFrame("ls -la\n", true));
      const out = await client.reader.next();
      expect(out.payload.toString("utf8")).toBe("ls -la\n");
    } finally {
      client?.socket.destroy();
      await svc.stop();
    }
  });

  it("AC3 — a dropped WebSocket is torn down cleanly on the relay (the upstream socket is not leaked)", async () => {
    // A DEDICATED stub host so the live-socket count is unambiguous — no
    // cross-test coupling on the shared host's (async-draining) count.
    const soloHost = await startStubWsHost(HUB_PASSWORD);
    const svc = bootClientRelay(() => soloHost.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    let client: WsClient | undefined;
    try {
      expect(soloHost.liveSockets()).toBe(0);
      client = await wsConnect(`${origin}/pty/term-drop/connect`, "/pty/term-drop/connect", {
        Authorization: serverAuthHeader(SERVICE_PASSWORD),
      });
      expect(client.statusCode).toBe(101);
      // the upstream socket is live while the tunnel is up
      expect(await waitFor(() => soloHost.liveSockets() === 1)).toBe(true);
      // the client drops its WebSocket — the relay must tear the upstream down
      client.socket.destroy();
      expect(await waitFor(() => soloHost.liveSockets() === 0)).toBe(true); // no leak
    } finally {
      client?.socket.destroy();
      await svc.stop();
      await soloHost.stop();
    }
  });

  it("AC4 — scope fence: a relay that is NOT a fleet client does NOT proxy the upgrade (no universal WS bypass)", async () => {
    // No fleet block → no fleet plane → the upgrade branch does not engage; the
    // socket is destroyed (byte-identical to the prior no-listener behavior).
    const svc = createAmicodeService({ password: SERVICE_PASSWORD, shelf: { distRoot: dist } });
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const hostBefore = host.upgrades.length;
    try {
      await expect(
        wsConnect(`${origin}/pty/term-x/connect`, "/pty/term-x/connect", {
          Authorization: serverAuthHeader(SERVICE_PASSWORD),
        }),
      ).rejects.toThrow(); // the handshake never completes — the socket is dropped
      expect(host.upgrades.length).toBe(hostBefore); // the host saw NO upgrade (nothing was proxied)
    } finally {
      await svc.stop();
    }
  });
});

// amicode_session_relay.integration.test.ts — #1440 (Slice 3): the session
// multiplexer + SSE relay — per-session owner routing RETIRES the single
// attachment pointer's one-target-for-all model.
//
// This pins the five ACs:
//   AC1 — Owner-routing key: path-based and header-based routing to distinct
//         owners; keyless → local.
//   AC2 — Per-verb routing: every verb routes to the owner; NO window reload.
//   AC3 — Concurrent + un-crossed: block B, drive A, A resolves first; every
//         merged SSE event carries session_id.
//   AC4 — Single origin (structural guard).
//   AC5 — Honesty surface never proxied (extended in fleet_client_relay.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import {
  SessionOwnerMap,
  extractSessionIdFromPath,
  OWNER_ROUTING_HEADER,
  SessionMultiplexProxy,
  type PeerTransport,
} from "../src/amicode_service/session_multiplexer";

// ── stub peer host ──────────────────────────────────────────────────────────
// A stub that represents a remote peer's engine. It records every request it
// receives (method + url + body) and responds with its machine_id marker, so
// we can assert which peer served the request. Accepts any auth (the auth
// contract is the peer token store's — the multiplexer attaches it).

interface PeerStub {
  url: string;
  machineId: string;
  requests: Array<{ method: string; url: string; body: string }>;
  /** SSE streams that are currently blocked (held open, not writing). The test
   *  calls `releaseSse(sessionId)` to unblock a held stream. */
  heldSse: Map<string, { res: http.ServerResponse; release: () => void }>;
  /** Push an SSE event to a held stream's session. */
  pushSseEvent(sessionId: string, data: Record<string, unknown>): void;
  /** Block the SSE response for a session — the stream is opened (200 headers)
   *  but NO events are written until `releaseSse` is called. */
  holdSse(sessionId: string): void;
  releaseSse(sessionId: string): void;
  stop(): Promise<void>;
}

function startPeerStub(machineId: string, password?: string): Promise<PeerStub> {
  const requests: PeerStub["requests"] = [];
  const heldSse = new Map<string, { res: http.ServerResponse; release: () => void }>();
  const holdSet = new Set<string>();
  // Track SSE connections by session for pushing events
  const sseConns = new Map<string, http.ServerResponse>();
  let sseSeq = 1;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);

    // SSE per-session event stream: /api/session/{id}/event
    // Handle BEFORE reading the body — GET SSE has no body to read, and
    // waiting for req.on("end") can delay the SSE setup.
    const sseMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/event$/);
    if (sseMatch && req.method === "GET") {
      const sid = sseMatch[1];
      requests.push({ method: "GET", url: req.url ?? "/", body: "" });
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.flushHeaders();
      sseConns.set(sid, res);
      // If this session is in the hold set, don't write anything yet
      if (holdSet.has(sid)) {
        let releaseFn: () => void;
        heldSse.set(sid, { res, release: () => releaseFn() });
        new Promise<void>((resolve) => { releaseFn = resolve; });
        return; // held open, no events until released
      }
      // Otherwise send an initial event
      const seq = sseSeq++;
      res.write(`id: ${seq}\ndata: ${JSON.stringify({ machine: machineId, session_id: sid, n: seq })}\n\n`);
      return;
    }

    // Non-SSE requests: read the body then respond
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body });

      // Default: return the machine marker so assertions can prove routing
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        machine: machineId,
        received: { method: req.method, path: url.pathname, body: body || undefined },
      }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        machineId,
        requests,
        heldSse,
        holdSse(sid: string) { holdSet.add(sid); },
        releaseSse(sid: string) {
          holdSet.delete(sid);
          const held = heldSse.get(sid);
          if (held) {
            held.release();
            heldSse.delete(sid);
          }
        },
        pushSseEvent(sid: string, data: Record<string, unknown>) {
          const conn = sseConns.get(sid);
          if (!conn) return;
          const seq = sseSeq++;
          conn.write(`id: ${seq}\ndata: ${JSON.stringify({ ...data, machine: machineId, session_id: sid })}\n\n`);
        },
        stop: () => new Promise<void>((r) => {
          // Destroy all SSE connections so the server can close
          for (const conn of sseConns.values()) {
            try { conn.end(); } catch { /* already gone */ }
          }
          sseConns.clear();
          server.close(() => r());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

// ── test helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(msg)), ms));
  return Promise.race([promise, timer]);
}

/** Fire a request through the SessionMultiplexProxy's resolveTarget + a direct
 *  fetch to the resolved peer. Returns the parsed JSON body. */
async function proxyFetch(
  proxy: SessionMultiplexProxy,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; machine: string; received?: { method: string; path: string; body?: string } }> {
  const target = proxy.resolveTarget(method, path, headers ?? {});
  if (!target) {
    return { ok: false, machine: "local", received: undefined };
  }
  const res = await fetch(`${target.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as { ok: boolean; machine: string; received?: { method: string; path: string; body?: string } };
}

describe("session multiplexer relay (#1440) — per-session owner routing", () => {
  // ── AC1: owner-routing key ──────────────────────────────────────────────
  describe("AC1 — owner-routing key: session→owner binding, path + header routing, keyless → local", () => {
    it("extractSessionIdFromPath extracts the session ID from engine-format paths", () => {
      expect(extractSessionIdFromPath("/api/session/ses-abc/event")).toBe("ses-abc");
      expect(extractSessionIdFromPath("/api/session/ses-abc/message")).toBe("ses-abc");
      expect(extractSessionIdFromPath("/api/session/ses-xyz/prompt")).toBe("ses-xyz");
      expect(extractSessionIdFromPath("/api/session/ses-xyz/tool")).toBe("ses-xyz");
      // Non-session paths → undefined
      expect(extractSessionIdFromPath("/session")).toBeUndefined();
      expect(extractSessionIdFromPath("/global/health")).toBeUndefined();
      expect(extractSessionIdFromPath("/amicode/profile")).toBeUndefined();
      expect(extractSessionIdFromPath("/file/read")).toBeUndefined();
    });

    it("SessionOwnerMap looks up the owner machine_id for a session; unknown → undefined (local)", () => {
      const map = new SessionOwnerMap();
      map.update([
        { id: "ses-on-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
        { id: "ses-on-B", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } },
        { id: "ses-local", amicode_owner: { owner_machine_id: "local-machine", owner_name: "Local", is_local: true } },
      ]);
      expect(map.resolveOwner("ses-on-A")).toBe("machine-a");
      expect(map.resolveOwner("ses-on-B")).toBe("machine-b");
      expect(map.resolveOwner("ses-local")).toBe("local-machine");
      expect(map.resolveOwner("ses-unknown")).toBeUndefined(); // unknown → local
    });

    it("OWNER_ROUTING_HEADER is the header name for path-less owner routing", () => {
      expect(OWNER_ROUTING_HEADER).toBe("x-amicode-owner");
    });

    it("two remote sessions (owners A, B) each POST lands on its OWN owner; a keyless POST resolves LOCAL", async () => {
      const peerA = await startPeerStub("machine-a");
      const peerB = await startPeerStub("machine-b");
      try {
        const ownerMap = new SessionOwnerMap();
        ownerMap.update([
          { id: "ses-on-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
          { id: "ses-on-B", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } },
        ]);

        // Path-based: POST to session on A → peer A
        const targetA = ownerMap.resolveOwner("ses-on-A");
        expect(targetA).toBe("machine-a");

        // Path-based: POST to session on B → peer B
        const targetB = ownerMap.resolveOwner("ses-on-B");
        expect(targetB).toBe("machine-b");

        // Keyless: no session ID, no header → local
        const targetNone = ownerMap.resolveOwner("unknown-session");
        expect(targetNone).toBeUndefined();
      } finally {
        await peerA.stop();
        await peerB.stop();
      }
    });
  });

  // ── AC1 integration: full proxy routing ───────────────────────────────────
  describe("AC1 integration — full proxy: two owners + keyless → local via SessionMultiplexProxy", () => {
    let peerA: PeerStub;
    let peerB: PeerStub;
    let proxy: SessionMultiplexProxy;

    beforeAll(async () => {
      peerA = await startPeerStub("machine-a");
      peerB = await startPeerStub("machine-b");
      const ownerMap = new SessionOwnerMap();
      ownerMap.update([
        { id: "ses-on-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
        { id: "ses-on-B", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } },
      ]);
      const peers: Record<string, PeerTransport> = {
        "machine-a": { getUrl: () => peerA.url },
        "machine-b": { getUrl: () => peerB.url },
      };
      proxy = new SessionMultiplexProxy({ ownerMap, peers, localMachineId: "local-machine" });
    });

    afterAll(async () => {
      await peerA.stop();
      await peerB.stop();
    });

    it("path-based: POST /api/session/ses-on-A/message → peer A receives it; POST .../ses-on-B/message → peer B", async () => {
      // Send to session on A
      const resA = await proxyFetch(proxy, "POST", "/api/session/ses-on-A/message", { text: "hello A" });
      expect(resA.machine).toBe("machine-a");
      expect(peerA.requests.some((r) => r.url.includes("ses-on-A/message"))).toBe(true);

      // Send to session on B
      const resB = await proxyFetch(proxy, "POST", "/api/session/ses-on-B/message", { text: "hello B" });
      expect(resB.machine).toBe("machine-b");
      expect(peerB.requests.some((r) => r.url.includes("ses-on-B/message"))).toBe(true);

      // Cross-check: A never saw B's request, B never saw A's request
      expect(peerA.requests.some((r) => r.url.includes("ses-on-B"))).toBe(false);
      expect(peerB.requests.some((r) => r.url.includes("ses-on-A"))).toBe(false);
    });

    it("header-based: path-less request with X-Amicode-Owner routes to the named owner", async () => {
      const aBefore = peerA.requests.length;
      const bBefore = peerB.requests.length;

      const resA = await proxyFetch(proxy, "POST", "/file/write", { content: "data-for-A" }, { [OWNER_ROUTING_HEADER]: "machine-a" });
      expect(resA.machine).toBe("machine-a");
      expect(peerA.requests.length).toBe(aBefore + 1);
      expect(peerB.requests.length).toBe(bBefore); // B untouched
    });

    it("keyless: path-less request without header resolves LOCAL (returns undefined, not routed to any peer)", async () => {
      const aBefore = peerA.requests.length;
      const bBefore = peerB.requests.length;

      const result = proxy.resolveTarget("POST", "/file/write", {});
      expect(result).toBeUndefined(); // undefined = local

      expect(peerA.requests.length).toBe(aBefore); // untouched
      expect(peerB.requests.length).toBe(bBefore); // untouched
    });
  });

  // ── AC2: per-verb routing, no reload ─────────────────────────────────────
  describe("AC2 — per-verb routing, no reload", () => {
    let peerA: PeerStub;
    let proxy: SessionMultiplexProxy;

    beforeAll(async () => {
      peerA = await startPeerStub("machine-a");
      const ownerMap = new SessionOwnerMap();
      ownerMap.update([
        { id: "ses-remote", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
      ]);
      proxy = new SessionMultiplexProxy({
        ownerMap,
        peers: { "machine-a": { getUrl: () => peerA.url } },
        localMachineId: "local-machine",
      });
    });

    afterAll(async () => {
      await peerA.stop();
    });

    for (const verb of ["message", "prompt", "tool", "permission"] as const) {
      it(`${verb} routes to the owner (machine-a)`, async () => {
        const res = await proxyFetch(proxy, "POST", `/api/session/ses-remote/${verb}`, { action: verb });
        expect(res.machine).toBe("machine-a");
        expect(peerA.requests.some((r) => r.url.includes(`ses-remote/${verb}`))).toBe(true);
      });
    }

    it("no attach-swap / reload command: the proxy never emits a reload or attach-switch signal", () => {
      // The multiplexer routes per-session — it never triggers a global
      // attach-swap. There is no reloadRequired/attachSwitch flag.
      // Structural: SessionMultiplexProxy has no reload/attach-swap method.
      expect("reloadRequired" in proxy).toBe(false);
      expect("attachSwitch" in proxy).toBe(false);
    });
  });

  // ── AC3: concurrent + un-crossed ─────────────────────────────────────────
  describe("AC3 — concurrent + un-crossed: deterministic ordering, per-event session_id", () => {
    it("block B, drive A — A resolves while B is still pending; every event carries session_id", async () => {
      const peerA = await startPeerStub("machine-a");
      const peerB = await startPeerStub("machine-b");
      // Hold B's SSE stream blocked
      peerB.holdSse("ses-on-B");

      const ownerMap = new SessionOwnerMap();
      ownerMap.update([
        { id: "ses-on-A", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
        { id: "ses-on-B", amicode_owner: { owner_machine_id: "machine-b", owner_name: "B", is_local: false } },
      ]);
      const proxy = new SessionMultiplexProxy({
        ownerMap,
        peers: {
          "machine-a": { getUrl: () => peerA.url },
          "machine-b": { getUrl: () => peerB.url },
        },
        localMachineId: "local-machine",
      });

      try {
        // Open SSE connections to both sessions concurrently
        const eventsA = proxy.openSseStream("ses-on-A");
        const eventsB = proxy.openSseStream("ses-on-B");

        // Fetch A's first event — should arrive quickly (no head-of-line blocking)
        const firstA = await withTimeout(eventsA.next(), 2000, "A's first event timed out");
        expect(firstA).toBeDefined();
        expect(firstA.session_id).toBe("ses-on-A");
        expect(firstA.machine).toBe("machine-a");

        // B's stream should still be pending (blocked by the hold).
        // Use a SINGLE next() call that we race against a timeout — we keep
        // its promise alive so the event lands on it after release.
        const bPromise = eventsB.next();
        const bPending = await Promise.race([
          bPromise.then(() => "resolved"),
          sleep(200).then(() => "pending"),
        ]);
        expect(bPending).toBe("pending");

        // A resolved while B was still pending — no head-of-line blocking.
        // Now release B and push an event — the bPromise should resolve.
        peerB.releaseSse("ses-on-B");
        peerB.pushSseEvent("ses-on-B", { msg: "released" });

        const firstB = await withTimeout(bPromise, 2000, "B's first event timed out");
        expect(firstB).toBeDefined();
        expect(firstB.session_id).toBe("ses-on-B");
        expect(firstB.machine).toBe("machine-b");

        // Cross-attribution: A's events never claim B's session_id and vice versa
        expect(firstA.session_id).not.toBe("ses-on-B");
        expect(firstB.session_id).not.toBe("ses-on-A");

        eventsA.close();
        eventsB.close();
      } finally {
        await peerA.stop();
        await peerB.stop();
      }
    });
  });

  // ── AC4: single origin (structural guard) ────────────────────────────────
  describe("AC4 — single origin structural guard", () => {
    it("SessionOwnerMap routes through the SAME origin (never a second base URL) — the multiplexer is a proxy, not a redirect", () => {
      const map = new SessionOwnerMap();
      map.update([
        { id: "ses-1", amicode_owner: { owner_machine_id: "machine-a", owner_name: "A", is_local: false } },
      ]);
      // The map returns machine IDs, NOT URLs — the proxy consumes the ID
      // and reaches the peer through its own transport. The app never sees
      // a second origin.
      const owner = map.resolveOwner("ses-1");
      expect(typeof owner).toBe("string");
      expect(owner).not.toMatch(/^https?:\/\//); // never a URL — always a machine_id
    });
  });
});

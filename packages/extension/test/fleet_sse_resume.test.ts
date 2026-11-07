// fleet_sse_resume.test.ts — #1264 (Slice 4): lossless SSE reconnect (cursor
// resume) for the PER-SESSION event stream.
//
// A fleet CLIENT relays the engine data plane to the HOST over the tunnel
// (#1261). When that tunnel blips, the client's event stream today sends no
// Last-Event-ID and drops every event in the gap. The engine's per-session
// route `/api/session/{id}/event?after=<seq>` is RESUMABLE ("Replay durable
// events after an aggregate sequence, then continue with new durable events")
// but unused. This slice makes the RELAY carry each session's last aggregate
// `seq` across reconnects and resume via `?after=`, so a blip REPLAYS that
// session's gap instead of dropping it — with client-side boundary dedupe so
// the resume is idempotent (no double-delivery).
//
// Scope (issue #1264): the PER-SESSION stream ONLY. The multiplexed `/event`
// (per-instance) and `/global/event` streams have NO resumable form (they emit
// `id: undefined`) — they are OUT of scope here and MUST be left as-is (AC3),
// not silently assumed resumable. That is separate engine work.
//
// Reuses #1261's stub-host relay harness (fleet_client_relay.test.ts), extended
// with a resumable per-session event stream that honors `?after=`.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";

// ── a stub HOST whose per-session event stream is RESUMABLE via ?after= ───────
// It models the engine's `/api/session/{sessionID}/event` route: a durable,
// growing per-session event log (aggregate seqs 1..N). A request replays the
// log from its `?after=` cursor — INCLUSIVE of the boundary seq (an adversarial
// overlap), so a correct client must dedupe the boundary. The stream then holds
// open (the live tail); the relay/test tears it down. The host expects its OWN
// hub mint (401s anything else) — a 200 also proves credential translation on
// the SSE path.
interface EventHost {
  url: string;
  /** Per session: the `?after=` value seen on each request (null when absent).
   *  The evidence the relay injected the cursor — and did so PER SESSION. */
  afterSeen: Record<string, (string | null)[]>;
  /** Every request line the host received (path + query). */
  requests: string[];
  /** Append newly-produced durable events to a session's log (the events that
   *  arrive DURING the outage, delivered on reconnect). */
  append(sessionID: string, ids: number[]): void;
  reset(): void;
  stop(): Promise<void>;
}

function startEventHost(hubPassword: string): Promise<EventHost> {
  const log: Record<string, number[]> = {};
  const afterSeen: Record<string, (string | null)[]> = {};
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== hubUpstreamAuthHeader(hubPassword)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/event$/);
    if (req.method === "GET" && sessionMatch) {
      const sid = sessionMatch[1];
      const after = url.searchParams.get("after");
      (afterSeen[sid] ??= []).push(after);
      res.writeHead(200, { "content-type": "text/event-stream" });
      // INCLUSIVE replay from the cursor (re-emit the boundary seq itself) — the
      // adversarial overlap a correct client must dedupe. No cursor → from 1.
      const from = after === null ? 1 : Number(after);
      for (const id of log[sid] ?? []) {
        if (id >= from) res.write(`id: ${id}\ndata: {"n":${id}}\n\n`);
      }
      // hold open (the live tail) — never ends on its own
      return;
    }
    // the multiplexed / global streams — NO cursor form (id: undefined). They
    // ride the same SSE pipe but are OUT of scope for resume (AC3).
    if (req.method === "GET" && (url.pathname === "/event" || url.pathname === "/global/event")) {
      (afterSeen[url.pathname] ??= []).push(url.searchParams.get("after"));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        afterSeen,
        requests,
        append: (sid, ids) => {
          (log[sid] ??= []).push(...ids);
        },
        reset: () => {
          for (const k of Object.keys(log)) delete log[k];
          for (const k of Object.keys(afterSeen)) delete afterSeen[k];
          requests.length = 0;
        },
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root></div></body></html>");
  writeFileSync(join(dist, "assets", "app.js"), "console.log('app bundle');\n");
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

/** Read SSE `id:` seqs off a relayed stream until `stop(ids)` is satisfied (the
 *  live tail never ends, so we read to a predicate, not to EOF), then return
 *  the seqs observed. Abort ends the read cleanly. */
async function readSeqsUntil(
  res: Response,
  stop: (ids: number[]) => boolean,
  timeoutMs = 2000,
): Promise<number[]> {
  const ids: number[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  const idle = Symbol("idle");
  try {
    while (Date.now() < deadline) {
      // race the read against the deadline — the live tail never ends, so a
      // read can block indefinitely; the deadline must still fire.
      const step = await Promise.race([
        reader.read(),
        new Promise<typeof idle>((r) => setTimeout(() => r(idle), Math.max(0, deadline - Date.now()))),
      ]);
      if (step === idle) break;
      if (step.done) break;
      buf += decoder.decode(step.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const idLine = block.split("\n").filter((l) => l.startsWith("id:")).pop();
        if (idLine) ids.push(Number(idLine.slice(3).trim()));
      }
      if (stop(ids)) break;
    }
  } catch {
    /* abort / stream torn down — return what we saw */
  }
  return ids;
}

describe("fleet per-session SSE resume (#1264) — lossless reconnect via ?after=", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let host: EventHost;
  let serviceToken: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-sse-resume-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    host = await startEventHost(HUB_PASSWORD);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    serviceToken = serverAuthToken(SERVICE_PASSWORD);
  });

  afterAll(async () => {
    await host.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => host.reset());

  /** The client relay: fleet mode, NO engine (never-fork), hub → the host. */
  function bootClientRelay() {
    return createAmicodeService({
      password: SERVICE_PASSWORD,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => host.url },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 400,
      },
    });
  }

  it("AC1 — a mid-stream disconnect loses ZERO events on reconnect (gap replayed, boundary deduped)", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const sid = "ses-resume-1";
    try {
      // three durable events exist; the client streams them, then the tunnel
      // blips (we abort the stream mid-flight).
      host.append(sid, [1, 2, 3]);
      const ctrl1 = new AbortController();
      const leg1 = await fetch(`${origin}/api/session/${sid}/event?auth_token=${encodeURIComponent(serviceToken)}`, {
        signal: ctrl1.signal,
      });
      expect(leg1.status).toBe(200); // 200 = the hub mint was translated onto the SSE path
      const seen1 = await readSeqsUntil(leg1, (ids) => ids.length >= 3);
      ctrl1.abort();
      expect(seen1).toEqual([1, 2, 3]);

      // events 4,5,6 are produced DURING the outage — the client missed them.
      host.append(sid, [4, 5, 6]);

      // reconnect: the relay must resume from this session's last seq (3) and
      // the host replays inclusively (3,4,5,6). Zero lost, no double at 3.
      const ctrl2 = new AbortController();
      const leg2 = await fetch(`${origin}/api/session/${sid}/event?auth_token=${encodeURIComponent(serviceToken)}`, {
        signal: ctrl2.signal,
      });
      const seen2 = await readSeqsUntil(leg2, (ids) => ids.includes(6));
      ctrl2.abort();

      // the RELAY injected the per-session cursor on reconnect (null first, "3" second)
      expect(host.afterSeen[sid]).toEqual([null, "3"]);
      // the gap (4,5,6) arrived — nothing lost
      expect(seen2).toEqual([4, 5, 6]);
      // and the whole stream is each seq exactly once — no double-delivery
      const all = [...seen1, ...seen2];
      expect(all).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(all).size).toBe(all.length);
    } finally {
      await svc.stop();
    }
  });

  it("AC2 — the cursor is PER SESSION (per aggregate), not one global cursor", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const auth = `auth_token=${encodeURIComponent(serviceToken)}`;
    // Drive one session's cursor to 3 and a DIFFERENT session's to 7 on the
    // SAME relay. A single global cursor would resume both from the last-seen
    // seq (7); a per-session store resumes each from its own.
    const drive = async (sid: string, upTo: number) => {
      host.append(sid, Array.from({ length: upTo }, (_, i) => i + 1));
      const ctrl = new AbortController();
      const res = await fetch(`${origin}/api/session/${sid}/event?${auth}`, { signal: ctrl.signal });
      const seen = await readSeqsUntil(res, (ids) => ids.includes(upTo));
      ctrl.abort();
      expect(seen).toEqual(Array.from({ length: upTo }, (_, i) => i + 1));
    };
    try {
      await drive("ses-A", 3);
      await drive("ses-B", 7);

      // reconnect each — the relay must resume A from 3 and B from 7 (each
      // session's OWN last seq), independently. The stub records the injected
      // `?after=` the moment it receives the request (before it writes headers),
      // so awaiting the fetch is enough — the replayed body is empty here (no
      // new events past each cursor), which is exactly the boundary dedupe.
      const reconnect = async (sid: string) => {
        const ctrl = new AbortController();
        await fetch(`${origin}/api/session/${sid}/event?${auth}`, { signal: ctrl.signal });
        ctrl.abort();
      };
      await reconnect("ses-A");
      await reconnect("ses-B");

      expect(host.afterSeen["ses-A"]).toEqual([null, "3"]);
      expect(host.afterSeen["ses-B"]).toEqual([null, "7"]);
    } finally {
      await svc.stop();
    }
  });

  it("AC3 — the non-resumable /event and /global/event streams are LEFT AS-IS (never given ?after=)", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const auth = `auth_token=${encodeURIComponent(serviceToken)}`;
    try {
      // First establish a per-session cursor, so a naive "one global cursor"
      // implementation would have something to (wrongly) inject onto the
      // multiplexed streams. The correct relay tracks per SESSION and leaves
      // the cursorless streams entirely alone.
      const sid = "ses-C";
      host.append(sid, [1, 2, 3, 4, 5]);
      const c0 = new AbortController();
      const s0 = await fetch(`${origin}/api/session/${sid}/event?${auth}`, { signal: c0.signal });
      await readSeqsUntil(s0, (ids) => ids.includes(5));
      c0.abort();
      expect(host.afterSeen[sid]).toEqual([null]); // cursor is now 5 for ses-C

      // the per-instance /event and the /global/event streams have NO cursor
      // form (the engine emits `id: undefined`); the relay must proxy them
      // verbatim — no `?after=` injected, not silently assumed resumable.
      const hitPassthrough = async (path: string) => {
        const ctrl = new AbortController();
        const res = await fetch(`${origin}${path}?${auth}`, { signal: ctrl.signal });
        expect(res.status).toBe(200); // still proxied through, unchanged
        ctrl.abort();
      };
      await hitPassthrough("/event");
      await hitPassthrough("/global/event");

      expect(host.afterSeen["/event"]).toEqual([null]); // NOT resumed
      expect(host.afterSeen["/global/event"]).toEqual([null]); // NOT resumed
    } finally {
      await svc.stop();
    }
  });

  it("AC4 — steady-state (no drop) is UNCHANGED: in-order, byte-verbatim, no cursor injected", async () => {
    const svc = bootClientRelay();
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    const sid = "ses-steady";
    try {
      host.append(sid, [1, 2, 3, 4, 5]);
      const ctrl = new AbortController();
      const res = await fetch(`${origin}/api/session/${sid}/event?auth_token=${encodeURIComponent(serviceToken)}`, {
        signal: ctrl.signal,
      });
      // capture the RAW relayed bytes (not just parsed ids) to prove the
      // dedupe/tee filter re-emits blocks byte-for-byte.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let raw = "";
      const deadline = Date.now() + 2000;
      const idle = Symbol("idle");
      while (Date.now() < deadline) {
        const step = await Promise.race([
          reader.read(),
          new Promise<typeof idle>((r) => setTimeout(() => r(idle), Math.max(0, deadline - Date.now()))),
        ]);
        if (step === idle || step.done) break;
        raw += decoder.decode(step.value, { stream: true });
        if (raw.includes(`{"n":5}`)) break;
      }
      ctrl.abort();

      // no cursor to resume on a first connect → no ?after= injected
      expect(host.afterSeen[sid]).toEqual([null]);
      // every event delivered, in order, byte-verbatim (framing intact)
      expect(raw).toBe(
        `id: 1\ndata: {"n":1}\n\n` +
          `id: 2\ndata: {"n":2}\n\n` +
          `id: 3\ndata: {"n":3}\n\n` +
          `id: 4\ndata: {"n":4}\n\n` +
          `id: 5\ndata: {"n":5}\n\n`,
      );
    } finally {
      await svc.stop();
    }
  });
});

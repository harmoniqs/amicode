// Slice 4c — data-plane posture + liveness (amicissimo#392, spec
// spec-20260905-193000-local-shell-data-plane Slice B): D6's named degraded
// entry rule (a steady state, entered/exited by outcomes with hysteresis —
// the detector observes client-enforced outcomes and cannot wedge), D3's
// write-failure contract (delivered | failed | ambiguous-and-surfaced, the
// bounded idempotent retry carrying one client-generated request identity,
// the refetch resolution, the local store's role recorded — never a silent
// loss), D5's mid-flight revocation handoff (read-only-with-pointer +
// Go-Standalone, input never eaten), and D7's tunnel stamp (the STAMPED
// alias, never the literal placeholder, plus the generation a rejoin can be
// told apart by) with the H6 hub-kill / hub-hang / hub-rejoin legs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthToken, serverAuthHeader } from "../src/server_auth";
import { hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import {
  FleetPostureDetector,
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
} from "../src/amicode_service/fleet_posture";
import {
  executeFleetWrite,
  deriveRefetchPath,
  LOCAL_STORE_ROLE_FLEET_SESSION,
} from "../src/amicode_service/fleet_writes";
import {
  TUNNEL_ALIAS_PLACEHOLDER,
  TUNNEL_GENERATION_HEADER,
  stampTunnelAlias,
  inspectTunnelStamp,
  readTunnelGeneration,
  bumpTunnelGeneration,
  inspectTunnelConfigFile,
} from "../src/amicode_service/fleet_tunnel";

// ── shared fixtures ──────────────────────────────────────────────────────────

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(
    join(dist, "index.html"),
    "<!doctype html><html><head><title>amicode app</title></head><body><div id=root></div></body></html>",
  );
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
            { name: "upstream_mode", base_default: "engine", description: "the routing mode" },
            { name: "hub_upstream", base_default: null, description: "the hub over the fleet tunnel" },
            { name: "hub_credential_entry", base_default: null, description: "the hub mint's store entry" },
            { name: "merged_projection", base_default: null, description: "the merged read path" },
          ],
        },
      ],
    }),
  );
}

interface MockEngine {
  url: string;
  requests: string[];
  stop(): Promise<void>;
}

function startMockEngine(sessions: unknown[]): Promise<MockEngine> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const auth = req.headers.authorization ?? "";
    if (auth !== serverAuthHeader("engine-mint-password")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/session")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, local: true, received: body }));
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version: "v1.18.29" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, stop: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

/** The Slice B hub mock: controllable latency, hang, kill, version, write
 *  status, and an SSE endpoint that dies mid-stream. */
interface SliceBHub {
  url: string;
  requests: string[];
  setLatency(ms: number): void;
  setVersion(v: string): void;
  setWriteStatus(status: number | null): void;
  hang(): void;
  kill(): Promise<void>;
  stop(): Promise<void>;
}

function startSliceBHub(sessions: unknown[], password: string): Promise<SliceBHub> {
  const requests: string[] = [];
  const state = { latencyMs: 0, version: "v1.18.29", writeStatus: null as number | null, hang: false, sseEvents: 2 };
  const server = http.createServer((req, res) => {
    if (state.hang) return; // accepts the connection, NEVER responds — the wedged tunnel
    const respond = () => {
      requests.push(`${req.method} ${req.url}`);
      const auth = req.headers.authorization ?? "";
      if (auth !== hubUpstreamAuthHeader(password)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/session")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessions));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/session")) {
        if (state.writeStatus !== null) {
          res.writeHead(state.writeStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "revoked" }));
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, id: "ses-new", received: body }));
        });
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/global/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: state.version }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/event-stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        let n = 0;
        const timer = setInterval(() => {
          res.write(`event: ping\ndata: ${++n}\n\n`);
          if (n >= state.sseEvents) {
            clearInterval(timer);
            // the dead-stream case: the hub dies mid-stream (after the
            // last write flushes)
            setTimeout(() => res.destroy(), 30);
          }
        }, 10);
        req.on("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    };
    if (state.latencyMs > 0) setTimeout(respond, state.latencyMs);
    else respond();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        setLatency: (ms) => (state.latencyMs = ms),
        setVersion: (v) => (state.version = v),
        setWriteStatus: (s) => (state.writeStatus = s),
        hang: () => (state.hang = true),
        kill: () => new Promise((r) => server.close(() => r())),
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// D6 — the degraded entry rule: a named condition, hysteresis, no wedge
// ══════════════════════════════════════════════════════════════════════════════

describe("D6 — the degraded entry rule (named condition, hysteresis, cannot wedge)", () => {
  it("the named constants exist and document the rule's defaults", () => {
    expect(typeof DEGRADED_LATENCY_P95_MS).toBe("number");
    expect(typeof DEGRADED_WINDOW_SAMPLES).toBe("number");
    expect(typeof HUB_DOWN_CONSECUTIVE_NO_RESPONSES).toBe("number");
    expect(typeof RECOVERY_CONSECUTIVE_HEALTHY).toBe("number");
  });

  it("N consecutive no-responses enter the standalone (hub-down) posture; fewer do not (flapping must not flap)", () => {
    const d = new FleetPostureDetector();
    d.record({ kind: "no-response" });
    d.record({ kind: "no-response" });
    expect(d.snapshot().state).toBe("fleet");
    d.record({ kind: "no-response" });
    const s = d.snapshot();
    expect(s.state).toBe("standalone");
    expect(s.pointer).toContain("hub-down");
  });

  it("one healthy response after hub-down does NOT re-enter fleet before the recovery streak (hysteresis)", () => {
    const d = new FleetPostureDetector();
    d.record({ kind: "no-response" });
    d.record({ kind: "no-response" });
    d.record({ kind: "no-response" });
    expect(d.snapshot().state).toBe("standalone");
    d.record({ kind: "responded", latencyMs: 5 });
    expect(d.snapshot().state).toBe("standalone");
    d.record({ kind: "responded", latencyMs: 5 });
    expect(d.snapshot().state).toBe("standalone");
    d.record({ kind: "responded", latencyMs: 5 });
    expect(d.snapshot().state).toBe("fleet");
  });

  it("the latency window drives DEGRADED entry (p95 over the window) — and exit needs its own hysteresis", () => {
    const d = new FleetPostureDetector({
      tuning: { degradedLatencyP95Ms: 100, degradedWindowSamples: 3, recoveryConsecutiveHealthy: 2 },
    });
    d.record({ kind: "responded", latencyMs: 10 });
    expect(d.snapshot().state).toBe("fleet"); // below threshold, and the window is not full
    d.record({ kind: "responded", latencyMs: 200 });
    expect(d.snapshot().state).toBe("fleet"); // window not yet full — one slow sample must not flap
    d.record({ kind: "responded", latencyMs: 300 });
    expect(d.snapshot().state).toBe("degraded"); // p95 of a full window >= threshold
    d.record({ kind: "responded", latencyMs: 5 });
    expect(d.snapshot().state).toBe("degraded"); // recovery streak not yet satisfied
    d.record({ kind: "responded", latencyMs: 5 });
    d.record({ kind: "responded", latencyMs: 5 });
    expect(d.snapshot().state).toBe("fleet"); // latency genuinely back under the threshold
  });

  it("a HANG is not degradation: consecutive client-enforced timeouts from degraded go to the hub-down posture", () => {
    const d = new FleetPostureDetector({
      tuning: { degradedLatencyP95Ms: 100, degradedWindowSamples: 3 },
    });
    d.record({ kind: "responded", latencyMs: 200 });
    d.record({ kind: "responded", latencyMs: 200 });
    d.record({ kind: "responded", latencyMs: 200 });
    expect(d.snapshot().state).toBe("degraded");
    d.record({ kind: "no-response", detail: "client-enforced timeout" });
    d.record({ kind: "no-response", detail: "client-enforced timeout" });
    d.record({ kind: "no-response", detail: "client-enforced timeout" });
    const s = d.snapshot();
    expect(s.state).toBe("standalone"); // degraded is never welded to a wedged tunnel
    expect(s.pointer).toContain("hub-down");
  });

  it("the detector observes outcomes, never awaits them — record() is a synchronous state transition (it cannot wedge)", () => {
    const d = new FleetPostureDetector();
    const before = d.snapshot();
    d.record({ kind: "responded", latencyMs: 1 });
    const after = d.snapshot();
    expect(after.healthy_streak).toBe(before.healthy_streak + 1);
  });

  it("every posture transition bumps the refetch epoch and is recorded with refetch_required (D2's transition rule)", () => {
    const d = new FleetPostureDetector();
    const epochBefore = d.snapshot().refetch_epoch;
    d.record({ kind: "no-response" });
    d.record({ kind: "no-response" });
    d.record({ kind: "no-response" });
    let s = d.snapshot();
    expect(s.refetch_epoch).toBeGreaterThan(epochBefore);
    expect(s.last_transition?.to).toBe("standalone");
    expect(s.last_transition?.refetch_required).toBe(true);
    d.record({ kind: "responded", latencyMs: 1 });
    d.record({ kind: "responded", latencyMs: 1 });
    d.record({ kind: "responded", latencyMs: 1 });
    s = d.snapshot();
    expect(s.state).toBe("fleet");
    expect(s.transitions.length).toBe(2);
    expect(s.transitions[1].from).toBe("standalone");
    expect(s.transitions[1].to).toBe("fleet");
  });

  it("parity: a hub version change mid-session is surfaced with the previous version named", () => {
    const d = new FleetPostureDetector();
    d.noteHubVersion("v1.18.29");
    d.noteHubVersion("v1.18.29");
    expect(d.snapshot().parity).toEqual({ version: "v1.18.29", previous_version: null, changed: false });
    d.noteHubVersion("v1.19.0");
    expect(d.snapshot().parity).toEqual({ version: "v1.19.0", previous_version: "v1.18.29", changed: true });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D3 — the write-failure contract: every outcome enumerated, never silent
// ══════════════════════════════════════════════════════════════════════════════

describe("D3 — the write-failure contract (delivered | failed | ambiguous-and-surfaced)", () => {
  const HUB = "http://127.0.0.1:59999";
  const okCred = () =>
    ({ ok: true, mint: "hub", credential: { baseUrl: HUB, token: "hub-token" } }) as const;

  interface StubCall {
    url: string;
    method?: string;
    headers: Record<string, unknown>;
    body?: unknown;
  }
  type Handler = (call: StubCall) => Response;

  function stubFetch(handlers: Handler[], opts: { throwAt?: number[] } = {}) {
    const calls: StubCall[] = [];
    let i = 0;
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const call: StubCall = {
        url,
        method: init?.method,
        headers: (init?.headers ?? {}) as Record<string, unknown>,
        body: init?.body,
      };
      const at = i;
      i++;
      calls.push(call);
      if (opts.throwAt?.includes(at)) throw new Error("connection refused");
      const h = handlers[Math.min(at, handlers.length - 1)];
      return h(call);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const write = (body: string, requestId?: string): Parameters<typeof executeFleetWrite>[1] => ({
    method: "POST",
    url: "/session",
    headers: {
      host: "service-origin",
      connection: "keep-alive",
      authorization: "Basic aW5ib3VuZDp0b2tlbg==",
      ...(requestId !== undefined ? { "x-amicode-request-id": requestId } : {}),
    },
    body,
  });

  it("delivered: a 2xx response resolves the write as delivered with the hub's answer passed through", async () => {
    const { fetchImpl, calls } = stubFetch([
      () => new Response(JSON.stringify({ ok: true, id: "ses-new" }), { status: 200 }),
    ]);
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500 },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") {
      expect(result.httpStatus).toBe(200);
      expect(result.body).toBe(JSON.stringify({ ok: true, id: "ses-new" }));
      expect(result.attempts).toBe(1);
    }
    // the hub mint rides the upstream hop; the inbound credential never does
    expect(calls[0]?.headers["authorization"]).toBe(hubUpstreamAuthHeader("hub-token"));
    expect(calls[0]?.headers["x-amicode-request-id"]).toBeTruthy();
  });

  it("failed: a seen error status is a named failed outcome with the payload echoed and the local store's role recorded", async () => {
    const { fetchImpl } = stubFetch([() => new Response("boom", { status: 500 })]);
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500 },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.hubStatus).toBe(500);
      expect(result.payload).toBe('{"title":"x"}'); // the compose input is never eaten
      expect(result.localStoreRole).toBe(LOCAL_STORE_ROLE_FLEET_SESSION);
      expect(result.revocation).toBeUndefined();
    }
  });

  it("401: the revocation handoff — read-only-with-pointer, Go-Standalone offered, input never eaten", async () => {
    const { fetchImpl } = stubFetch([() => new Response(JSON.stringify({ ok: false }), { status: 401 })]);
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500 },
      write('{"title":"mid-flight draft"}'),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.revocation).toBeDefined();
      expect(result.revocation?.handoff).toBe("read-only-with-pointer");
      expect(result.revocation?.go_standalone).toBe(true);
      expect(result.payload).toBe('{"title":"mid-flight draft"}');
    }
  });

  it("ambiguous: no response triggers a BOUNDED idempotent retry carrying the SAME client-generated request identity", async () => {
    const { fetchImpl, calls } = stubFetch([() => new Response("x", { status: 200 })], {
      throwAt: [0, 1, 2], // three transport failures, then the stub would answer
    });
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500, maxRetries: 2 },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") expect(result.attempts).toBe(3); // 1 + maxRetries — bounded
    const ids = calls.filter((c) => c.method === "POST").map((c) => c.headers["x-amicode-request-id"]);
    expect(ids.length).toBe(3);
    expect(new Set(ids).size).toBe(1); // the SAME identity on every retry
    expect(typeof ids[0]).toBe("string");
  });

  it("an inbound request identity is preserved across retries (client-generated, never regenerated)", async () => {
    const { fetchImpl, calls } = stubFetch([() => new Response("x", { status: 200 })], { throwAt: [0, 1] });
    await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500, maxRetries: 2 },
      write('{"title":"x"}', "req-from-the-client"),
    );
    for (const c of calls) expect(c.headers["x-amicode-request-id"]).toBe("req-from-the-client");
  });

  it("a retry that lands resolves the ambiguity as delivered", async () => {
    const { fetchImpl } = stubFetch(
      [
        () => new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true, deduped: true }), { status: 200 }),
      ],
      { throwAt: [0] },
    );
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500, maxRetries: 2 },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("delivered");
    if (result.status === "delivered") expect(result.attempts).toBe(2);
  });

  it("retries exhausted resolve by REFETCH of the affected thread; the outcome stays ambiguous-and-surfaced", async () => {
    const { fetchImpl } = stubFetch(
      [
        () => new Response(JSON.stringify({ id: "ses-new" }), { status: 200 }),
      ],
      { throwAt: [0, 1, 2] }, // every write attempt fails at the transport
    );
    const result = await executeFleetWrite(
      { getUrl: () => HUB, credential: okCred, fetchImpl, timeoutMs: 500, maxRetries: 2 },
      { method: "POST", url: "/session/ses-1/message", headers: {}, body: '{"text":"hi"}' },
    );
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.refetch).not.toBeNull();
      expect(result.refetch?.path).toBe("/session/ses-1"); // the affected thread, not the list
      expect(result.payload).toBe('{"text":"hi"}');
      expect(result.localStoreRole).toBe(LOCAL_STORE_ROLE_FLEET_SESSION);
    }
  });

  it("no upstream: the write fails NAMED (hub upstream not available), payload echoed, never silently dropped", async () => {
    const result = await executeFleetWrite(
      { getUrl: () => undefined, credential: okCred, timeoutMs: 500 },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toBe("hub upstream not available");
      expect(result.payload).toBe('{"title":"x"}');
    }
  });

  it("a missing hub credential is the named hub-credential-missing outcome on the write path too", async () => {
    const result = await executeFleetWrite(
      {
        getUrl: () => HUB,
        credential: () => ({ ok: false, mint: "hub", reason: "absent" }) as never,
        timeoutMs: 500,
      },
      write('{"title":"x"}'),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error).toBe("hub-credential-missing");
  });

  it("deriveRefetchPath: a thread write refetches its thread; a session create refetches the list", () => {
    expect(deriveRefetchPath("/session")).toBe("/session");
    expect(deriveRefetchPath("/session/ses-1")).toBe("/session/ses-1");
    expect(deriveRefetchPath("/session/ses-1/message")).toBe("/session/ses-1");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D7 — the tunnel stamps its own config (stamped alias + generation)
// ══════════════════════════════════════════════════════════════════════════════

describe("D7 — the tunnel stamps its own config (the rejoin fixture's stamp)", () => {
  it("a literal FLEET_SSH_ALIAS placeholder is a NAMED unstamped config — it can never ship again", () => {
    const ins = inspectTunnelStamp("<plist><string>ssh -L ... ${FLEET_SSH_ALIAS}</string></plist>");
    expect(ins.stamped).toBe(false);
    if (!ins.stamped) expect(ins.reason).toBe("placeholder-present");
  });

  it("stamping replaces the placeholder and the alias is assertable on inspection", () => {
    const tpl = "<plist><string>ssh -F FLEET_SSH_ALIAS -W hub:22</string></plist>";
    const stamped = stampTunnelAlias(tpl, "amicissimo-hub-tunnel");
    expect(stamped.ok).toBe(true);
    if (stamped.ok) {
      expect(stamped.text).not.toContain(TUNNEL_ALIAS_PLACEHOLDER);
      const ins = inspectTunnelStamp(stamped.text, "amicissimo-hub-tunnel");
      expect(ins.stamped).toBe(true);
      if (ins.stamped) expect(ins.alias).toBe("amicissimo-hub-tunnel");
    }
  });

  it("an empty alias is a named rejection — never a silent unstamped ship", () => {
    expect(stampTunnelAlias("x FLEET_SSH_ALIAS y", "  ")).toEqual({ ok: false, reason: "alias-empty" });
  });

  it("the generation marker is read and bumped — a rejoin is a NEW generation the client can tell apart", () => {
    const first = stampTunnelAlias("ssh -W hub:22 FLEET_SSH_ALIAS", "alias-a", 1);
    expect(first.ok).toBe(true);
    if (first.ok) expect(readTunnelGeneration(first.text)).toBe(1);
    const bumped = bumpTunnelGeneration(first.ok ? first.text : "");
    expect(bumped.generation).toBe(2);
    expect(readTunnelGeneration(bumped.text)).toBe(2);
  });

  it("an absent config is a named config-absent, never a throw", () => {
    expect(inspectTunnelStamp(null)).toEqual({ stamped: false, reason: "config-absent", generation: null });
    expect(inspectTunnelConfigFile(undefined)).toEqual({ stamped: false, reason: "config-absent", generation: null });
    expect(inspectTunnelConfigFile(join(tmpdir(), "amicode-no-such-tunnel-config"))).toEqual({
      stamped: false,
      reason: "config-absent",
      generation: null,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// H6 leg 1 — the hub-kill: ambiguity contract, posture flip, recovery refetch
// ══════════════════════════════════════════════════════════════════════════════

describe("H6 — the hub-kill leg: ambiguity observed, posture flips, recovery refetches", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  let hubUrl = "";
  const HUB_PASSWORD = "hub-tunnel-mint";

  const LOCAL_SESSIONS = [{ id: "ses-local-1", title: "local one", time: { created: 1, updated: 5000 } }];
  const HUB_SESSIONS = [{ id: "ses-hub-1", title: "hub one", time: { created: 2, updated: 9000 } }];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-h6-kill-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine(LOCAL_SESSIONS);
    hub = await startSliceBHub(HUB_SESSIONS, HUB_PASSWORD);
    hubUrl = hub.url;
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hubUrl },
        getMode: () => "fleet",
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("a delivered write routes to the hub before the kill", async () => {
    const res = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "fleet session" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.id).toBe("ses-new"); // the hub's own answer, passed through
  });

  it("the kill: an in-flight write resolves to the NAMED ambiguous outcome — payload echoed, never eaten", async () => {
    await hub.kill();
    const payload = JSON.stringify({ title: "written as the hub died" });
    const res = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(504);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      attempts: number;
      payload: string;
      request_id: string;
      local_store_role: string;
      refetch: { path: string; ok: boolean } | null;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("fleet-write-ambiguous");
    expect(body.attempts).toBe(3); // bounded: 1 + 2 idempotent retries
    expect(body.payload).toBe(payload);
    expect(body.request_id).toBeTruthy();
    expect(body.local_store_role).toContain("never shadowed");
    expect(body.refetch?.path).toBe("/session");
  });

  it("the posture flipped to standalone (hub-down) mid-session — visible through the SAME status contract", async () => {
    const res = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const body = (await res.json()) as { posture: { state: string; pointer: string | null }; mode: string };
    expect(body.posture.state).toBe("standalone");
    expect(body.posture.pointer).toContain("hub-down");
    // the effective routing mode fell back to the base standalone posture
    expect(body.mode).toBe("engine");
  });

  it("in the hub-down posture, reads and writes route LOCALLY (a hub-down-window session stays local, never hidden)", async () => {
    const read = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(read.status).toBe(200);
    const sessions = (await read.json()) as Array<{ id: string }>;
    expect(sessions.some((s) => s.id === "ses-local-1")).toBe(true);
    expect(sessions.some((s) => s.id === "ses-hub-1")).toBe(false);

    const write = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: JSON.stringify({ title: "created offline" }),
    });
    expect(write.status).toBe(200);
    const wb = (await write.json()) as { local: boolean };
    expect(wb.local).toBe(true); // the engine answered — a LOCAL session, D3's hub-down-window case
  });

  it("the hub-down projection is local-tagged; the refetch epoch moved", async () => {
    const proj = await fetch(`${origin}/amicode/fleet/sessions`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const body = (await proj.json()) as {
      currency: { token: string; sources: string[] };
      sources: Record<string, { present: boolean }>;
    };
    expect(body.sources.hub.present).toBe(false);
    expect(body.currency.sources).toEqual(["local"]);
    globalThis.__h6KillLocalToken = body.currency.token;

    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { posture: { refetch_epoch: number; transitions: unknown[] } };
    globalThis.__h6KillEpoch = s.posture.refetch_epoch;
    expect(s.posture.transitions.length).toBeGreaterThanOrEqual(1);
  });

  it("recovery: the hub back up re-enters fleet after the recovery streak — refetch-before-first-render signaled", async () => {
    const hub2 = await startSliceBHub(HUB_SESSIONS, HUB_PASSWORD);
    hubUrl = hub2.url;
    try {
      // In the hub-down posture the proxied reads route locally (the base
      // standalone posture) — the MERGED PROJECTION is the always-mounted
      // hub probe: it fetches both sources regardless of posture, so its
      // outcomes drive the recovery streak.
      for (let i = 0; i < 2; i++) {
        const r = await fetch(`${origin}/amicode/fleet/sessions`, {
          headers: { Authorization: `Basic ${engineToken}` },
        });
        expect(r.status).toBe(200);
      }
      // hysteresis: two healthy probes must NOT yet re-enter fleet
      let status = await fetch(`${origin}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      let s = (await status.json()) as { posture: { state: string } };
      expect(s.posture.state).toBe("standalone");

      const third = await fetch(`${origin}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      expect(third.status).toBe(200);
      status = await fetch(`${origin}/amicode/fleet/status`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      s = (await status.json()) as {
        posture: { state: string; refetch_epoch: number; last_transition: { to: string; refetch_required: boolean } | null };
      };
      expect(s.posture.state).toBe("fleet");
      expect(s.posture.last_transition?.to).toBe("fleet");
      expect(s.posture.last_transition?.refetch_required).toBe(true);
      expect(s.posture.refetch_epoch).toBeGreaterThan(globalThis.__h6KillEpoch ?? 0);

      // refetch-before-first-render: the recovered projection differs from
      // the hub-down one, and data requests route to the hub again
      const proj = await fetch(`${origin}/amicode/fleet/sessions`, {
        headers: { Authorization: `Basic ${engineToken}` },
      });
      const pb = (await proj.json()) as { currency: { token: string; sources: string[] } };
      expect(pb.currency.sources).toEqual(["hub", "local"]);
      expect(pb.currency.token).not.toBe(globalThis.__h6KillLocalToken);

      const hubRequestsBefore = hub2.requests.length;
      const read = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(read.status).toBe(200);
      expect(hub2.requests.length).toBeGreaterThan(hubRequestsBefore);
    } finally {
      await hub2.stop();
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// H6 leg 2 — the hub-hang: the detector cannot wedge on a wedged tunnel
// ══════════════════════════════════════════════════════════════════════════════

describe("H6 — the hub-hang leg: client-enforced timeouts drive hub-down, never a welded degraded", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";
  const LOCAL_SESSIONS = [{ id: "ses-local-1", title: "local one", time: { created: 1, updated: 5000 } }];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-h6-hang-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine(LOCAL_SESSIONS);
    hub = await startSliceBHub([], HUB_PASSWORD);
    hub.hang(); // the wedged tunnel: accepts connections, never responds
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
        dataPlaneTimeoutMs: 200,
        writeTimeoutMs: 200,
        writeMaxRetries: 1,
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("a write into the hang resolves ambiguous under the client-enforced timeout (the detector cannot wedge)", async () => {
    const payload = JSON.stringify({ title: "into the hang" });
    const started = Date.now();
    const res = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: payload,
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error: string; attempts: number; payload: string };
    expect(body.error).toBe("fleet-write-ambiguous");
    expect(body.attempts).toBe(2); // 1 + writeMaxRetries
    expect(body.payload).toBe(payload);
    expect(elapsed).toBeLessThan(5000); // the CLIENT resolved it — it did not await the wedged tunnel forever
  });

  it("proxied reads under the hang get the honest transport failure, and the posture lands on hub-down (not degraded)", async () => {
    const res = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res.status).toBe(502); // the proxy's named upstream-failure shape

    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { posture: { state: string; pointer: string | null }; mode: string };
    // 2 write attempts + 1 read = 3 consecutive no-responses ≥ N — hub-down, NOT degraded
    expect(s.posture.state).toBe("standalone");
    expect(s.posture.pointer).toContain("hub-down");
    expect(s.mode).toBe("engine");
  });

  it("in the hub-down posture the wedged tunnel is out of the path entirely (reads route locally)", async () => {
    const res = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<{ id: string }>;
    expect(sessions.some((s) => s.id === "ses-local-1")).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// H6 leg 3 — the hub-rejoin: the tunnel generation stamp tells rejoins apart
// ══════════════════════════════════════════════════════════════════════════════

describe("H6 — the hub-rejoin leg: the tunnel generation stamp + SSE liveness inheritance", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let tunnelConfig: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";
  const ALIAS = "amicissimo-hub-tunnel";
  const LOCAL_SESSIONS = [{ id: "ses-local-1", title: "local one", time: { created: 1, updated: 5000 } }];

  function writeTunnelConfig(generation: number): void {
    const tpl = "# launchd tunnel config (fixture)\nssh -F FLEET_SSH_ALIAS -W hub:22\n";
    const stamped = stampTunnelAlias(tpl, ALIAS, generation);
    if (!stamped.ok) throw new Error("fixture stamp failed");
    writeFileSync(tunnelConfig, stamped.text);
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-h6-rejoin-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    tunnelConfig = join(root, "tunnel-config.txt");
    writeTunnelConfig(1);
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine(LOCAL_SESSIONS);
    hub = await startSliceBHub(LOCAL_SESSIONS, HUB_PASSWORD);
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
        tunnelConfigPath: tunnelConfig,
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("the rejoin fixture: the installed tunnel config carries the STAMPED alias (the placeholder regression can never ship)", () => {
    const ins = inspectTunnelConfigFile(tunnelConfig, ALIAS);
    expect(ins.stamped).toBe(true);
    if (ins.stamped) {
      expect(ins.alias).toBe(ALIAS);
      expect(ins.generation).toBe(1);
    }
  });

  it("proxied responses carry the tunnel generation stamp, and a REJOIN (new generation) is visible mid-session", async () => {
    const res1 = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res1.status).toBe(200);
    expect(res1.headers.get(TUNNEL_GENERATION_HEADER)).toBe("1");

    writeTunnelConfig(2); // the rejoin: the tunnel restamped its own config

    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { tunnel: { stamped: boolean; generation: number | null } };
    expect(s.tunnel.stamped).toBe(true);
    expect(s.tunnel.generation).toBe(2);

    const res2 = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res2.headers.get(TUNNEL_GENERATION_HEADER)).toBe("2"); // a stream's generation is tellable
  });

  it("SSE liveness inheritance: the tunneled event stream streams (never buffered) and a DEAD stream ends honestly", async () => {
    const res = await fetch(`${origin}/event-stream`, { headers: { Authorization: `Basic ${engineToken}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(res.headers.get(TUNNEL_GENERATION_HEADER)).toBe("2"); // the stream rides the stamped tunnel

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readAll = (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += decoder.decode(value, { stream: true });
        }
      } catch {
        /* the premature close — exactly the dead-stream case the liveness contract handles */
      }
    })();
    const guard = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("SSE stream hung — a dead stream must end, never render stale-as-current")), 5000),
    );
    await Promise.race([readAll, guard]);
    expect(received).toContain("data: 1");
    expect(received).toContain("data: 2");
    await reader.cancel().catch(() => undefined);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// D5 — the mid-flight revocation handoff, end to end through the service
// ══════════════════════════════════════════════════════════════════════════════

describe("D5 — the mid-flight revocation handoff (read-only-with-pointer, never stranded)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-revoke-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine([]);
    hub = await startSliceBHub([], HUB_PASSWORD);
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("a 401 on a fleet write is the read-only-with-pointer handoff: notice + Go-Standalone, input never eaten, posture not degraded", async () => {
    hub.setWriteStatus(401); // the entitlement lapsed mid-flight
    const payload = JSON.stringify({ title: "draft in the compose box" });
    const res = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      error: string;
      payload: string;
      revocation: { handoff: string; go_standalone: boolean; notice: string };
      local_store_role: string;
    };
    expect(body.error).toBe("fleet-write-failed");
    expect(body.payload).toBe(payload); // the compose path never silently eats input
    expect(body.revocation.handoff).toBe("read-only-with-pointer");
    expect(body.revocation.go_standalone).toBe(true);
    expect(body.revocation.notice).toContain("re-entitlement");
    expect(body.local_store_role).toContain("never shadowed");

    // revocation is honest unreachability, NOT degradation — the posture stays fleet
    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { posture: { state: string } };
    expect(s.posture.state).toBe("fleet");
    hub.setWriteStatus(null);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The WAN-degradation sim (the founding case): latency drives DEGRADED, with exit
// ══════════════════════════════════════════════════════════════════════════════

describe("the WAN-degradation sim — degraded is a usable steady state, entered and exited by the rule", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-wan-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine([]);
    hub = await startSliceBHub([], HUB_PASSWORD);
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
        posture: { degradedLatencyP95Ms: 50, degradedWindowSamples: 3, recoveryConsecutiveHealthy: 2 },
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  it("750ms-plane style latency drives DEGRADED entry; the hub keeps serving (usable, honest, surfaced)", async () => {
    hub.setLatency(80);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
      expect(r.status).toBe(200);
    }
    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { posture: { state: string }; mode: string };
    expect(s.posture.state).toBe("degraded");
    expect(s.mode).toBe("fleet"); // degraded is still fleet — hub-up-but-slow, NOT the engine fallback

    // a write still routes to the hub in degraded (the steady state is usable)
    const w = await fetch(`${origin}/session`, {
      method: "POST",
      headers: { Authorization: `Basic ${engineToken}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(w.status).toBe(200);
  });

  it("latency recovery exits degraded through the hysteresis — back to fleet", async () => {
    hub.setLatency(0);
    // the window must genuinely refill under the threshold (W = 3 here)
    await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    await fetch(`${origin}/session`, { headers: { Authorization: `Basic ${engineToken}` } });
    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    const s = (await status.json()) as { posture: { state: string } };
    expect(s.posture.state).toBe("fleet");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Mid-session parity — hub build parity re-asserts and drifts are surfaced
// ══════════════════════════════════════════════════════════════════════════════

describe("mid-session parity — hub build parity re-asserts on the data plane", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let hubFile: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let hub: Awaited<ReturnType<typeof startSliceBHub>>;
  let service: ReturnType<typeof createAmicodeService>;
  let origin: string;
  let engineToken: string;
  const HUB_PASSWORD = "hub-tunnel-mint";

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-parity-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    hubFile = join(root, "fleet-hub.json");
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    engine = await startMockEngine([]);
    hub = await startSliceBHub([], HUB_PASSWORD);
    const { writeHubCredential } = await import("../src/amicode_service/hub_credential");
    writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    engineToken = serverAuthToken("engine-mint-password");
    service = createAmicodeService({
      password: "service-own-mint",
      engine: { password: "engine-mint-password", getUrl: () => engine.url },
      shelf: { distRoot: dist },
      fleet: {
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => hub.url },
        getMode: () => "fleet",
      },
    });
    origin = (await service.start()).toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    await service.stop();
    await engine.stop();
    await hub.stop();
    delete process.env.AMICO_FLEET_HUB_FILE;
    rmSync(root, { recursive: true, force: true });
  });

  async function getStatus() {
    const status = await fetch(`${origin}/amicode/fleet/status`, {
      headers: { Authorization: `Basic ${engineToken}` },
    });
    return (await status.json()) as {
      posture: {
        state: string;
        parity: { version: string | null; previous_version: string | null; changed: boolean };
      };
    };
  }

  it("parity starts unnamed, names itself on the first fetch, and surfaces a mid-session build drift", async () => {
    let s = await getStatus();
    expect(s.posture.parity.version).toBeNull();

    await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
    s = await getStatus();
    expect(s.posture.parity.version).toBe("v1.18.29");
    expect(s.posture.parity.changed).toBe(false);

    hub.setVersion("v1.19.0"); // the hub's build changed mid-session
    await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: `Basic ${engineToken}` } });
    s = await getStatus();
    expect(s.posture.parity.version).toBe("v1.19.0");
    expect(s.posture.parity.previous_version).toBe("v1.18.29");
    expect(s.posture.parity.changed).toBe(true);
  });
});

// test-run-scoped handoff between ordered its (vitest runs describes in file order)
declare global {
  // eslint-disable-next-line no-var
  var __h6KillLocalToken: string | undefined;
  // eslint-disable-next-line no-var
  var __h6KillEpoch: number | undefined;
}

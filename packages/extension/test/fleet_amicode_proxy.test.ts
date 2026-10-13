// fleet_amicode_proxy.test.ts — #1262 (Slice 2): the HOST owns all /amicode/*
// state; a fleet CLIENT proxies /amicode/* to it. Slice 1 (#1261) proxied only
// the engine data plane. This file pins the two pieces that are specific to the
// /amicode/* surface (the registered-route bypass + credential translation are
// pinned in fleet_client_relay.test.ts, extending #1261's stub-host relay test):
//
//   AC3 — a proxied /amicode/* NON-GET resolves through the write-failure
//         contract with an /amicode/*-APPROPRIATE refetch variant (the family
//         GET twin, NOT the session-shaped path, NOT a raw /amicode that hides
//         the mutated resource).
//   AC4 — MULTI-CLIENT concurrency: ≥2 clients mutating the SAME host
//         /amicode/* resource. Policy = LAST-WRITE-WINS with whole-request
//         atomic delivery; the write pipeline buffers each body fully and sends
//         it in ONE request, so two clients' bodies never interleave, and the
//         host's final state is exactly one client's COMPLETE value. There is
//         no lost-update DETECTION (no compare-and-swap / ETag): a client that
//         read-modify-wrote stale state can silently lose — the stated rule.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createAmicodeService } from "../src/amicode_service";
import { serverAuthHeader } from "../src/server_auth";
import { writeHubCredential, hubUpstreamAuthHeader } from "../src/amicode_service/hub_credential";
import { deriveRefetchPath, deriveAmicodeRefetchPath } from "../src/amicode_service/fleet_writes";

// ── AC3: the /amicode/* refetch variant — a PURE derivation (no I/O) ─────────
describe("#1262 AC3 — the /amicode/* refetch variant (deriveAmicodeRefetchPath)", () => {
  it("refetches the FAMILY resource: POST /amicode/connections/credential → GET /amicode/connections", () => {
    expect(deriveAmicodeRefetchPath("/amicode/connections/credential")).toBe("/amicode/connections");
  });

  it("a single-resource write refetches its own GET twin: /amicode/profile → /amicode/profile", () => {
    expect(deriveAmicodeRefetchPath("/amicode/profile")).toBe("/amicode/profile");
    expect(deriveAmicodeRefetchPath("/amicode/solver-mode")).toBe("/amicode/solver-mode");
  });

  it("a family action drops to the family GET: /amicode/posture/dismiss → /amicode/posture, /amicode/model-routing/opt-in → /amicode/model-routing", () => {
    expect(deriveAmicodeRefetchPath("/amicode/posture/dismiss")).toBe("/amicode/posture");
    expect(deriveAmicodeRefetchPath("/amicode/model-routing/opt-in")).toBe("/amicode/model-routing");
  });

  it("query strings are stripped from the refetch path", () => {
    expect(deriveAmicodeRefetchPath("/amicode/problem?slug=cz")).toBe("/amicode/problem");
  });

  it("deriveRefetchPath DISPATCHES /amicode/* to the variant — never the session-shaped fallthrough that loses the family", () => {
    // Pre-#1262 this returned "/amicode" (the segs[0] fallthrough), losing the
    // mutated resource. It must now yield the family GET twin.
    expect(deriveRefetchPath("/amicode/connections/credential")).toBe("/amicode/connections");
    expect(deriveRefetchPath("/amicode/profile")).toBe("/amicode/profile");
  });

  it("the session-shaped derivation is UNTOUCHED (no regression to #392's contract)", () => {
    expect(deriveRefetchPath("/session/ses-1/message")).toBe("/session/ses-1");
    expect(deriveRefetchPath("/session")).toBe("/session");
    expect(deriveRefetchPath("/")).toBe("/session");
  });
});

// ── shared: a mutable-state stub host modelling the /amicode/* store ─────────
interface CountingHost {
  url: string;
  amicodePosts: { path: string; body: string; auth: string }[];
  /** the store's final value per resource — LAST-WRITE-WINS, whole-body. */
  store: Map<string, string>;
  /** flip on to make POSTs hang (host never responds) → the ambiguous path. */
  setHang(on: boolean): void;
  stop(): Promise<void>;
}
function startCountingHost(hubPassword: string): Promise<CountingHost> {
  const amicodePosts: { path: string; body: string; auth: string }[] = [];
  const store = new Map<string, string>();
  let hang = false;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    if (auth !== hubUpstreamAuthHeader(hubPassword)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        // A single-threaded, SYNCHRONOUS store update: whole requests apply
        // atomically (the event loop cannot interleave synchronous code), so
        // the resource holds exactly one client's COMPLETE body — last wins.
        amicodePosts.push({ path: req.url!, body, auth });
        store.set(req.url!.split("?")[0], body);
        if (hang) return; // never answer → the client's write goes ambiguous
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, stored: body }));
      });
      return;
    }
    // GET: reflect the stored value (the refetch target)
    const key = (req.url ?? "/").split("?")[0];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: store.get(key) ?? null }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        amicodePosts,
        store,
        setHang: (on: boolean) => {
          hang = on;
        },
        stop: () => new Promise((r) => server.close(() => r())),
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

describe("#1262 — proxied /amicode/* writes through the write-failure contract", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let host: CountingHost;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1262-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    host = await startCountingHost(HUB_PASSWORD);
  });

  afterAll(async () => {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  });

  /** A fleet client relay bound to its OWN hub file (isolated per client so two
   *  clients can carry independent service mints while sharing the host). */
  function bootClient(servicePassword: string, hubUrl: () => string | undefined): ReturnType<typeof createAmicodeService> {
    const hubFile = join(root, `hub-${servicePassword}.json`);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    return createAmicodeService({
      password: servicePassword,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: hubUrl },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 300,
        writeTimeoutMs: 300,
        writeMaxRetries: 1,
      },
    });
  }

  it("AC3 — an AMBIGUOUS /amicode/* write (host never answers) surfaces the /amicode/* refetch variant, not the session-shaped one", async () => {
    host.setHang(true); // POSTs land but never answer → the write goes ambiguous
    const svc = bootClient("client-refetch-mint", () => host.url);
    const origin = (await svc.start()).toString().replace(/\/$/, "");
    try {
      const res = await fetch(`${origin}/amicode/connections/credential`, {
        method: "POST",
        headers: { Authorization: serverAuthHeader("client-refetch-mint"), "content-type": "application/json" },
        body: JSON.stringify({ id: "company-compute", token: "x" }),
      });
      expect(res.status).toBe(504); // the write-failure contract's ambiguous face
      const body = (await res.json()) as { ok: boolean; error: string; refetch: { path: string } | null };
      expect(body.error).toBe("fleet-write-ambiguous"); // never eaten
      expect(body.refetch).toBeTruthy();
      // the /amicode/* variant — the FAMILY GET twin, not "/amicode", not "/connections"
      expect(body.refetch!.path).toBe("/amicode/connections");
    } finally {
      host.setHang(false);
      await svc.stop();
    }
  });
});

// ── AC4: two clients, one host resource ──────────────────────────────────────
describe("#1262 AC4 — multi-client concurrency on shared host /amicode/* state (last-write-wins, no interleave)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let host: CountingHost;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-1262-conc-"));
    dist = buildMockDist(root);
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    host = await startCountingHost(HUB_PASSWORD);
  });

  afterAll(async () => {
    await host.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function bootClient(servicePassword: string): ReturnType<typeof createAmicodeService> {
    const hubFile = join(root, `hub-${servicePassword}.json`);
    writeHubCredential({ baseUrl: host.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
    return createAmicodeService({
      password: servicePassword,
      shelf: { distRoot: dist },
      fleet: {
        client: true,
        entitlements: ["amicissimo"],
        overlaySource,
        hub: { getUrl: () => host.url },
        getMode: () => "fleet",
        posture: { hubDownConsecutiveNoResponses: 2, recoveryConsecutiveHealthy: 2 },
        dataPlaneTimeoutMs: 500,
      },
    });
  }

  it("two clients POST the SAME resource concurrently: both delivered whole, host holds exactly ONE complete value (no interleaved partial write)", async () => {
    const a = bootClient("client-A-mint");
    const b = bootClient("client-B-mint");
    const originA = (await a.start()).toString().replace(/\/$/, "");
    const originB = (await b.start()).toString().replace(/\/$/, "");
    // two distinct, COMPLETE bodies to the same host resource
    const bodyA = JSON.stringify({ mode: "piccolo", writer: "A", payload: "A".repeat(200) });
    const bodyB = JSON.stringify({ mode: "free", writer: "B", payload: "B".repeat(200) });
    try {
      const [resA, resB] = await Promise.all([
        fetch(`${originA}/amicode/solver-mode`, {
          method: "POST",
          headers: { Authorization: serverAuthHeader("client-A-mint"), "content-type": "application/json" },
          body: bodyA,
        }),
        fetch(`${originB}/amicode/solver-mode`, {
          method: "POST",
          headers: { Authorization: serverAuthHeader("client-B-mint"), "content-type": "application/json" },
          body: bodyB,
        }),
      ]);
      // both writes were DELIVERED + accepted (no concurrency-induced failure)
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      // the host received TWO complete, well-formed bodies — each parses and
      // equals exactly one client's payload; neither is a spliced mixture
      const posts = host.amicodePosts.filter((p) => p.path.split("?")[0] === "/amicode/solver-mode");
      expect(posts.length).toBe(2);
      const seen = posts.map((p) => p.body).sort();
      expect(seen).toEqual([bodyA, bodyB].sort()); // both intact, neither interleaved
      for (const p of posts) expect(() => JSON.parse(p.body)).not.toThrow(); // each a whole JSON doc
      // LAST-WRITE-WINS: the store holds exactly ONE of the two COMPLETE values
      const final = host.store.get("/amicode/solver-mode");
      expect([bodyA, bodyB]).toContain(final); // one complete winner, never a merge/corruption
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});

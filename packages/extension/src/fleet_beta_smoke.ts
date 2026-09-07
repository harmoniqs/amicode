// FLEET BETA SMOKE (#398 — slice 4e): the end-to-end beta harness for the
// local-shell data plane. Boots the REAL amicode service through the REAL
// wiring (startAmicodeService — the activation path this slice wired) against
// fixture upstreams and prints a PASS/FAIL checklist, one named line per leg.
//
//   DRY (default)  — everything local, nothing real touched: a fixture hub is
//     spawned locally, killed / hung / rejoined, the entitlement + manifest +
//     activation config are fixtures in a temp dir, the hub credential store
//     rides AMICO_FLEET_HUB_FILE (set here, restored after). This is the run
//     the AC evidence quotes.
//
//   LIVE (AMICODE_FLEET_SMOKE_LIVE=1) — against a REAL hub through the REAL
//     tunnel, using the machine's REAL entitlements and the activation config
//     (AMICODE_FLEET_HUB_URL / AMICODE_FLEET_TUNNEL_ALIAS / the optional
//     AMICODE_FLEET_TUNNEL_CONFIG). Destructive legs (kill / hang / revoke)
//     are NEVER run live — they are named skips, not silent absences.
//
// Honesty rules: every failure line names the outcome (never a silent pass);
// the script exits non-zero when any leg fails; the hub credential env var is
// restored on exit. No state outside the temp dir is mutated in DRY mode.
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAmicodeService } from "./amicode_service_wiring";
import { resolveFleetActivation } from "./fleet_activation";
import { writeHubCredential, hubUpstreamAuthHeader } from "./amicode_service/hub_credential";
import { serverAuthHeader, serverAuthToken } from "./server_auth";
import { inspectTunnelConfigFile } from "./amicode_service/fleet_tunnel";

const HUB_PASSWORD = "smoke-fixture-hub-mint";
const ENGINE_PASSWORD = "smoke-fixture-engine-mint";
const LOCAL_SESSIONS = [{ id: "ses-local-1", title: "local one", time: { created: 1000, updated: 5000 } }];
const HUB_SESSIONS = [
  { id: "ses-hub-1", title: "hub one", time: { created: 3000, updated: 9000 } },
  { id: "ses-both", title: "hub copy (store of record)", time: { created: 2000, updated: 8000 } },
];
const HUB_VERSION = "v1.18.29";

// ── the checklist ────────────────────────────────────────────────────────────

interface LegResult {
  leg: string;
  pass: boolean;
  detail: string;
}

const results: LegResult[] = [];

function record(leg: string, pass: boolean, detail: string): void {
  results.push({ leg, pass, detail });
  console.log(`[smoke] ${pass ? "PASS" : "FAIL"} ${leg}: ${detail}`);
}

async function check(leg: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(leg, true, await fn());
  } catch (e) {
    record(leg, false, e instanceof Error ? e.message : String(e));
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ── fixture hub (spawned locally; killed / hung / rejoined by the legs) ──────

class FixtureHub {
  private server?: http.Server;
  private port = 0;
  requests = 0;
  /** Revocation leg: every request 401s (the mid-flight entitlement lapse). */
  rejectAuth = false;
  /** Hang leg: connections are accepted and NEVER answered (the client-
   *  enforced timeout is the only way out — D6's wedged-tunnel case). */
  hang = false;

  async start(preferPort?: number): Promise<number> {
    this.requests = 0;
    const server = http.createServer((req, res) => {
      this.requests++;
      if (this.hang) return; // never answered — the client times out
      if (this.rejectAuth || req.headers.authorization !== hubUpstreamAuthHeader(HUB_PASSWORD)) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/session")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(HUB_SESSIONS));
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/session")) {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses-hub-new", created: true }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/global/health")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: true, version: HUB_VERSION }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(preferPort ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The kill leg: the socket closes — the next attempt is ECONNREFUSED. */
  async kill(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  /** The rejoin leg: the SAME port listens again (a tunnel back up). */
  async rejoin(): Promise<void> {
    await this.start(this.port);
  }
}

// ── fixture engine (the local engine remains a data source — D2) ─────────────

async function startFixtureEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(LOCAL_SESSIONS));
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/global/health")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ healthy: true, version: HUB_VERSION }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

// ── fixture staging inputs (the lawful manifest + the entitlements file) ─────

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
          fields: [{ name: "upstream_mode", base_default: "engine" }],
        },
      ],
    }),
  );
}

function writeEntitlements(dir: string, codes: string[]): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "entitlements.toml"), `codes = [${codes.map((c) => `"${c}"`).join(", ")}]\n`);
}

function buildMockDist(root: string): string {
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>amicode</title></head><body><div id=root></div></body></html>");
  return dist;
}

// ── capture helper (the byte-identity spot check) ────────────────────────────

interface Captured {
  path: string;
  status: number;
  contentType: string;
  body: string;
}

async function capture(origin: string, engineToken: string): Promise<Captured[]> {
  const requests: Array<{ path: string; accept?: string; auth?: "engine" | "none" }> = [
    { path: "/", accept: "text/html", auth: "engine" },
    { path: "/amicode/profile", auth: "engine" },
    { path: "/amicode/fleet/status", auth: "engine" },
    { path: "/amicode/fleet/sessions", auth: "engine" },
    { path: "/session", auth: "engine" },
    { path: "/amicode/profile", auth: "none" },
  ];
  const out: Captured[] = [];
  for (const r of requests) {
    const headers: Record<string, string> = {};
    if (r.accept) headers["Accept"] = r.accept;
    if (r.auth === "engine") headers["Authorization"] = `Basic ${engineToken}`;
    const res = await fetch(`${origin}${r.path}`, { headers });
    out.push({
      path: r.path + (r.auth === "none" ? " (anon)" : ""),
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body: await res.text(),
    });
  }
  return out;
}

// ── the DRY run ──────────────────────────────────────────────────────────────

async function dryRun(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "amicode-fleet-beta-smoke-"));
  const dist = buildMockDist(root);
  const overlaySource = join(root, "overlay-source");
  writeDataPlaneManifest(overlaySource);
  const entitledDir = join(root, "entitled");
  const unentitledDir = join(root, "unentitled");
  writeEntitlements(entitledDir, ["amicissimo"]);
  writeEntitlements(unentitledDir, []);
  const hubFile = join(root, "fleet-hub.json");

  const savedHubFileEnv = process.env.AMICO_FLEET_HUB_FILE;
  process.env.AMICO_FLEET_HUB_FILE = hubFile;
  const engine = await startFixtureEngine();
  const hub = new FixtureHub();
  await hub.start();
  writeHubCredential({ baseUrl: hub.url, token: HUB_PASSWORD }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
  const engineToken = serverAuthToken(ENGINE_PASSWORD);
  const engineAuth = serverAuthHeader(ENGINE_PASSWORD);

  // D6 tuning, tightened for the legs: 2 no-responses enter hub-down, 2
  // healthy responses recover; the client-enforced data-plane timeout is
  // 400 ms so the hang leg is fast. Activation config resolves from here.
  const tuning = {
    degradedLatencyP95Ms: 2000,
    degradedWindowSamples: 5,
    hubDownConsecutiveNoResponses: 2,
    recoveryConsecutiveHealthy: 2,
  };
  const activationConfig = { hubUrl: hub.url, tunnelAlias: "smoke-fleet-hub", overlaySource, posture: tuning };
  const transport = { dataPlaneTimeoutMs: 400, writeTimeoutMs: 400, writeMaxRetries: 0 };

  try {
    // ══ Leg A — no-entitlement boot: byte identity ════════════════════════
    // Activation ARMED (config present) but the entitlement ABSENT: the
    // staging gate must light nothing — the fleet option was passed, the
    // surfaces do not exist, the bytes are the base's.
    const baseBoot = await startAmicodeService({ appendLine: () => undefined }, {
      engine: { password: ENGINE_PASSWORD, getUrl: () => engine.url },
      appDistRoot: dist,
    });
    const gatedActivation = resolveFleetActivation({ config: activationConfig, env: {} });
    const gatedBoot = await startAmicodeService({ appendLine: () => undefined }, {
      engine: { password: ENGINE_PASSWORD, getUrl: () => engine.url },
      appDistRoot: dist,
      fleetActivation: gatedActivation.armed
        ? { ...gatedActivation, entitlementConfigDir: unentitledDir }
        : gatedActivation,
      fleetTransport: transport,
    });
    try {
      assert(baseBoot !== undefined && gatedBoot !== undefined, "one of the leg-A boots failed to start");
      const baseOrigin = baseBoot!.url;
      const gatedOrigin = gatedBoot!.url;
      const [base, gated] = await Promise.all([capture(baseOrigin, engineToken), capture(gatedOrigin, engineToken)]);
      await check("A · no-entitlement byte-identity (spot check)", async () => {
        for (let i = 0; i < base.length; i++) {
          const b = base[i];
          const g = gated[i];
          assert(
            b.status === g.status && b.contentType === g.contentType && b.body === g.body,
            `request ${b.path} diverges: base ${b.status}/${b.body.length}B vs gated ${g.status}/${g.body.length}B`,
          );
        }
        return `${base.length} requests byte-identical across the base and the activation-armed-but-unentitled boot`;
      });
      await check("A · fleet surfaces absent (the base no-route 404)", async () => {
        const res = await fetch(`${gatedOrigin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        assert(res.status === 404, `GET /amicode/fleet/status → ${res.status}, want the base 404`);
        const body = (await res.json()) as { ok: boolean; error: string };
        assert(body.error === "no route: GET /amicode/fleet/status", `unexpected 404 shape: ${JSON.stringify(body)}`);
        return "fleet paths answer the base no-route shape — the fleet mode does not exist";
      });
    } finally {
      await baseBoot?.service.stop();
      await gatedBoot?.service.stop();
    }

    // ══ Leg B — armed boot: fleet mode arms end-to-end ════════════════════
    const armedActivation = resolveFleetActivation({ config: activationConfig, env: {} });
    const armedBoot = await startAmicodeService({ appendLine: () => undefined }, {
      engine: { password: ENGINE_PASSWORD, getUrl: () => engine.url },
      appDistRoot: dist,
      fleetActivation: armedActivation.armed ? { ...armedActivation, entitlementConfigDir: entitledDir } : armedActivation,
      fleetTransport: transport,
    });
    const origin = armedBoot?.url ?? "";
    try {
      assert(armedBoot !== undefined, "the armed boot failed to start");
      await check("B · activation arms → fleet mode staged", async () => {
        const res = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        assert(res.status === 200, `GET /amicode/fleet/status → ${res.status}, want 200`);
        const body = (await res.json()) as { ok: boolean; mode: string; staging: { staged: boolean; overlay_id?: string }; hub_credential: { ok: boolean } };
        assert(body.ok === true, `status not ok: ${JSON.stringify(body).slice(0, 200)}`);
        assert(body.mode === "fleet", `mode is ${body.mode}, want fleet`);
        assert(body.staging.staged === true, "the data-plane manifest did not stage");
        assert(body.hub_credential.ok === true, "the hub credential did not resolve");
        return `fleet mode armed via ${body.staging.overlay_id} — status answers, the hub credential resolves`;
      });
      await check("B · /amicode/fleet/sessions — the merged projection (both stores, provenance-tagged)", async () => {
        const res = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: engineAuth } });
        assert(res.status === 200, `GET /amicode/fleet/sessions → ${res.status}, want 200`);
        const body = (await res.json()) as {
          ok: boolean;
          sessions: Array<{ id: string; amicode_provenance?: string }>;
          sources: Record<string, { present: boolean; reason?: string }>;
          currency: { sources: string[] };
        };
        assert(body.ok === true, "projection not ok");
        const byId = new Map(body.sessions.map((s) => [s.id, s]));
        assert(byId.get("ses-local-1")?.amicode_provenance === "local", "the local session is missing or mis-tagged");
        assert(byId.get("ses-hub-1")?.amicode_provenance === "hub", "the hub session is missing or mis-tagged");
        assert(byId.get("ses-both")?.amicode_provenance === "hub", "the store-of-record conflict did not read hub-side");
        assert(body.sources.hub.present === true, `hub source absent: ${body.sources.hub.reason}`);
        assert(body.sources.local.present === true, "local source absent");
        assert([...body.currency.sources].sort().join(",") === "hub,local", `currency derived over ${body.currency.sources}`);
        return "both stores render in one list, provenance-tagged; currency tagged over [hub, local]";
      });

      // ══ Leg C — kill / hang / rejoin, through the REAL service ══════════
      await check("C · kill leg — the hub dies → the hub-down posture routes LOCALLY", async () => {
        await hub.kill();
        // N=2 tuned: two no-responses enter standalone
        for (let i = 0; i < 2; i++) {
          const r = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
          assert(r.status !== 200, `request ${i + 1} against the killed hub unexpectedly succeeded`);
        }
        const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        const body = (await status.json()) as { mode: string; posture: { state: string; pointer: string | null } };
        assert(body.posture.state === "standalone", `posture is ${body.posture.state}, want standalone (hub-down)`);
        assert(body.posture.pointer?.includes("hub-down") === true, "the hub-down pointer is not surfaced");
        // the next data request routes LOCALLY — the base standalone posture runs
        const local = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
        assert(local.status === 200, `the local engine did not answer in the hub-down posture: ${local.status}`);
        const list = (await local.json()) as Array<{ id: string }>;
        assert(list[0]?.id === "ses-local-1", "the hub-down answer is not the local engine's");
        return "2 no-responses → standalone (pointer surfaced); data requests route to the local engine";
      });
      await check("C · kill leg — the projection names the hub absence (never a silent one)", async () => {
        const res = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: engineAuth } });
        const body = (await res.json()) as { sources: Record<string, { present: boolean; reason?: string }>; currency: { sources: string[] } };
        assert(body.sources.hub.present === false, "the hub source claims present while the hub is dead");
        assert(body.sources.hub.reason !== undefined, "the hub absence is unnamed");
        assert(body.currency.sources.join(",") === "local", "currency not re-derived over the fetched sources");
        return `hub source named absent (${body.sources.hub.reason}); currency re-derived over [local]`;
      });
      await check("C · rejoin leg — the hub returns → recovery re-enters fleet (refetch epoch bumps)", async () => {
        const before = await (await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } })).json() as { posture: { refetch_epoch: number } };
        await hub.rejoin();
        // recovery probe = the always-mounted merged projection; 2 healthy → fleet
        for (let i = 0; i < 2; i++) {
          const r = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: engineAuth } });
          assert(r.status === 200, `recovery probe ${i + 1} → ${r.status}`);
          const b = (await r.json()) as { sources: Record<string, { present: boolean }> };
          assert(b.sources.hub.present === true, `recovery probe ${i + 1}: the hub side did not answer`);
        }
        const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        const body = (await status.json()) as { mode: string; posture: { state: string; refetch_epoch: number } };
        assert(body.posture.state === "fleet", `posture is ${body.posture.state}, want fleet after recovery`);
        assert(body.mode === "fleet", `mode is ${body.mode}, want fleet`);
        assert(body.posture.refetch_epoch > before.posture.refetch_epoch, "the refetch epoch did not bump on the transition");
        // data requests route to the hub again
        const hubRes = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
        const hubList = (await hubRes.json()) as Array<{ id: string }>;
        assert(hubList.some((s) => s.id === "ses-hub-1"), "data requests do not route to the rejoined hub");
        return `fleet re-entered after 2 healthy probes; refetch_epoch ${before.posture.refetch_epoch} → ${body.posture.refetch_epoch}; the hub serves data again`;
      });
      await check("C · hang leg — a wedged hub times out CLIENT-SIDE and enters hub-down (never welded)", async () => {
        hub.hang = true;
        // N=2 tuned at 400 ms each: two client-enforced timeouts → standalone
        for (let i = 0; i < 2; i++) {
          const r = await fetch(`${origin}/session`, { headers: { Authorization: engineAuth } });
          assert(r.status !== 200, `request ${i + 1} against the hung hub unexpectedly succeeded`);
        }
        const status = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        const body = (await status.json()) as { posture: { state: string } };
        assert(body.posture.state === "standalone", `posture is ${body.posture.state}, want standalone after the hang`);
        hub.hang = false;
        // recover through the projection probe
        for (let i = 0; i < 2; i++) {
          await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: engineAuth } });
        }
        const final = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        const fbody = (await final.json()) as { posture: { state: string } };
        assert(fbody.posture.state === "fleet", `posture is ${fbody.posture.state}, want fleet after the hang recovery`);
        return "a wedged hub → client-enforced timeouts → hub-down; recovery re-enters fleet (hysteresis held)";
      });

      // ══ Leg D — revocation mid-flight → read-only-with-pointer ══════════
      await check("D · revocation — the write is delivered while entitled", async () => {
        const res = await fetch(`${origin}/session`, {
          method: "POST",
          headers: { Authorization: engineAuth, "content-type": "application/json" },
          body: JSON.stringify({ title: "smoke fleet session" }),
        });
        assert(res.status === 201, `the entitled write → ${res.status}, want the hub's 201`);
        assert(hub.requests > 0, "the hub never saw the write");
        return "fleet write delivered (the hub 201 passed through)";
      });
      await check("D · revocation — the credential lapses mid-flight → read-only-with-pointer, never eaten", async () => {
        hub.rejectAuth = true;
        try {
          const res = await fetch(`${origin}/session`, {
            method: "POST",
            headers: { Authorization: engineAuth, "content-type": "application/json" },
            body: JSON.stringify({ title: "written after revocation" }),
          });
          assert(res.status === 401, `the revoked write → ${res.status}, want 401`);
          const body = (await res.json()) as { revocation?: { handoff: string; go_standalone: boolean } };
          const revocation = body.revocation;
          if (revocation === undefined) throw new Error(`no revocation handoff: ${JSON.stringify(body).slice(0, 200)}`);
          assert(revocation.handoff === "read-only-with-pointer", `wrong handoff: ${revocation.handoff}`);
          assert(revocation.go_standalone === true, "the Go-Standalone handoff is not offered");
        } finally {
          hub.rejectAuth = false;
        }
        // the standalone posture still runs — content is never eaten, never a wedge
        const ok = await fetch(`${origin}/amicode/profile`, { headers: { Authorization: engineAuth } });
        assert(ok.status === 200, `the base posture broke after revocation: ${ok.status}`);
        return "401 → read-only-with-pointer + Go-Standalone; the base posture keeps running";
      });
    } finally {
      await armedBoot?.service.stop();
    }
  } finally {
    if (savedHubFileEnv === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFileEnv;
    await engine.stop();
    await hub.kill();
    rmSync(root, { recursive: true, force: true });
  }
}

// ── the LIVE run (AMICODE_FLEET_SMOKE_LIVE=1) ────────────────────────────────

async function liveRun(): Promise<void> {
  // The machine's REAL activation config (env) and REAL entitlements — the
  // boot decides from what a beta tester actually provisioned.
  const activation = resolveFleetActivation();
  if (!activation.armed) {
    record("LIVE · activation", false, `not armed: ${activation.reason}`);
    return;
  }
  record("LIVE · activation", true, `armed: hub ${activation.hubUrl}, tunnel alias ${activation.tunnelAlias}`);

  const engine = await startFixtureEngine();
  try {
    const boot = await startAmicodeService({ appendLine: () => undefined }, {
      engine: { password: ENGINE_PASSWORD, getUrl: () => engine.url },
      fleetActivation: () => resolveFleetActivation(),
    });
    assert(boot !== undefined, "the service failed to boot");
    const origin = boot!.url;
    const engineAuth = serverAuthHeader(ENGINE_PASSWORD);
    try {
      await check("LIVE · fleet mode stages (the machine's real entitlement + overlay)", async () => {
        const res = await fetch(`${origin}/amicode/fleet/status`, { headers: { Authorization: engineAuth } });
        assert(res.status === 200, `GET /amicode/fleet/status → ${res.status} — the fleet mode did not stage (check the entitlement and the overlay source: AMICO_OVERLAY_SOURCE / AMICISSIMO_ROOT)`);
        const body = (await res.json()) as { mode: string; staging: { staged: boolean; absence_reason?: string; overlay_id?: string } };
        assert(body.staging.staged === true, `the data-plane overlay did not stage (${body.staging.absence_reason ?? "unknown"})`);
        return `staged via ${body.staging.overlay_id} against the real entitlement`;
      });
      await check("LIVE · the real hub answers through the tunnel (merged projection)", async () => {
        const res = await fetch(`${origin}/amicode/fleet/sessions`, { headers: { Authorization: engineAuth } });
        assert(res.status === 200, `GET /amicode/fleet/sessions → ${res.status}`);
        const body = (await res.json()) as {
          sources: Record<string, { present: boolean; reason?: string; count?: number }>;
          sessions: Array<{ id: string; amicode_provenance?: string }>;
        };
        assert(body.sources.hub.present === true, `the hub side did not answer (${body.sources.hub.reason ?? "unknown"}) — check the tunnel and the hub credential store`);
        assert(body.sources.local.present === true, "the local side did not answer");
        return `merged projection: ${body.sessions.length} sessions, hub count ${body.sources.hub.count}`;
      });
      if (activation.tunnelConfigPath === undefined) {
        record("LIVE · tunnel stamp (D7)", true, "SKIP (named): no AMICODE_FLEET_TUNNEL_CONFIG configured — the stamp is not surfaced (set it to run this leg)");
      } else {
        await check("LIVE · tunnel stamp (D7) — the installed config carries the alias, never the placeholder", async () => {
          const ins = inspectTunnelConfigFile(activation.tunnelConfigPath, activation.tunnelAlias);
          if (!ins.stamped) throw new Error(`the tunnel config is NOT stamped (${ins.reason}) — an unstamped tunnel cannot ship (the 2026-09-03 hand-rejoin finding)`);
          return `stamped: alias ${ins.alias}, generation ${ins.generation}`;
        });
      }
      record("LIVE · destructive legs", true, "SKIP (named): kill / hang / revoke are NEVER run against a real hub — the DRY legs prove those paths against the fixture hub");
    } finally {
      await boot!.service.stop();
    }
  } finally {
    await engine.stop();
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const live = process.env.AMICODE_FLEET_SMOKE_LIVE === "1";
  console.log(`[smoke] fleet beta smoke — ${live ? "LIVE (real hub, real entitlements)" : "DRY (fixtures only)"}\n`);
  if (live) await liveRun();
  else await dryRun();
  const failed = results.filter((r) => !r.pass);
  console.log(`\n[smoke] ${results.length - failed.length}/${results.length} legs passed${failed.length > 0 ? ` — ${failed.length} FAILED` : ""}`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`[smoke] FAILED: ${f.leg}: ${f.detail}`);
    process.exit(1);
  }
  console.log("[smoke] ALL LEGS PASS");
}

void main();

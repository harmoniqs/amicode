// Slice 4e (#398) — the fleet activation wiring: config/env-driven arming of
// the data plane's fleet mode, and the H3 discipline EXTENDED TO ACTIVATION.
//
// The activation gap (recorded by the Slice A/B casts): extension.ts never
// passes the fleet option to createAmicodeService — the wiring option and the
// staging log line existed, but nothing supplied the hub getter, so a beta
// machine had no path from "I configured a hub + tunnel" to "fleet mode arms".
// This file pins the contract that fills it:
//
//   1. resolveFleetActivation — config fields + env overrides → armed (hub
//      URL + tunnel alias + posture tuning) or NOT armed with a NAMED reason.
//      Absent config = absent surface: the fleet option is never passed.
//   2. The wiring (startAmicodeService) passes the fleet option ONLY when
//      activation is armed; the entitlement-staged gate still decides whether
//      fleet surfaces exist. Activation alone arms nothing.
//   3. The getter is LATE-BOUND — re-resolved per request, so a de-armed
//      activation is the honest upstream absence, never a stale snapshot.
//   4. Posture tuning is config-overridable with defaults equal to today's
//      fixture values (no behavior change unless configured).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo } from "node:net";
import { resolveFleetActivation, type FleetActivation } from "../src/fleet_activation";
import { startAmicodeService } from "../src/amicode_service_wiring";
import { serverAuthHeader, serverAuthToken } from "../src/server_auth";
import { writeHubCredential } from "../src/amicode_service/hub_credential";
import {
  DEGRADED_LATENCY_P95_MS,
  DEGRADED_WINDOW_SAMPLES,
  HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
  RECOVERY_CONSECUTIVE_HEALTHY,
} from "../src/amicode_service/fleet_posture";

const sinkLog = () => {
  const lines: string[] = [];
  return { lines, log: { appendLine: (l: string) => lines.push(l) } };
};

/** The lawful data-plane overlay manifest (the shipped manifest's shape). */
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

async function startMockEngine(): Promise<{ url: string; stop(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/session")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "ses-local", title: "local", time: { created: 1, updated: 2 } }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

/** An armed activation shape pointing at a real entitlements fixture + a
 *  manifest fixture (everything resolveFleetActivation does NOT inject:
 *  entitlements / entitlementConfigDir / overlaySource ride the shape for
 *  the wiring to pass through, undefined = the machine's real resolution). */
function armedActivation(over: Partial<Extract<FleetActivation, { armed: true }>> = {}): FleetActivation {
  return {
    armed: true,
    hubUrl: over.hubUrl ?? "http://127.0.0.1:9",
    tunnelAlias: over.tunnelAlias ?? "fleet-hub",
    posture: over.posture ?? {
      degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
      degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
      hubDownConsecutiveNoResponses: HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
      recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
    },
    notes: over.notes ?? [],
    ...(over.entitlements !== undefined ? { entitlements: over.entitlements } : {}),
    ...(over.entitlementConfigDir !== undefined ? { entitlementConfigDir: over.entitlementConfigDir } : {}),
    ...(over.overlaySource !== undefined ? { overlaySource: over.overlaySource } : {}),
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// resolveFleetActivation — config/env-driven, named outcomes
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveFleetActivation — config/env-driven activation (#398)", () => {
  it("no activation config → not armed, with the named reason (absent config = absent surface)", () => {
    const a = resolveFleetActivation({ config: {}, env: {} });
    expect(a.armed).toBe(false);
    if (!a.armed) expect(a.reason).toContain("no-activation-config");
  });

  it("a hub URL without a tunnel alias → not armed (the tunnel stamps its own config, D7 — an unstamped alias cannot ship)", () => {
    const a = resolveFleetActivation({ config: { hubUrl: "http://hub:4096" }, env: {} });
    expect(a.armed).toBe(false);
    if (!a.armed) expect(a.reason).toContain("tunnel-alias-missing");
  });

  it("a tunnel alias without a hub URL → not armed (hub-url-missing)", () => {
    const a = resolveFleetActivation({ config: { tunnelAlias: "fleet-hub" }, env: {} });
    expect(a.armed).toBe(false);
    if (!a.armed) expect(a.reason).toContain("hub-url-missing");
  });

  it("both config fields → armed, with posture tuning defaults equal to today's fixture values", () => {
    const a = resolveFleetActivation({ config: { hubUrl: "http://hub:4096", tunnelAlias: "fleet-hub" }, env: {} });
    expect(a.armed).toBe(true);
    if (!a.armed) return;
    expect(a.hubUrl).toBe("http://hub:4096");
    expect(a.tunnelAlias).toBe("fleet-hub");
    expect(a.posture).toEqual({
      degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
      degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
      hubDownConsecutiveNoResponses: HUB_DOWN_CONSECUTIVE_NO_RESPONSES,
      recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
    });
  });

  it("env overrides the config fields (the env equivalents win)", () => {
    const a = resolveFleetActivation({
      config: { hubUrl: "http://from-config:1", tunnelAlias: "config-alias" },
      env: { AMICODE_FLEET_HUB_URL: "http://from-env:2", AMICODE_FLEET_TUNNEL_ALIAS: "env-alias" },
    });
    expect(a.armed).toBe(true);
    if (!a.armed) return;
    expect(a.hubUrl).toBe("http://from-env:2");
    expect(a.tunnelAlias).toBe("env-alias");
  });

  it("empty/whitespace config values are absent, not armed-on-garbage", () => {
    const a = resolveFleetActivation({ config: { hubUrl: "   ", tunnelAlias: "" }, env: {} });
    expect(a.armed).toBe(false);
    if (!a.armed) expect(a.reason).toContain("no-activation-config");
  });

  it("the tunnel config path rides the config + env override (the D7 stamp surface)", () => {
    const a = resolveFleetActivation({
      config: { hubUrl: "http://hub:1", tunnelAlias: "a", tunnelConfigPath: "/from/config.plist" },
      env: { AMICODE_FLEET_TUNNEL_CONFIG: "/from/env.plist" },
    });
    expect(a.armed).toBe(true);
    if (!a.armed) return;
    expect(a.tunnelConfigPath).toBe("/from/env.plist");
  });

  it("posture tuning overrides are honored; an invalid value falls back to the default with a named note", () => {
    const good = resolveFleetActivation({
      config: { hubUrl: "http://hub:1", tunnelAlias: "a", posture: { hubDownConsecutiveNoResponses: 7 } },
      env: {},
    });
    expect(good.armed).toBe(true);
    if (good.armed) {
      expect(good.posture.hubDownConsecutiveNoResponses).toBe(7);
      expect(good.posture.degradedLatencyP95Ms).toBe(DEGRADED_LATENCY_P95_MS);
    }
    const bad = resolveFleetActivation({
      config: { hubUrl: "http://hub:1", tunnelAlias: "a", posture: { hubDownConsecutiveNoResponses: -3 } },
      env: {},
    });
    expect(bad.armed).toBe(true);
    if (bad.armed) {
      expect(bad.posture.hubDownConsecutiveNoResponses).toBe(HUB_DOWN_CONSECUTIVE_NO_RESPONSES);
      expect(bad.notes.some((n) => n.includes("hubDownConsecutiveNoResponses"))).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The activation wiring — the H3 discipline extends to activation
// ══════════════════════════════════════════════════════════════════════════════

describe("activation wiring — the fleet option is passed ONLY when activation is armed (#398)", () => {
  let root: string;
  let dist: string;
  let overlaySource: string;
  let entitledDir: string;
  let unentitledDir: string;
  let engine: Awaited<ReturnType<typeof startMockEngine>>;
  let engineToken: string;
  let savedHubFileEnv: string | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amicode-fleet-activation-"));
    dist = join(root, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><html><body><div id=root>wired</div></body></html>");
    overlaySource = join(root, "overlay-source");
    writeDataPlaneManifest(overlaySource);
    entitledDir = join(root, "entitled");
    unentitledDir = join(root, "unentitled");
    writeEntitlements(entitledDir, ["amicissimo"]);
    writeEntitlements(unentitledDir, []);
    engine = await startMockEngine();
    engineToken = serverAuthToken("engine-activation-mint");
    // The hub mint's store entry must be PRESENT for the proxy to attempt
    // the upstream at all (a missing credential is D5's named 503 and never
    // feeds the posture detector — D5's honesty, not D6's degradation). The
    // hub upstream itself is the dead port; the credential just unblocks
    // the attempt so the no-response outcome fires.
    const hubFile = join(root, "fleet-hub.json");
    writeHubCredential({ baseUrl: "http://127.0.0.1:9", token: "dead-hub-mint" }, { env: { AMICO_FLEET_HUB_FILE: hubFile } });
    savedHubFileEnv = process.env.AMICO_FLEET_HUB_FILE;
    process.env.AMICO_FLEET_HUB_FILE = hubFile;
  });

  afterAll(async () => {
    if (savedHubFileEnv === undefined) delete process.env.AMICO_FLEET_HUB_FILE;
    else process.env.AMICO_FLEET_HUB_FILE = savedHubFileEnv;
    await engine.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it("no activation config → the fleet option is NEVER passed: the boot log names it, the fleet paths answer the base no-route 404", async () => {
    const { lines, log } = sinkLog();
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-activation-mint", getUrl: () => engine.url },
      appDistRoot: dist,
      fleetActivation: () => resolveFleetActivation({ config: {}, env: {} }),
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      expect(lines.some((l) => l.includes("fleet activation: not armed"))).toBe(true);
      const r = await fetch(`${boot.url}/amicode/fleet/status`, {
        headers: { Authorization: serverAuthHeader("engine-activation-mint") },
      });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ ok: false, error: "no route: GET /amicode/fleet/status" });
    } finally {
      await boot.service.stop();
    }
  });

  it("activation alone arms NOTHING: armed config + entitlement ABSENT → staging refuses → zero fleet surfaces", async () => {
    const { lines, log } = sinkLog();
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-activation-mint", getUrl: () => engine.url },
      appDistRoot: dist,
      fleetActivation: armedActivation({ entitlements: [], entitlementConfigDir: unentitledDir, overlaySource }),
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      // the staging outcome is named in the boot log — entitlement absent
      expect(lines.some((l) => l.includes("fleet staging: entitlement absent"))).toBe(true);
      const r = await fetch(`${boot.url}/amicode/fleet/status`, {
        headers: { Authorization: serverAuthHeader("engine-activation-mint") },
      });
      expect(r.status).toBe(404);
    } finally {
      await boot.service.stop();
    }
  });

  it("armed activation + entitlement + lawful manifest → fleet mode arms end-to-end through the REAL wiring", async () => {
    const { lines, log } = sinkLog();
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-activation-mint", getUrl: () => engine.url },
      appDistRoot: dist,
      fleetActivation: armedActivation({ entitlementConfigDir: entitledDir, overlaySource }),
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    try {
      expect(lines.some((l) => l.includes("fleet staging: staged via fleet-data-plane"))).toBe(true);
      const auth = serverAuthHeader("engine-activation-mint");
      const status = await fetch(`${boot.url}/amicode/fleet/status`, { headers: { Authorization: auth } });
      expect(status.status).toBe(200);
      const body = (await status.json()) as { ok: boolean; mode: string; staging: { staged: boolean } };
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("fleet");
      expect(body.staging.staged).toBe(true);
    } finally {
      await boot.service.stop();
    }
  });

  it("the getter is LATE-BOUND: de-armed mid-session → the hub upstream is honestly absent (the named 503), never a stale snapshot", async () => {
    let current: FleetActivation = armedActivation({ entitlementConfigDir: entitledDir, overlaySource });
    const { log } = sinkLog();
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-activation-mint", getUrl: () => engine.url },
      fleetActivation: () => current,
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    const auth = serverAuthHeader("engine-activation-mint");
    try {
      // Armed at boot: the proxied data path attempts the (dead) hub upstream.
      // A dead URL is a named 502 from the proxy; the point of THIS test is
      // the de-arm, so assert the attempt happened (any named fleet outcome,
      // not the engine's answer).
      const armedRes = await fetch(`${boot.url}/session`, { headers: { Authorization: auth } });
      expect(armedRes.status).not.toBe(200);
      // De-arm mid-session: the getter re-resolves per request → no upstream.
      current = resolveFleetActivation({ config: {}, env: {} });
      const dearmed = await fetch(`${boot.url}/session`, { headers: { Authorization: auth } });
      expect(dearmed.status).toBe(503);
      expect(await dearmed.json()).toEqual({ ok: false, error: "hub upstream not available" });
    } finally {
      await boot.service.stop();
    }
  });

  it("posture tuning reaches the detector end-to-end: hubDownConsecutiveNoResponses=1 → one no-response flips the mode to engine (the hub-down posture routes locally)", async () => {
    const { log } = sinkLog();
    const boot = await startAmicodeService(log, {
      engine: { password: "engine-activation-mint", getUrl: () => engine.url },
      fleetActivation: armedActivation({
        entitlementConfigDir: entitledDir,
        overlaySource,
        posture: {
          degradedLatencyP95Ms: DEGRADED_LATENCY_P95_MS,
          degradedWindowSamples: DEGRADED_WINDOW_SAMPLES,
          hubDownConsecutiveNoResponses: 1,
          recoveryConsecutiveHealthy: RECOVERY_CONSECUTIVE_HEALTHY,
        },
      }),
    });
    expect(boot).toBeDefined();
    if (!boot) return;
    const auth = serverAuthHeader("engine-activation-mint");
    try {
      // One request against the dead hub upstream (hubUrl is a closed port):
      // the no-response feeds the detector, N=1 → standalone → mode engine.
      const dead = await fetch(`${boot.url}/session`, { headers: { Authorization: auth } });
      expect(dead.status).not.toBe(200);
      // The NEXT request routes LOCALLY — the hub-down posture IS the base
      // standalone posture (D6): the engine answers, the hub is never asked.
      const local = await fetch(`${boot.url}/session`, { headers: { Authorization: auth } });
      expect(local.status).toBe(200);
      const body = (await local.json()) as Array<{ id: string }>;
      expect(body[0]?.id).toBe("ses-local");
      // The posture is surfaced through the status route with the honest pointer.
      const status = await fetch(`${boot.url}/amicode/fleet/status`, { headers: { Authorization: auth } });
      const sbody = (await status.json()) as {
        mode: string;
        posture: { state: string; pointer: string | null };
      };
      expect(sbody.mode).toBe("engine");
      expect(sbody.posture.state).toBe("standalone");
      expect(sbody.posture.pointer).toContain("hub-down");
    } finally {
      await boot.service.stop();
    }
  });
});

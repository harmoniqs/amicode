// fleet_transport.test.ts — #1260 (Slice 1: seam + `ssh`): the pluggable
// transport provider seam and its `ssh` provider (the walking skeleton).
//
// The Data Contract (issue #1260): a transport provider yields
//   resolveBaseUrl() → URL   — the hub proxy consumes it,
//   health()        → status — posture consumes it,
//   start()/stop()           — the extension host owns lifecycle.
// The `ssh` provider is the CURRENT launchd `-L` forward refactored behind the
// seam (systemd as its Linux form). This file pins the seam + the ssh provider;
// the `tailscale` / `direct` providers are LATER slices (named here only as the
// seam members the no-fallback law refuses to substitute).
import { describe, it, expect, afterEach } from "vitest";
import {
  createSshProvider,
  createTailscaleProvider,
  createDirectProvider,
  resolveFleetTransportKind,
  transportForSelection,
  transportHealthToOutcome,
  sshForwardArgs,
  systemdTunnelUnit,
  tailscaleServeMapping,
  hubUrlStringFromProvider,
} from "../src/amicode_service/fleet_transport";
import { FleetPostureDetector } from "../src/amicode_service/fleet_posture";
import { isLoopbackHostname } from "../src/amicode_service/bind_host";
import { solverModeResponse } from "../src/amicode_service/solver_mode";
import { startStubHub, type StubHub } from "./support/stub_hub";

let hub: StubHub | undefined;
afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

describe("#1260 ssh provider — resolveBaseUrl (AC2: the loopback base URL through the interface)", () => {
  it("yields the configured loopback URL the launchd/systemd `-L` forward binds", () => {
    const p = createSshProvider({ resolveUrl: () => "http://127.0.0.1:4096" });
    expect(p.kind).toBe("ssh");
    const u = p.resolveBaseUrl();
    expect(u).toBeInstanceOf(URL);
    expect(u?.hostname).toBe("127.0.0.1");
    expect(u?.port).toBe("4096");
  });

  it("resolves LATE (per call): a de-armed forward yields undefined — the honest hub-down, never a stale snapshot", () => {
    let url: string | undefined = "http://127.0.0.1:4096";
    const p = createSshProvider({ resolveUrl: () => url });
    expect(p.resolveBaseUrl()).toBeInstanceOf(URL);
    url = undefined; // the forward went away (de-armed / tunnel down)
    expect(p.resolveBaseUrl()).toBeUndefined(); // no base URL bound = honest-down
  });

  it("start()/stop() complete the Data Contract — the ssh provider defers to the OS service manager (launchd/systemd), so they are documented no-ops that never disturb URL resolution", async () => {
    // The launchd/systemd tunnel lifecycle is OS-managed (installed by the
    // fleet installer) in this build — the ssh provider does not own it, so
    // start()/stop() are honest no-ops. The seam members exist so the
    // tailscale/direct slices (which DO own lifecycle) implement them.
    const p = createSshProvider({ resolveUrl: () => "http://127.0.0.1:4096" });
    await expect(p.start()).resolves.toBeUndefined();
    await expect(p.stop()).resolves.toBeUndefined();
    // lifecycle calls never disturb the base-URL seam
    expect(p.resolveBaseUrl()?.port).toBe("4096");
  });
});

// ── the `tailscale` provider (THIS slice, #1260) ─────────────────────────────
// The host runs `tailscale serve` fronting its LOOPBACK service; the client
// points the hub proxy at the host's MagicDNS origin. `tailscale` is not on CI,
// so the MagicDNS resolution is modeled behind an injectable seam
// (resolveMagicDnsOrigin) exactly as the ssh provider models its forward
// (resolveUrl) — these test the provider logic, never the `tailscale` binary.
describe("#1260 tailscale provider — resolveBaseUrl (AC1: the host's MagicDNS origin as the base URL)", () => {
  it("resolves the host's MagicDNS origin (https://<host>.<tailnet>.ts.net) as the base URL", () => {
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => "https://amico-host.tail9c7b.ts.net" });
    expect(p.kind).toBe("tailscale");
    const u = p.resolveBaseUrl();
    expect(u).toBeInstanceOf(URL);
    expect(u?.protocol).toBe("https:"); // `tailscale serve` fronts on HTTPS (443) by default
    expect(u?.hostname).toBe("amico-host.tail9c7b.ts.net");
  });

  it("resolves LATE (per call): a torn-down `tailscale serve` / logged-out tailnet yields undefined — the honest hub-down, never a stale snapshot, never another provider's URL", () => {
    let origin: string | undefined = "https://amico-host.tail9c7b.ts.net";
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => origin });
    expect(p.resolveBaseUrl()).toBeInstanceOf(URL);
    origin = undefined; // serve torn down / logged out of the tailnet
    expect(p.resolveBaseUrl()).toBeUndefined(); // no MagicDNS origin bound = honest hub-down
  });

  it("start()/stop() complete the Data Contract — `tailscale serve` is host-side (installer-provisioned) and tailscaled is a system daemon, so the client provider's lifecycle calls are honest no-ops that never disturb URL resolution", async () => {
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => "https://amico-host.tail9c7b.ts.net" });
    await expect(p.start()).resolves.toBeUndefined();
    await expect(p.stop()).resolves.toBeUndefined();
    expect(p.resolveBaseUrl()?.hostname).toBe("amico-host.tail9c7b.ts.net");
  });
});

describe("#1260 tailscale provider — health + honest hub-down (AC: MagicDNS health; shared AC: no reachable host → honest hub-down, never a silent fallback)", () => {
  it("a reachable host (its `tailscale serve` origin, modeled by the stub hub) answers → { reachable: true } with latency + parsed version", async () => {
    hub = await startStubHub({ version: "v1.18.29" });
    // the stub hub stands in for the host's `tailscale serve` origin — loopback
    // in CI, a MagicDNS name in prod; the provider only ever sees a base URL
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => hub!.url });
    const h = await p.health();
    expect(h.reachable).toBe(true);
    if (h.reachable) {
      expect(typeof h.latencyMs).toBe("number");
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      expect(h.version).toBe("v1.18.29");
    }
    // the probe hit the transport's own health endpoint, not a data-plane route
    expect(hub.requests.some((r) => r.startsWith("GET /global/health"))).toBe(true);
  });

  it("no reachable host (a dead origin) → { reachable: false } with a named reason (honest, never a fabricated up)", async () => {
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => "http://127.0.0.1:1", timeoutMs: 500 });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toBeTruthy();
  });

  it("no MagicDNS origin resolved (torn-down serve / logged-out tailnet) → { reachable: false, reason: no-base-url } — the honest hub-down, not a probe to nowhere", async () => {
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => undefined });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toContain("no-base-url");
  });

  it("shared drop-vs-slow contract: an unreachable tailscale host maps to `no-response` whose detail NAMES tailscale — the REUSED transportHealthToOutcome, not a per-provider detector (AC4 per-provider signature)", () => {
    const o = transportHealthToOutcome({ reachable: false, reason: "ETIMEDOUT (DERP)" }, "tailscale");
    expect(o.kind).toBe("no-response");
    if (o.kind === "no-response") {
      expect(o.detail).toContain("tailscale"); // a Tailscale roam is told apart from an SSH drop
      expect(o.detail).toContain("ETIMEDOUT");
    }
  });

  it("shared AC: a down tailscale transport drives HUB-DOWN through the SAME FleetPostureDetector — the honest hub-down posture, NEVER a reroute to ssh", async () => {
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => "http://127.0.0.1:1", timeoutMs: 300 });
    const det = new FleetPostureDetector({ tuning: { hubDownConsecutiveNoResponses: 3 } });
    for (let i = 0; i < 3; i++) {
      det.record(transportHealthToOutcome(await p.health(), p.kind));
    }
    expect(det.snapshot().state).toBe("standalone"); // the hub-down posture (base standalone + pointer)
    expect(det.snapshot().pointer).toContain("hub-down");
  });

  it("end-to-end: a reachable tailscale origin feeds the SAME contract → fleet stays up (no reroute needed)", async () => {
    hub = await startStubHub();
    const p = createTailscaleProvider({ resolveMagicDnsOrigin: () => hub!.url });
    const det = new FleetPostureDetector();
    det.record(transportHealthToOutcome(await p.health(), p.kind));
    expect(det.snapshot().state).toBe("fleet"); // a healthy transport keeps fleet posture
  });
});

// ── the `direct` provider (THIS slice, #1260 — the FINAL provider) ───────────
// For a host already reachable on a VPN/LAN, the OPERATOR arranges reachability
// OUT-OF-BAND; the provider is just the supplied URL plus a health probe, with
// NO tunnel-manager lifecycle (unlike ssh's OS-managed forward or tailscale's
// host-side `serve`). The supplied URL points at the host's own edge, which
// itself binds loopback behind it — direct authorizes NO non-loopback engine
// bind. The supplied-URL resolution is modeled behind an injectable seam
// (resolveUrl) exactly as ssh models its forward — these test provider logic,
// never a live VPN/LAN.
describe("#1260 direct provider — resolveBaseUrl (AC: targets a SUPPLIED URL)", () => {
  it("resolves the operator-supplied URL (a VPN/LAN-reachable host's edge) as the base URL", () => {
    const p = createDirectProvider({ resolveUrl: () => "https://amico-host.vpn.example:4096" });
    expect(p.kind).toBe("direct");
    const u = p.resolveBaseUrl();
    expect(u).toBeInstanceOf(URL);
    expect(u?.hostname).toBe("amico-host.vpn.example");
    expect(u?.port).toBe("4096");
  });

  it("resolves LATE (per call): a cleared supplied URL yields undefined — the honest hub-down, never a stale snapshot, never another provider's URL", () => {
    let url: string | undefined = "https://amico-host.vpn.example:4096";
    const p = createDirectProvider({ resolveUrl: () => url });
    expect(p.resolveBaseUrl()).toBeInstanceOf(URL);
    url = undefined; // the operator's reachability went away (VPN down / URL cleared)
    expect(p.resolveBaseUrl()).toBeUndefined(); // no supplied URL bound = honest hub-down
  });

  it("start()/stop() are honest no-ops — direct owns NO tunnel-manager lifecycle (the operator arranges reachability out-of-band), and they never disturb URL resolution", async () => {
    // Unlike ssh (OS-managed launchd/systemd forward) and tailscale (host-side
    // `tailscale serve` + system daemon), `direct` manages NOTHING: reachability
    // is arranged out-of-band, so start()/stop() are honest no-ops.
    const p = createDirectProvider({ resolveUrl: () => "https://amico-host.vpn.example:4096" });
    await expect(p.start()).resolves.toBeUndefined();
    await expect(p.stop()).resolves.toBeUndefined();
    expect(p.resolveBaseUrl()?.port).toBe("4096"); // lifecycle calls never disturb the base-URL seam
  });
});

describe("#1260 direct provider — health + honest hub-down (AC: a health probe; shared AC: no reachable host → honest hub-down, never a silent fallback)", () => {
  it("a reachable supplied host (modeled by the stub hub) answers → { reachable: true } with latency + parsed version", async () => {
    hub = await startStubHub({ version: "v1.18.29" });
    // the stub hub stands in for the operator-supplied VPN/LAN URL — loopback in
    // CI, a routable host in prod; the provider only ever sees a base URL
    const p = createDirectProvider({ resolveUrl: () => hub!.url });
    const h = await p.health();
    expect(h.reachable).toBe(true);
    if (h.reachable) {
      expect(typeof h.latencyMs).toBe("number");
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      expect(h.version).toBe("v1.18.29");
    }
    // the probe hit the transport's own health endpoint, not a data-plane route
    expect(hub.requests.some((r) => r.startsWith("GET /global/health"))).toBe(true);
  });

  it("no reachable host (a dead supplied URL) → { reachable: false } with a named reason (honest, never a fabricated up)", async () => {
    const p = createDirectProvider({ resolveUrl: () => "http://127.0.0.1:1", timeoutMs: 500 });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toBeTruthy();
  });

  it("no supplied URL (nothing configured) → { reachable: false, reason: no-base-url } — the honest hub-down, not a probe to nowhere", async () => {
    const p = createDirectProvider({ resolveUrl: () => undefined });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toContain("no-base-url");
  });

  it("shared drop-vs-slow contract: an unreachable direct host maps to `no-response` whose detail NAMES direct — the REUSED transportHealthToOutcome, not a per-provider detector (AC per-provider signature)", () => {
    const o = transportHealthToOutcome({ reachable: false, reason: "ECONNREFUSED (VPN down)" }, "direct");
    expect(o.kind).toBe("no-response");
    if (o.kind === "no-response") {
      expect(o.detail).toContain("direct"); // a direct drop is told apart from an ssh/tailscale drop
      expect(o.detail).toContain("ECONNREFUSED");
    }
  });

  it("shared AC: a down direct transport drives HUB-DOWN through the SAME FleetPostureDetector — the honest hub-down posture, NEVER a reroute to ssh/tailscale", async () => {
    const p = createDirectProvider({ resolveUrl: () => "http://127.0.0.1:1", timeoutMs: 300 });
    const det = new FleetPostureDetector({ tuning: { hubDownConsecutiveNoResponses: 3 } });
    for (let i = 0; i < 3; i++) {
      det.record(transportHealthToOutcome(await p.health(), p.kind));
    }
    expect(det.snapshot().state).toBe("standalone"); // the hub-down posture (base standalone + pointer)
    expect(det.snapshot().pointer).toContain("hub-down");
  });

  it("end-to-end: a reachable direct URL feeds the SAME contract → fleet stays up (no reroute needed)", async () => {
    hub = await startStubHub();
    const p = createDirectProvider({ resolveUrl: () => hub!.url });
    const det = new FleetPostureDetector();
    det.record(transportHealthToOutcome(await p.health(), p.kind));
    expect(det.snapshot().state).toBe("fleet"); // a healthy transport keeps fleet posture
  });
});

describe("#1260 ssh provider — health (AC2: a health signal through the interface)", () => {
  it("a reachable host answers → { reachable: true } with the measured latency + the parsed version", async () => {
    hub = await startStubHub({ version: "v1.18.29" });
    const p = createSshProvider({ resolveUrl: () => hub!.url });
    const h = await p.health();
    expect(h.reachable).toBe(true);
    if (h.reachable) {
      expect(typeof h.latencyMs).toBe("number");
      expect(h.latencyMs).toBeGreaterThanOrEqual(0);
      expect(h.version).toBe("v1.18.29");
    }
    // the probe hit the transport's own health endpoint, not a data-plane route
    expect(hub.requests.some((r) => r.startsWith("GET /global/health"))).toBe(true);
  });

  it("no reachable host (a dead port) → { reachable: false } with a named reason (AC3: honest, never a fabricated up)", async () => {
    // 127.0.0.1:1 is not listening — a connection refusal, not a slow link
    const p = createSshProvider({ resolveUrl: () => "http://127.0.0.1:1", timeoutMs: 500 });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toBeTruthy();
  });

  it("no base URL bound → { reachable: false, reason: no-base-url } — the honest hub-down, not a probe to nowhere", async () => {
    const p = createSshProvider({ resolveUrl: () => undefined });
    const h = await p.health();
    expect(h.reachable).toBe(false);
    if (!h.reachable) expect(h.reason).toContain("no-base-url");
  });
});

describe("#1260 resolveFleetTransportKind — the amicode.fleetTransport knob (AC1 select; AC3 no cross-provider fallback)", () => {
  it("unset / empty → ssh (the default; unset reproduces today's behavior)", () => {
    expect(resolveFleetTransportKind({})).toEqual({ ok: true, kind: "ssh" });
    expect(resolveFleetTransportKind({ setting: "" })).toEqual({ ok: true, kind: "ssh" });
    expect(resolveFleetTransportKind({ setting: "   " })).toEqual({ ok: true, kind: "ssh" });
    expect(resolveFleetTransportKind({ setting: null })).toEqual({ ok: true, kind: "ssh" });
  });

  it("an explicit `ssh` selects the ssh provider", () => {
    expect(resolveFleetTransportKind({ setting: "ssh" })).toEqual({ ok: true, kind: "ssh" });
    expect(resolveFleetTransportKind({ setting: "SSH" })).toEqual({ ok: true, kind: "ssh" }); // case/space tolerant
  });

  it("a provider not registered in THIS build (direct) → a NAMED not-ok, NEVER a silent fallback to ssh (AC3)", () => {
    // tailscale shipped in #1260, so `direct` is now the still-unshipped seam
    // member that pins the no-cross-provider-fallback law.
    const d = resolveFleetTransportKind({ setting: "direct" }); // available defaults to ssh+tailscale
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toContain("direct");
      expect(d.reason).toContain("unavailable");
    }
    // the seam KNOWS the kind (it is a valid member) — it just is not shipped yet;
    // resolution reports that honestly and does not substitute ssh.
    expect((d as { kind?: string }).kind).not.toBe("ssh");
  });

  it("an unknown kind → a NAMED not-ok (unknown-transport), never a fallback", () => {
    const r = resolveFleetTransportKind({ setting: "carrier-pigeon" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown-transport");
  });

  it("providers are independently disableable: disabling ssh → a NAMED off state, never a fallback to another provider (AC3)", () => {
    const r = resolveFleetTransportKind({ setting: "ssh", disabled: ["ssh"] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ssh-disabled");
  });

  it("#1260 tailscale slice: tailscale is independently disableable → a NAMED off state, never a fallback (AC: independently disableable + AC3)", () => {
    const r = resolveFleetTransportKind({ setting: "tailscale", disabled: ["tailscale"] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("tailscale-disabled");
      expect(r.reason).not.toContain("ssh"); // disabling tailscale never reroutes to ssh
    }
  });

  it("a provider becomes selectable once its slice registers it (the seam is additive)", () => {
    // the tailscale/direct slices land by adding themselves to `available`
    expect(resolveFleetTransportKind({ setting: "tailscale", available: ["ssh", "tailscale"] })).toEqual({
      ok: true,
      kind: "tailscale",
    });
  });

  it("#1260 tailscale slice: tailscale is selectable by DEFAULT now (its provider shipped — added to the available set)", () => {
    // no explicit `available` — the default set now includes tailscale
    expect(resolveFleetTransportKind({ setting: "tailscale" })).toEqual({ ok: true, kind: "tailscale" });
    expect(resolveFleetTransportKind({ setting: "TAILSCALE" })).toEqual({ ok: true, kind: "tailscale" }); // case/space tolerant
  });
});

// ── #1260 transportForSelection — a selection maps to ITS OWN provider ───────
// The wiring maps a resolved selection → a provider. AC3's law: an OK kind gets
// its OWN provider (never another kind's — no silent cross-provider
// substitution), and a not-ok selection binds NO base URL (the honest hub-down),
// never the configured URL wrapped in a different provider.
describe("#1260 transportForSelection — a selection maps to ITS OWN provider (AC3: no cross-provider substitution)", () => {
  it("ssh selection → an ssh provider wrapping the resolver (no regression)", () => {
    const p = transportForSelection({ ok: true, kind: "ssh" }, () => "http://127.0.0.1:4096");
    expect(p.kind).toBe("ssh");
    expect(p.resolveBaseUrl()?.port).toBe("4096");
  });

  it("tailscale selection → a TAILSCALE provider (NEVER a silent ssh substitution) resolving the same base-URL source", () => {
    const p = transportForSelection({ ok: true, kind: "tailscale" }, () => "https://amico-host.tail9c7b.ts.net");
    expect(p.kind).toBe("tailscale"); // the load-bearing anti-substitution assertion
    expect(p.resolveBaseUrl()?.hostname).toBe("amico-host.tail9c7b.ts.net");
  });

  it("a not-ok selection (unshipped `direct`) binds NO base URL — honest hub-down, never the configured URL under another provider", () => {
    const sel = resolveFleetTransportKind({ setting: "direct" }); // unshipped in this build
    expect(sel.ok).toBe(false);
    const p = transportForSelection(sel, () => "http://127.0.0.1:4096");
    expect(p.resolveBaseUrl()).toBeUndefined(); // NOT the configured URL — no fallback
  });
});

// ── AC4: the SHARED drop-vs-slow-link posture contract (this slice OWNS it) ──
// A provider's health() maps to the existing FleetPostureDetector's outcome
// stream through ONE mapping — reachable → responded (the detector's p95 window
// decides slow-but-healthy → degraded), unreachable → no-response (its streak
// decides sustained → hub-down). The tailscale/direct providers plug their
// health() into the SAME mapping; the provider `kind` rides the reason so a
// Tailscale roam and an SSH drop are told apart (ADR 0024's per-provider dimension).
describe("#1260 transportHealthToOutcome — the shared drop-vs-slow contract (AC4)", () => {
  it("reachable → a `responded` outcome carrying the measured latency", () => {
    const o = transportHealthToOutcome({ reachable: true, latencyMs: 42, version: "v1" }, "ssh");
    expect(o.kind).toBe("responded");
    if (o.kind === "responded") expect(o.latencyMs).toBe(42);
  });

  it("unreachable → a `no-response` outcome whose detail NAMES the provider (per-provider signature)", () => {
    const o = transportHealthToOutcome({ reachable: false, reason: "ECONNREFUSED" }, "ssh");
    expect(o.kind).toBe("no-response");
    if (o.kind === "no-response") {
      expect(o.detail).toContain("ssh");
      expect(o.detail).toContain("ECONNREFUSED");
    }
  });

  it("a SLOW-but-healthy link (reachable, high latency over the window) drives DEGRADED — a drop, it is not", () => {
    // window=3, p95 threshold=2000ms; feed reachable-but-slow health through the map
    const det = new FleetPostureDetector({ tuning: { degradedWindowSamples: 3, degradedLatencyP95Ms: 2000 } });
    for (let i = 0; i < 3; i++) {
      det.record(transportHealthToOutcome({ reachable: true, latencyMs: 2500, version: null }, "ssh"));
    }
    expect(det.snapshot().state).toBe("degraded"); // hub-up-but-slow, usable + honest
    expect(det.snapshot().state).not.toBe("standalone"); // NOT mistaken for a drop
  });

  it("a transport DROP (unreachable, N consecutive) drives HUB-DOWN — a slow link, it is not", () => {
    const det = new FleetPostureDetector({ tuning: { hubDownConsecutiveNoResponses: 3 } });
    for (let i = 0; i < 3; i++) {
      det.record(transportHealthToOutcome({ reachable: false, reason: "timeout" }, "ssh"));
    }
    expect(det.snapshot().state).toBe("standalone"); // the hub-down posture (base standalone + pointer)
    expect(det.snapshot().pointer).toContain("hub-down");
  });

  it("end-to-end: the ssh provider's live health() feeds the SAME contract (reachable host → responded → fleet stays up)", async () => {
    hub = await startStubHub();
    const p = createSshProvider({ resolveUrl: () => hub!.url });
    const det = new FleetPostureDetector();
    det.record(transportHealthToOutcome(await p.health(), p.kind));
    expect(det.snapshot().state).toBe("fleet"); // a healthy transport keeps fleet posture
  });
});

// ── the ssh provider's OS forms — one forward, two service managers ──────────
// The current launchd plist (co.harmoniqs.amico-tunnel.plist) IS the ssh
// provider's macOS form; the systemd unit is its Linux form (#1260 owns the
// Linux tunnel; fleet_health's tunnel check still self-skips linux — that
// rewire is a follow-up). Both run the SAME `ssh -N ... -L ...` forward.
describe("#1260 ssh provider OS forms — the loopback-only `-L` forward (ADR 0002/0005)", () => {
  it("sshForwardArgs render the hardened forward matching the launchd plist (15/2 + TCPKeepAlive + ExitOnForwardFailure)", () => {
    const args = sshForwardArgs({ alias: "fleet-hub", port: 4096 });
    expect(args).toContain("-N");
    expect(args.join(" ")).toContain("ExitOnForwardFailure=yes");
    expect(args.join(" ")).toContain("ServerAliveInterval=15");
    expect(args.join(" ")).toContain("ServerAliveCountMax=2");
    expect(args.join(" ")).toContain("TCPKeepAlive=yes");
    // the alias is the LAST arg (the ssh destination), like the plist
    expect(args[args.length - 1]).toBe("fleet-hub");
  });

  it("the `-L` forward binds LOOPBACK on BOTH ends — never a tailnet/non-loopback bind (the mutation guard stays honest)", () => {
    const args = sshForwardArgs({ alias: "h", port: 4096 });
    const li = args.indexOf("-L");
    expect(li).toBeGreaterThanOrEqual(0);
    expect(args[li + 1]).toBe("127.0.0.1:4096:127.0.0.1:4096"); // local 127.0.0.1 → remote 127.0.0.1
    // no forward spec ever binds 0.0.0.0 or a 100.x tailnet address
    expect(args.join(" ")).not.toContain("0.0.0.0");
    expect(args.join(" ")).not.toMatch(/\b100\.\d+\.\d+\.\d+/);
  });

  it("the port flows through the forward spec (a non-default canonical port)", () => {
    const args = sshForwardArgs({ alias: "h", port: 7777 });
    expect(args[args.indexOf("-L") + 1]).toBe("127.0.0.1:7777:127.0.0.1:7777");
  });

  it("systemdTunnelUnit is the Linux form of the launchd plist — a user service running the same forward, restart-on-failure", () => {
    const unit = systemdTunnelUnit({ alias: "fleet-hub", port: 4096 });
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("/usr/bin/ssh");
    expect(unit).toContain("127.0.0.1:4096:127.0.0.1:4096"); // the same loopback-only forward
    expect(unit).toContain("fleet-hub");
    expect(unit).toContain("Restart="); // the KeepAlive equivalent (launchd KeepAlive → systemd Restart)
  });
});

// ── the `tailscale serve` host form — the loopback-preservation building block ─
// The ssh provider's OS form is a loopback `-L` forward; the tailscale
// provider's host form is `tailscale serve` fronting a loopback target. This
// is WHY `serve` is chosen over a direct tailnet-IP bind (ADR 0024): the host's
// engine/service keeps binding 127.0.0.1, so the mutation guard never trips.
describe("#1260 tailscaleServeMapping — the loopback-only host form (ADR 0024: `serve`, not a direct tailnet bind)", () => {
  it("maps the public MagicDNS origin → a LOOPBACK target (127.0.0.1) — the host engine/service bind stays loopback", () => {
    const m = tailscaleServeMapping({ magicDnsName: "amico-host.tail9c7b.ts.net", port: 4096 });
    // the public face is the MagicDNS origin the client resolves as its base URL
    expect(m.magicDnsOrigin).toBe("https://amico-host.tail9c7b.ts.net");
    // the target `tailscale serve` proxies TO is LOOPBACK — never 0.0.0.0, never a tailnet 100.x
    const target = new URL(m.target);
    expect(target.hostname).toBe("127.0.0.1");
    expect(target.port).toBe("4096");
    expect(isLoopbackHostname(target.hostname)).toBe(true); // the guard's own predicate agrees
    expect(m.target).not.toContain("0.0.0.0");
    expect(m.target).not.toMatch(/\b100\.\d+\.\d+\.\d+/);
  });

  it("the `tailscale serve` argv fronts the loopback target in the background — never binds the engine to the tailnet IP", () => {
    const m = tailscaleServeMapping({ magicDnsName: "amico-host.tail9c7b.ts.net", port: 4096 });
    expect(m.args[0]).toBe("serve"); // `tailscale serve ...`
    const argv = m.args.join(" ");
    expect(argv).toContain("http://127.0.0.1:4096"); // the loopback target it proxies to
    expect(argv).not.toContain("0.0.0.0");
    expect(argv).not.toMatch(/\b100\.\d+\.\d+\.\d+/);
  });

  it("the port flows through the serve target (a non-default canonical port)", () => {
    const m = tailscaleServeMapping({ magicDnsName: "h.tailnet.ts.net", port: 7777 });
    expect(new URL(m.target).port).toBe("7777");
  });

  it("#775 front-door composition: `tailscale serve` targets the SAME loopback front-door endpoint the ssh forward reaches — through the front door, never around it", () => {
    const port = 4096; // the ONE canonical hub front-door (loopback) port both transports reach
    const serve = tailscaleServeMapping({ magicDnsName: "h.tailnet.ts.net", port });
    // the ssh forward's far end (the front door it dials) is 127.0.0.1:<port>
    const sshForward = sshForwardArgs({ alias: "h", port });
    expect(sshForward.join(" ")).toContain(`127.0.0.1:${port}:127.0.0.1:${port}`);
    // the tailscale serve target is the SAME loopback front-door endpoint — the
    // provider reaches the hub THROUGH its #775 front door, never a divergent
    // bypass (a different port, 0.0.0.0, or the tailnet IP re-exposes the wedge).
    const t = new URL(serve.target);
    expect(t.hostname).toBe("127.0.0.1");
    expect(t.port).toBe(String(port));
    expect(serve.target).not.toMatch(/\b100\.\d+\.\d+\.\d+/); // never the tailnet IP (a bypass around the front door)
  });
});

// ── AC1 no-regression hinge: the provider → hub.getUrl(): string|undefined ───
// The hub proxy's existing seam is a `getUrl(): string | undefined`. The ssh
// provider's resolveBaseUrl(): URL must round-trip to the SAME string the
// activation configured, so unset/ssh reproduces today's behavior byte-for-byte.
describe("#1260 hubUrlStringFromProvider — the byte-identical adapter (AC1 no-regression)", () => {
  it("a bare origin round-trips WITHOUT a spurious trailing slash (byte-identical to the configured hub URL)", () => {
    const p = createSshProvider({ resolveUrl: () => "http://127.0.0.1:4096" });
    expect(hubUrlStringFromProvider(p)).toBe("http://127.0.0.1:4096"); // NOT ".../"
  });

  it("a de-armed / no-URL provider adapts to undefined (the existing honest-down signal, unchanged)", () => {
    const p = createSshProvider({ resolveUrl: () => undefined });
    expect(hubUrlStringFromProvider(p)).toBeUndefined();
  });

  it("a URL carrying a path preserves it (only the root's trailing slash is trimmed)", () => {
    const p = createSshProvider({ resolveUrl: () => "http://host:9/base" });
    expect(hubUrlStringFromProvider(p)).toBe("http://host:9/base");
  });
});

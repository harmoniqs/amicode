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
  resolveFleetTransportKind,
  transportHealthToOutcome,
  sshForwardArgs,
  systemdTunnelUnit,
  hubUrlStringFromProvider,
} from "../src/amicode_service/fleet_transport";
import { FleetPostureDetector } from "../src/amicode_service/fleet_posture";
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

  it("a provider not registered in THIS build (tailscale/direct) → a NAMED not-ok, NEVER a silent fallback to ssh (AC3)", () => {
    const ts = resolveFleetTransportKind({ setting: "tailscale" }); // available defaults to ssh-only this slice
    expect(ts.ok).toBe(false);
    if (!ts.ok) {
      expect(ts.reason).toContain("tailscale");
      expect(ts.reason).toContain("unavailable");
    }
    // the seam KNOWS the kind (it is a valid member) — it just is not shipped yet;
    // resolution reports that honestly and does not substitute ssh.
    expect((ts as { kind?: string }).kind).not.toBe("ssh");
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

  it("a provider becomes selectable once its slice registers it (the seam is additive)", () => {
    // the tailscale/direct slices land by adding themselves to `available`
    expect(resolveFleetTransportKind({ setting: "tailscale", available: ["ssh", "tailscale"] })).toEqual({
      ok: true,
      kind: "tailscale",
    });
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

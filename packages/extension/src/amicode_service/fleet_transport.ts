// FLEET TRANSPORT (#1260 — the pluggable transport provider seam and its three
// providers). The client↔host data plane rode a single launchd SSH `-L` forward,
// deferred by #792 ("the tunnel remains the transport under the relay"). This
// module makes the transport a PLUGGABLE PROVIDER behind one config knob
// (`amicode.fleetTransport`), decoupled from the app.
//
// The Data Contract (issue #1260 / ADR 0024):
//   resolveBaseUrl() → URL   — the hub proxy consumes it (targets whatever URL
//                              it is given, so the app needs no transport code);
//   health()        → status — posture consumes it (an active liveness probe);
//   start()/stop()           — lifecycle (no provider owns an extension-side one
//                              in this build — all three are honest no-ops).
//
// Providers, all shipped: `ssh` (default — the launchd forward refactored behind
// the seam, systemd as its Linux form), `tailscale` (opt-in — the host's
// `tailscale serve` fronting loopback + MagicDNS resolution), and `direct` (a
// supplied URL for a host already reachable on a VPN/LAN, health probe, no tunnel
// lifecycle). SSH is the only required provider and the zero-dependency floor;
// tailscale/direct are additive and independently disableable.
//
// Invariants (ADR 0024): loopback-only bind preserved (every provider proxies to
// a host that binds 127.0.0.1 behind its own edge); never-fork (the transport
// yields a data-plane connection, never an engine); no silent cross-provider
// fallback (a down/disabled transport is an honest hub-down posture, never a
// reroute to another provider).

import type { DataPlaneOutcome } from "./fleet_posture";

/** The transport provider kinds — all three IMPLEMENTED (ssh, tailscale, direct). */
export type FleetTransportKind = "ssh" | "tailscale" | "direct";

/** The known seam members — every kind the vocabulary names, whether or not
 *  this build ships a provider for it (an unknown value is neither). */
const KNOWN_KINDS: readonly FleetTransportKind[] = ["ssh", "tailscale", "direct"];

/** The providers this build registers. All three named seam members ship now:
 *  `ssh` (the seam+walking-skeleton slice), `tailscale` (its own slice), and
 *  `direct` (the final slice, #1260). The seam stays additive — a build may
 *  register a subset (via the `available` arg), and a KNOWN-but-unregistered
 *  member then resolves to a NAMED unavailable-in-this-build not-ok, never a
 *  silent fallback. */
const DEFAULT_AVAILABLE: readonly FleetTransportKind[] = ["ssh", "tailscale", "direct"];

/** The resolution of the `amicode.fleetTransport` setting to a provider kind.
 *  A registered + enabled provider is selected; a disabled one, an
 *  unregistered (not-yet-shipped) member, or an unknown value is a NAMED
 *  not-ok outcome — NEVER a silent fallback to a different provider. */
export type FleetTransportSelection =
  | { ok: true; kind: FleetTransportKind }
  | { ok: false; reason: string };

/** Resolve the configured transport kind. Default (unset/empty/whitespace/null)
 *  → `ssh` (so unset reproduces today's behavior — AC1). A known-but-unshipped
 *  or explicitly-disabled provider, or an unknown value, is a NAMED not-ok
 *  outcome; resolution NEVER substitutes a different provider (AC3, the
 *  no-cross-provider-fallback law). */
export function resolveFleetTransportKind(opts: {
  setting?: string | null;
  /** The providers this build registers (default: ssh only). */
  available?: readonly FleetTransportKind[];
  /** Independently disabled providers (the disableable knob). */
  disabled?: readonly FleetTransportKind[];
}): FleetTransportSelection {
  const available = opts.available ?? DEFAULT_AVAILABLE;
  const disabled = opts.disabled ?? [];
  const raw = (opts.setting ?? "").trim().toLowerCase();
  const kind = (raw === "" ? "ssh" : raw) as FleetTransportKind;
  if (!KNOWN_KINDS.includes(kind)) {
    return { ok: false, reason: `unknown-transport: '${raw}' is not a known provider (${KNOWN_KINDS.join(", ")})` };
  }
  if (disabled.includes(kind)) {
    return { ok: false, reason: `${kind}-disabled: the transport is turned off — no fallback to another provider (honest hub-down)` };
  }
  if (!available.includes(kind)) {
    return {
      ok: false,
      reason: `${kind}-unavailable-in-this-build: the '${kind}' provider is a named seam member but its slice has not shipped — no fallback to another provider`,
    };
  }
  return { ok: true, kind };
}

/** The health of a transport, as an ACTIVE probe result. `reachable` carries
 *  the measured latency (the drop-vs-slow input) + the host's build version
 *  where it reports one; `unreachable` names why. This is `health() → status`.
 *  Reachable means the host ANSWERED (any HTTP status — a 5xx is still an
 *  answer, per the fleet_posture DataPlaneOutcome contract); unreachable means
 *  no answer (a network error, a client-enforced timeout, or no URL bound). */
export type FleetTransportHealth =
  | { reachable: true; latencyMs: number; version: string | null }
  | { reachable: false; reason: string };

/** The transport provider seam. `resolveBaseUrl()` returns undefined for the
 *  honest "no base URL bound" state (a down/disabled transport) — the hub proxy
 *  then answers its own named 503 and the posture detector counts a no-response.
 *  It NEVER returns another provider's URL (the no-cross-provider-fallback law). */
export interface FleetTransportProvider {
  readonly kind: FleetTransportKind;
  resolveBaseUrl(): URL | undefined;
  health(): Promise<FleetTransportHealth>;
  /** Lifecycle (Data Contract). No provider in THIS build owns an
   *  extension-side tunnel lifecycle: `ssh` defers to the OS service manager
   *  (launchd/systemd, installed by the fleet installer), `tailscale` to the
   *  host-side `tailscale serve` + the system daemon, and `direct` to the
   *  operator (reachability arranged out-of-band). So all three are honest
   *  no-ops — the seam exists so a FUTURE provider that DOES own a lifecycle
   *  implements them behind the SAME interface. */
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Options for the `ssh` provider. */
export interface SshProviderOptions {
  /** The loopback base URL the launchd/systemd `-L` forward binds locally,
   *  read LATE (per call) so a de-armed forward yields undefined — the honest
   *  hub-down, never a stale boot-time snapshot. */
  resolveUrl: () => string | undefined;
  /** The active health probe's fetch (injectable; default the global fetch). */
  fetch?: typeof fetch;
  /** The transport-liveness endpoint the probe hits (default /global/health —
   *  the same endpoint the merged projection reads the hub build version from). */
  healthPath?: string;
  /** An Authorization header for the probe, when the host requires one. */
  authHeader?: string;
  /** The client-enforced probe timeout (ms) — the probe always resolves or
   *  times out (it observes an outcome, it never wedges). Default 1500 (the
   *  checkFleet poll's timeout). */
  timeoutMs?: number;
  /** Injectable clock for the latency measurement (prod = Date.now). */
  now?: () => number;
}

/** The shared active health probe BOTH providers use — an HTTP GET to the
 *  transport's own health endpoint under a client-enforced timeout. `reachable`
 *  = the host ANSWERED (any HTTP status — a 5xx is still an answer, per the
 *  fleet_posture DataPlaneOutcome contract); `unreachable` = no answer (a
 *  network error, a client-enforced timeout, or no base URL bound). The
 *  `noBaseUrlReason` differs per provider (which base URL is absent), so the
 *  caller supplies it. This is the ONE probe — never a per-provider detector. */
async function probeTransportHealth(
  resolveBaseUrl: () => URL | undefined,
  opts: {
    fetch: typeof fetch;
    healthPath: string;
    timeoutMs: number;
    now: () => number;
    noBaseUrlReason: string;
    authHeader?: string;
  },
): Promise<FleetTransportHealth> {
  const base = resolveBaseUrl();
  if (base === undefined) return { reachable: false, reason: opts.noBaseUrlReason };
  const target = new URL(opts.healthPath, base);
  const started = opts.now();
  try {
    const res = await opts.fetch(target.toString(), {
      signal: AbortSignal.timeout(opts.timeoutMs),
      ...(opts.authHeader !== undefined ? { headers: { Authorization: opts.authHeader } } : {}),
    });
    const latencyMs = opts.now() - started;
    // Reachable = the host ANSWERED (any status); parse the build version
    // best-effort from a JSON body (never throw on a non-JSON answer).
    let version: string | null = null;
    try {
      const body = (await res.json()) as { version?: unknown };
      if (typeof body.version === "string") version = body.version;
    } catch {
      /* a non-JSON answer is still an answer — version stays null */
    }
    return { reachable: true, latencyMs, version };
  } catch (e) {
    return { reachable: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** The `ssh` provider — the current launchd `-L` forward (systemd as its Linux
 *  form) behind the seam. Its base URL is the loopback endpoint the forward
 *  binds; the far end is reached through the OS-managed SSH tunnel. */
export function createSshProvider(opts: SshProviderOptions): FleetTransportProvider {
  const doFetch = opts.fetch ?? fetch;
  const healthPath = opts.healthPath ?? "/global/health";
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  const resolveBaseUrl = (): URL | undefined => {
    const raw = opts.resolveUrl();
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return new URL(raw);
    } catch {
      return undefined;
    }
  };
  return {
    kind: "ssh",
    resolveBaseUrl,
    async health(): Promise<FleetTransportHealth> {
      return probeTransportHealth(resolveBaseUrl, {
        fetch: doFetch,
        healthPath,
        timeoutMs,
        now,
        noBaseUrlReason: "no-base-url: no loopback forward bound (honest hub-down)",
        ...(opts.authHeader !== undefined ? { authHeader: opts.authHeader } : {}),
      });
    },
    // The launchd/systemd `-L` forward is OS-managed (installed by the fleet
    // installer) in this build — the ssh provider does not own its lifecycle,
    // so start()/stop() are honest no-ops. The tailscale (host-side `serve` +
    // system daemon) and direct (operator-arranged reachability) providers are
    // no-ops for their own honest reasons; the seam exists so a FUTURE provider
    // that DOES own a lifecycle implements them behind the SAME interface.
    async start(): Promise<void> {
      /* OS-managed (launchd/systemd) — nothing to start from the extension */
    },
    async stop(): Promise<void> {
      /* OS-managed (launchd/systemd) — nothing to stop from the extension */
    },
  };
}


/** Options for the `tailscale` provider. Mirrors SshProviderOptions, with the
 *  MagicDNS resolution in place of the loopback-forward resolution. */
export interface TailscaleProviderOptions {
  /** Resolve the host's MagicDNS origin (e.g. https://host.tailnet.ts.net that
   *  the host's `tailscale serve` fronts), read LATE (per call) so a torn-down
   *  serve or a logged-out tailnet yields undefined — the honest hub-down,
   *  never a stale boot-time snapshot, and NEVER another provider's URL (the
   *  no-cross-provider-fallback law). Injectable because `tailscale` is not
   *  available in CI: the tests drive this seam, not the `tailscale` binary. */
  resolveMagicDnsOrigin: () => string | undefined;
  /** The active health probe's fetch (injectable; default the global fetch). */
  fetch?: typeof fetch;
  /** The transport-liveness endpoint the probe hits (default /global/health —
   *  the same endpoint the ssh provider probes and the merged projection reads
   *  the hub build version from). */
  healthPath?: string;
  /** An Authorization header for the probe, when the host requires one. */
  authHeader?: string;
  /** The client-enforced probe timeout (ms). Default 1500 (checkFleet's poll). */
  timeoutMs?: number;
  /** Injectable clock for the latency measurement (prod = Date.now). */
  now?: () => number;
}

/** The `tailscale` provider (#1260) — the host runs `tailscale serve` fronting
 *  its LOOPBACK service; the client points the hub proxy at the host's MagicDNS
 *  origin. `resolveBaseUrl()` is that origin (read LATE); `health()` probes it.
 *
 *  Loopback-bind preservation (ADR 0024, the load-bearing reason `serve` is the
 *  chosen integration): `tailscale serve` dials 127.0.0.1 on the host, so the
 *  host's engine/service bind hostname stays loopback and the mutation guard
 *  never trips — see tailscaleServeMapping, whose target is loopback by
 *  construction. Binding the engine to the tailnet 100.x directly (rejected)
 *  would trip that guard; this provider deliberately does not do that.
 *
 *  Lifecycle: `tailscale serve` is host-side (installer-provisioned) and
 *  tailscaled is a system daemon, so the CLIENT provider's start()/stop() are
 *  honest no-ops — the same OS-managed posture as the ssh provider. */
export function createTailscaleProvider(opts: TailscaleProviderOptions): FleetTransportProvider {
  const doFetch = opts.fetch ?? fetch;
  const healthPath = opts.healthPath ?? "/global/health";
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  const resolveBaseUrl = (): URL | undefined => {
    const raw = opts.resolveMagicDnsOrigin();
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return new URL(raw);
    } catch {
      return undefined;
    }
  };
  return {
    kind: "tailscale",
    resolveBaseUrl,
    async health(): Promise<FleetTransportHealth> {
      return probeTransportHealth(resolveBaseUrl, {
        fetch: doFetch,
        healthPath,
        timeoutMs,
        now,
        noBaseUrlReason: "no-base-url: no MagicDNS origin resolved (honest hub-down)",
        ...(opts.authHeader !== undefined ? { authHeader: opts.authHeader } : {}),
      });
    },
    // `tailscale serve` is host-side (installer-provisioned) and tailscaled is a
    // system daemon — neither is the client provider's to start/stop, so these
    // are honest no-ops (the same OS-managed posture the ssh provider takes).
    async start(): Promise<void> {
      /* host-side `tailscale serve` + system daemon — nothing to start here */
    },
    async stop(): Promise<void> {
      /* host-side `tailscale serve` + system daemon — nothing to stop here */
    },
  };
}


/** Options for the `direct` provider. Mirrors SshProviderOptions, with the
 *  operator-supplied URL in place of the loopback-forward resolution. */
export interface DirectProviderOptions {
  /** Resolve the operator-supplied URL of a host already reachable on a
   *  VPN/LAN — the operator arranges reachability OUT-OF-BAND. Read LATE (per
   *  call) so a cleared/unset URL yields undefined — the honest hub-down,
   *  never a stale boot-time snapshot, and NEVER another provider's URL (the
   *  no-cross-provider-fallback law). */
  resolveUrl: () => string | undefined;
  /** The active health probe's fetch (injectable; default the global fetch). */
  fetch?: typeof fetch;
  /** The transport-liveness endpoint the probe hits (default /global/health —
   *  the same endpoint the ssh/tailscale providers probe and the merged
   *  projection reads the hub build version from). */
  healthPath?: string;
  /** An Authorization header for the probe, when the host requires one. */
  authHeader?: string;
  /** The client-enforced probe timeout (ms). Default 1500 (checkFleet's poll). */
  timeoutMs?: number;
  /** Injectable clock for the latency measurement (prod = Date.now). */
  now?: () => number;
}

/** The `direct` provider (#1260, the FINAL provider) — for a host already
 *  reachable on a VPN/LAN, where the OPERATOR arranges reachability out-of-band.
 *  It is just the supplied URL plus a health probe: `resolveBaseUrl()` is that
 *  URL (read LATE); `health()` probes it (the ONE shared probe, reused).
 *
 *  No tunnel-manager lifecycle: unlike ssh (an OS-managed launchd/systemd `-L`
 *  forward) and tailscale (host-side `tailscale serve` + a system daemon),
 *  `direct` manages NOTHING — the reachability is arranged out-of-band — so
 *  start()/stop() are honest no-ops (the same OS/operator-managed posture the
 *  ssh and tailscale providers already take, for a third honest reason).
 *
 *  Loopback-bind preservation (ADR 0024): the supplied URL points at the host's
 *  OWN EDGE, which itself binds 127.0.0.1 behind it — this provider authorizes
 *  no non-loopback engine bind and touches no host bind at all (it is purely
 *  client-side: a URL + a probe). The `100.x`/public-bind case (rejected) is
 *  deliberately not a path this provider can take. */
export function createDirectProvider(opts: DirectProviderOptions): FleetTransportProvider {
  const doFetch = opts.fetch ?? fetch;
  const healthPath = opts.healthPath ?? "/global/health";
  const timeoutMs = opts.timeoutMs ?? 1500;
  const now = opts.now ?? (() => Date.now());
  const resolveBaseUrl = (): URL | undefined => {
    const raw = opts.resolveUrl();
    if (raw === undefined || raw.trim() === "") return undefined;
    try {
      return new URL(raw);
    } catch {
      return undefined;
    }
  };
  return {
    kind: "direct",
    resolveBaseUrl,
    async health(): Promise<FleetTransportHealth> {
      return probeTransportHealth(resolveBaseUrl, {
        fetch: doFetch,
        healthPath,
        timeoutMs,
        now,
        noBaseUrlReason: "no-base-url: no direct URL supplied (honest hub-down)",
        ...(opts.authHeader !== undefined ? { authHeader: opts.authHeader } : {}),
      });
    },
    // `direct` owns NO tunnel-manager lifecycle — the operator arranges
    // reachability out-of-band (a VPN/LAN the host is already on), so there is
    // nothing for the client provider to start or stop. Honest no-ops.
    async start(): Promise<void> {
      /* no tunnel-manager lifecycle — the operator arranges reachability out-of-band */
    },
    async stop(): Promise<void> {
      /* no tunnel-manager lifecycle — the operator arranges reachability out-of-band */
    },
  };
}


/** Construct the transport provider for a resolved selection (the wiring's
 *  kind→provider map). Each OK kind gets ITS OWN provider — NEVER another
 *  kind's (the no-cross-provider-fallback law, AC3) — so the per-provider
 *  posture signature and lifecycle stay honest. A not-ok selection (disabled, a
 *  not-yet-shipped member, or unknown) binds NO base URL: the honest hub-down,
 *  never the configured URL wrapped in a substitute provider. `resolveUrl` is
 *  the transport-appropriate base-URL source read LATE — for ssh the loopback
 *  forward URL, for tailscale the host's MagicDNS origin. */
export function transportForSelection(
  sel: FleetTransportSelection,
  resolveUrl: () => string | undefined,
): FleetTransportProvider {
  if (!sel.ok) return createSshProvider({ resolveUrl: () => undefined }); // no URL bound = honest hub-down
  switch (sel.kind) {
    case "tailscale":
      return createTailscaleProvider({ resolveMagicDnsOrigin: resolveUrl });
    case "direct":
      return createDirectProvider({ resolveUrl });
    case "ssh":
      return createSshProvider({ resolveUrl });
    default:
      // Every shipped kind (ssh/tailscale/direct) has an explicit case above, so
      // this is only reached by an unexpected ok kind — keep the no-fallback law
      // explicit rather than silently substituting ssh for it.
      return createSshProvider({ resolveUrl: () => undefined });
  }
}

// ── the shared drop-vs-slow-link posture contract (this slice OWNS it) ────────
// A provider's health() maps to the fleet_posture DataPlaneOutcome stream
// through ONE mapping, so every provider (ssh + tailscale now; direct later) feeds
// the SAME FleetPostureDetector — never a per-provider detector fork. The
// detector's own hysteresis then does the drop-vs-slow discrimination:
//   reachable   → `responded` (its p95 latency window decides hub-up-but-slow
//                 → degraded — a usable, honest steady state);
//   unreachable → `no-response` (its consecutive-no-response streak decides
//                 sustained → hub-down — base standalone + a surfaced pointer).
// The provider `kind` rides the no-response detail so a Tailscale roam and an
// SSH drop are told apart in the posture reason (ADR 0024's per-provider dimension).
export function transportHealthToOutcome(
  health: FleetTransportHealth,
  kind?: FleetTransportKind,
): DataPlaneOutcome {
  if (health.reachable) {
    return { kind: "responded", latencyMs: health.latencyMs };
  }
  const who = kind !== undefined ? `${kind}: ` : "";
  return { kind: "no-response", detail: `${who}${health.reason}` };
}

/** Adapt a provider's `resolveBaseUrl(): URL | undefined` back to the hub
 *  proxy's existing `getUrl(): string | undefined` seam, BYTE-IDENTICALLY to
 *  the configured value: a bare origin round-trips without a spurious trailing
 *  slash (the hub proxy resolves absolute request paths against the base either
 *  way, so this is about no-regression equality, not routing). undefined stays
 *  undefined — the existing honest-down signal. */
export function hubUrlStringFromProvider(provider: FleetTransportProvider): string | undefined {
  const u = provider.resolveBaseUrl();
  if (u === undefined) return undefined;
  const s = u.toString();
  // trim ONLY the root path's trailing slash ("http://h:9/" → "http://h:9");
  // a real path ("http://h:9/base") is preserved.
  return u.pathname === "/" && u.search === "" && u.hash === "" ? s.replace(/\/$/, "") : s;
}

// ── the ssh provider's OS forms — one forward, two service managers ──────────
// The launchd plist (tools/fleet/co.harmoniqs.amico-tunnel.plist) is the ssh
// provider's macOS form; the systemd user unit below is its Linux form (ADR 0024:
// "a systemd unit is the Linux implementation of the same provider"). Both run
// the SAME hardened `ssh -N ... -L 127.0.0.1:PORT:127.0.0.1:PORT <alias>` forward.

/** The hardened ssh `-L` forward argv — byte-for-byte the plist's
 *  ProgramArguments (minus the leading `/usr/bin/ssh`): loopback→loopback only,
 *  ExitOnForwardFailure + ServerAlive 15/2 + TCPKeepAlive, alias last. The port
 *  binds 127.0.0.1 on BOTH ends — never 0.0.0.0, never a tailnet 100.x address,
 *  so the loopback bind-guard (ADR 0002/0005) stays honest. */
export function sshForwardArgs(opts: { alias: string; port: number }): string[] {
  return [
    "-N",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=2",
    "-o", "TCPKeepAlive=yes",
    "-L", `127.0.0.1:${opts.port}:127.0.0.1:${opts.port}`,
    opts.alias,
  ];
}

/** The systemd USER unit for the ssh forward — the Linux form of the launchd
 *  plist. `KeepAlive`+`ThrottleInterval` (plist) map to `Restart=always`+
 *  `RestartSec` (systemd); the forward is `sshForwardArgs` verbatim. Install as
 *  `~/.config/systemd/user/amico-tunnel.service` and `systemctl --user enable
 *  --now` it (the client-only concern the fleet installer wires per platform). */
export function systemdTunnelUnit(opts: { alias: string; port: number }): string {
  const execArgs = ["/usr/bin/ssh", ...sshForwardArgs(opts)].join(" ");
  return [
    "[Unit]",
    "Description=Amico fleet tunnel (loopback SSH -L forward to the canonical hub)",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execArgs}`,
    "Restart=always",
    "RestartSec=10",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

// ── the tailscale provider's host form — `tailscale serve` fronts loopback ────
// The ssh provider's OS form is a loopback `-L` forward (sshForwardArgs); the
// tailscale provider's host form is `tailscale serve` fronting a LOOPBACK
// target. This is the load-bearing reason `serve` is the chosen Tailscale
// integration (ADR 0024): tailscaled publishes the node's HTTPS MagicDNS name,
// but the target it proxies to is 127.0.0.1 — so the host's engine/service keeps
// binding loopback and the mutation guard (bind_host/solver_mode) never trips.
// Binding the engine to the tailnet 100.x directly (rejected) would trip it.

/** The `tailscale serve` mapping — the public MagicDNS origin the client points
 *  its hub proxy at, and the LOOPBACK target `serve` proxies to on the host.
 *  `args` is the host-side `tailscale serve` argv (the fleet installer
 *  provisions it — the client provider never runs it), analogous to
 *  sshForwardArgs. The target binds 127.0.0.1 by construction (never 0.0.0.0,
 *  never a tailnet 100.x), which is what keeps the host's loopback bind honest. */
export function tailscaleServeMapping(opts: {
  magicDnsName: string;
  port: number;
  /** The tailnet-facing HTTPS port `serve` publishes on (default 443 → the
   *  MagicDNS origin carries no explicit port). */
  tailnetPort?: number;
}): { magicDnsOrigin: string; target: string; args: string[] } {
  const tailnetPort = opts.tailnetPort ?? 443;
  const magicDnsOrigin =
    tailnetPort === 443 ? `https://${opts.magicDnsName}` : `https://${opts.magicDnsName}:${tailnetPort}`;
  const target = `http://127.0.0.1:${opts.port}`; // LOOPBACK — never 0.0.0.0, never a tailnet 100.x
  // `tailscale serve --bg <target>` publishes <target> on the node's MagicDNS
  // HTTPS name, in the background (persistent). --https=<port> when non-default.
  const args =
    tailnetPort === 443
      ? ["serve", "--bg", target]
      : ["serve", "--bg", `--https=${tailnetPort}`, target];
  return { magicDnsOrigin, target, args };
}

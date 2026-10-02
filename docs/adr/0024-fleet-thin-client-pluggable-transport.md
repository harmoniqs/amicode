# ADR 0024 — Pluggable transport under the thin-client fleet

- **Status:** proposed
- **Date:** 2026-09-18
- **Context refs:** ADR 0005 (managed fleet — this extends it), ADR 0002 (server-route
  seam, per-boot password, loopback graft), ADR 0020 (standalone server survives reload),
  ADR 0023 (base-tier projection), #792 (PRD: Fleet thin client — local shell, remote data),
  and the interface/server decoupling (the engine / `amicode_service` / iframe three-actor
  split, #451/#822/#391/#955). Robustness incidents: #775 (hub wedges under direct fleet
  reconnect), #777 (first-attach probe impossible at high RTT).

## Context

The interface/server decoupling split the app into three actors: a loopback engine (stock
`opencode serve`, bound `127.0.0.1` by construction), an `amicode_service` that serves the
UI shelf and owns the `/amicode/*` routes and reverse-proxies everything else, and a chat
iframe that frames the *service* origin. The service already runs headless on a host
(`bootAmicodeServiceRunner`) and its `HubProxy` targets an arbitrary upstream URL — the
machinery for a thin client exists.

**#792 owns the thin-client split** ("local shell, remote data") and this ADR does not
restate it. But #792 explicitly **defers the transport**: *"the tunnel remains the transport
under the relay."* It moves the UI local and leaves the single launchd SSH `-L` forward
underneath, unquestioned. That tunnel is the shared cause of two filed incidents:

- **#777** — on a ~750 ms-RTT link every request takes ~2.5 s against a 1.5 s attach budget,
  so a healthy hub is *unattachable*. Everything rides one high-latency tunnel.
- **#775** — the hub wedges under *direct* fleet reconnect; a front-door proxy is the
  deployed mitigation, root cause open. Reconnection pattern, not request volume, is the
  trigger.

The transport also has structural weaknesses independent of those incidents: SSH `-L` wraps
the inner HTTP/TCP flow in a second TCP stream (TCP-over-TCP collapse under loss); a network
roam kills the tunnel and drops every stream; and the launchd agent is macOS-specific
(a Linux host needs systemd — already flagged in ADR 0005's accepted costs).

Two invariants constrain any transport. **Loopback-only binding** (ADR 0002/0005): the host
binds `127.0.0.1`, and credential/solver **mutation** routes fail closed on any non-loopback
bind — the guard is a positive loopback allowlist (`localhost`/`::1`/`127.0.0.0/8`/`::ffff:127.*`),
so a Tailscale `100.x` address trips it. **Never-fork** (ADR 0005): a client holds no engine
and no store.

## Decision

Make the client↔host transport a **pluggable provider behind one config knob**
(`amicode.fleetTransport`), decoupled from the app. A provider yields a base URL + health +
lifecycle; the `HubProxy` already targets whatever URL it is given, so the app needs no
transport-specific code.

Ship three providers:

1. **`ssh` (default).** The current launchd `-L` forward, refactored behind the provider
   seam; a systemd unit is the Linux implementation of the same provider. Zero new
   dependency, works anywhere SSH + keys do. **This is the floor and the only required
   provider.**
2. **`tailscale` (opt-in).** The host runs `tailscale serve` fronting its **loopback**
   service; the client points the `HubProxy` at the MagicDNS origin. WireGuard gives roaming
   (connection migration), NAT traversal (DERP relay fallback), and low latency over UDP —
   no TCP-over-TCP collapse. Because the app still binds `127.0.0.1` and Tailscale's on-host
   proxy is the only thing that dials it, **the loopback bind-guard is untouched** — this is
   why `serve` is chosen over binding the engine to the tailnet IP directly.
3. **`direct` (a URL).** For a host already reachable on a VPN/LAN — the provider is just the
   URL plus a health probe, no tunnel manager.

**Tailscale is never mandatory.** SSH is the default; Tailscale is a recommended upgrade for
the roaming-laptop case, chosen per-machine. This is the honest answer to "do all users have
to run Tailscale" — no.

The transport carries the full data plane to the host — engine routes, the `/amicode/*`
surface (per the confirmed *host-owns-all-state* decision recorded against #792), the event
stream, and WebSocket upgrades (the terminal). Those routing changes belong to #792; this
ADR governs only the pipe they travel through.

## Invariants held

1. **Loopback-only bind + mutation refusal unchanged (ADR 0002/0005).** The host binds
   `127.0.0.1`; every provider proxies *to* loopback (`ssh -L` onto localhost, `tailscale
   serve` onto localhost, `direct` onto a host that itself binds loopback behind its own
   edge). The `100.x` case that would trip the guard is deliberately not the shipped path.
2. **Never-fork (ADR 0005).** The transport gives the client a data-plane connection, never
   an engine — the client still holds no store.
3. **One topology reader (ADR 0023).** The provider is new machinery *under* the installer;
   the projection/guard/installer contract and `assert_fleet_guard.sh` are unchanged.
4. **Standalone untouched.** The escape hatch and the local-files workflow both remain; the
   transport seam engages only for a fleet client.

## Consequences

- The launchd tunnel stops being *the* transport and becomes the `ssh` provider's macOS
  implementation; the per-platform installer story (launchd / systemd / Tailscale) becomes a
  provider matrix rather than a special case.
- The provider seam realizes ADR 0005's aspirational "extension-owned Managed Tunnel" and its
  "Fleet token" (the hub token, `~/.amico/fleet-hub.json`) without the launchd duct tape.
- #777's attach-budget fix and #775's front-door mitigation compose with, but are not
  replaced by, this work — a better transport narrows the failure envelope both incidents
  live in; it does not close either issue.
- Posture/hysteresis detectors (`fleet_posture.ts`, `fleet_poll_hysteresis.ts`) gain a
  per-provider dimension (a Tailscale roam and an SSH drop have different signatures).
- **SSE reconnect is lossless only on the per-session stream (#1264, Slice 4).** The
  transport carries the event stream, and a blip on it drops every event in the gap unless
  the stream is resumable. Only the engine's per-session route
  `/api/session/{id}/event?after=<seq>` is: it replays durable events after an aggregate
  `seq`. The relay therefore tracks that `seq` **per session** and resumes via `?after=` on
  reconnect, deduping the boundary (client-side, in `session_event_resume.ts` — no engine
  change). The multiplexed `/event` (per-instance) and `/global/event` streams are
  **deliberately out of scope**: they emit `id: undefined` (no cursor form) and
  `/global/event` rides an in-memory `GlobalBus` with nothing to replay, so they are proxied
  **as-is** (never given an `?after=`, never assumed resumable). Making them resumable is
  separate engine work — emit SSE ids + a durable/vector-cursor live stream — coordinated
  with the `GlobalBus` subscriber-lifecycle root cause (#775), not forked from it.

## Flip conditions

- If opencode upstream gains native remote-attach with identity + auth, adopt it and retire
  the provider seam (inherits ADR 0005's flip condition).
- If `tailscale serve` latency or its dependency proves worse in practice than a hardened SSH
  path, keep `ssh` as default and mark `tailscale` experimental rather than recommended.

## Accepted costs

- Three providers to maintain — mitigated: `ssh` is the only required one; `tailscale` and
  `direct` are additive and independently disableable.
- `tailscale serve` adds an optional third-party dependency for the machines that opt in.

## Considered

- **Bind the engine directly to the tailnet IP (`100.x`)** — rejected as the default: trips
  the loopback mutation guard (ADR 0002), forcing a security-invariant loosening. Available
  as a documented power-user path, never the shipped model.
- **Keep the single SSH `-L` tunnel (status quo, #792's deferral)** — rejected: TCP-over-TCP
  collapse, roam-fragile, macOS-specific, and the shared cause of #775/#777.
- **Mandate Tailscale for all fleet users** — rejected: forces a dependency on everyone incl.
  non-mac; the pluggable seam delivers the robustness option without the mandate.
- **A cloud relay / rendezvous** — rejected for now: adds a hop and a hosted dependency the
  SSH and Tailscale paths do not need; revisit only if inbound-NAT hosts become common.

# ADR 0024 — The durable hub: reboot survival and roaming remote attach

- **Status:** proposed
- **Date:** 2026-09-18
- **Context refs:** ADR 0005 (managed fleet / Canonical Server), ADR 0002
  (server-route seam / per-boot password), ADR 0020 (standalone server survives
  an editor reload), ADR 0023 (base-tier fleet projection), the fleet
  rearchitect (PR #1257), the JJ two-machine fleet (`jjs-mac-studio` hub,
  `jjs-macbook-pro` roaming client).
- **Branch:** `feature/free-tier-fleet` (fleet-dev integration base).

## Context — what we already have, and the one gap

The Mac Studio's chat server on `:4096` already survives an editor window
closing. ADR 0020 landed (issue #1142): the standalone server is spawned
**detached** (`detached: true` + `unref`), reparents to `launchd` when the
extension host tears down, and `deactivate()` no longer kills it — a
re-activating window **adopts** the live process via the `0600` handshake at
`~/.amico/ops/server/standalone.json` (`server_daemonize.ts`,
`server_keepalive.ts`, `server_handshake.ts`, `rebuild/atomic_adoption.ts`).

Two facts refine the scope of what remains:

1. **The grace-window reaper is not wired.** ADR 0020's design has a detached
   server self-exit after a 30 s grace window (no keepalive ping + zero
   in-flight turns). The engine-side `/keepalive` self-exit route (#1147) is
   **not in the overlay**; `server_keepalive.ts` says so in its own comment, and
   `pingKeepalive` treats a 404 as "alive". Net effect today: the detached
   server survives *all* windows closing and runs until an explicit **Stop**, an
   engine **Restart**, or a **reboot**.
2. **ADR 0020 drew its own boundary.** Its Flip condition states that "survive a
   full OS reboot / no editor ever open" is out of scope for standalone mode and
   is *"the fleet `server` mode's job"* — the Canonical Server of ADR 0005.

So the durable hub is **not** about window-close survival (done). It is exactly
the two things ADR 0020 deferred to fleet `server` mode:

- **Reboot survival / always-on** — a service that is up after boot with no
  editor ever opened, not a detached child that dies on reboot.
- **Roaming remote attach** — today's survivor binds loopback and is armed with
  the at-rest per-boot password (ADR 0002 / ADR 0020), so `jjs-macbook-pro`
  cannot attach to it (the observed `401`).

## Decision

Stand up the durable hub as the fleet `server`-mode Canonical Server on
`jjs-mac-studio`, in **two independently-shippable slices**, with the auth model
fixed as **anonymous-on-loopback reached over a Tailscale tunnel** — not a
Tailscale-IP bind with a shared token.

### Slice 1 — reboot survival (the always-on service)

Promote the hub to a `launchd` service (`RunAtLoad` + `KeepAlive`) so it is up
after boot with no editor open. A wrapper script reproduces the environment the
extension spawns the server with: the canonical DB pin (`OPENCODE_DB`, one DB /
one writer — the corruption rule of ADR 0005), `OPENCODE_CONFIG_CONTENT` (staged
skills, instructions, MCP, permissions), bound to `127.0.0.1`. This replaces the
retired `co.harmoniqs.amico-server` agent removed in Phase 0. No auth change:
the Studio editor keeps working exactly as it does today. Independently valuable
and low-risk — it is the highest-value first step and touches no security
surface.

### Slice 2 — roaming remote attach

Flip the hub to **anonymous-accept on loopback**, stand up the **client-only**
tunnel on `jjs-macbook-pro` (the tunnel `install.sh` was narrowed to client-only
in PR #1257), and make the **Studio's own editor attach** to the hub rather than
spawn its own password-armed server — as a base-tier `client` via the role
ADR 0023 added.

The genuinely new surface lives here and is named honestly: the extension
**always mints a password** today (`server_auth.ts` `mintServerPassword`) and
`ServerManager.start()` **always spawns, never attaches** (`server_manager.ts`).
Slice 2 needs (a) an anonymous-accept-on-loopback spawn path for the service and
(b) an attach-not-spawn path for the Studio editor keyed on the base-tier
`client`/`server` role. The never-fork invariant (ADR 0005) is preserved: a
`client` still never spawns a local server.

## Why this shape

- **The agent-driving server never leaves loopback.** The hub runs agent turns
  and shells commands; binding it to the Studio's Tailscale IP would expose that
  to every tailnet node, guarded only by a long-lived shared token to store and
  rotate. Keeping it on `127.0.0.1` makes the **tunnel + the tailnet ACL** the
  perimeter, with no credential to manage. This is the pattern the fleet's
  headless server (erlich) already proves under ADR 0005.
- **Tailscale carries arbitrary ports cleanly** (verified on `:5599`); the
  `:22`/Tailscale-SSH userspace quirk that bit us earlier does not apply to a
  forwarded server port.
- **The client-only tunnel is already the merged direction** (PR #1257 narrowed
  the managed tunnel to clients — a hub is the tunnel *destination*).

## Accepted costs / caveats

- **Anonymous-on-loopback** means any process running as the Studio user can
  drive the hub with no auth — the same trust model as erlich and any local dev
  server, acceptable on a single-user machine. If that stops being true we add a
  token then (the shared-credential option is the documented fallback).
- **Two spawn paths coexist** on the Studio (the launchd service vs. the
  extension's historical spawn). Slice 2's attach-not-spawn path must make the
  editor defer to the service; until Slice 2 lands, the editor keeps spawning
  and the MacBook cannot attach.
- **One-parser / never-fork invariants unchanged** — consumers still read only
  `projection.json`; a `client` never forks a server.

## Alternatives considered

- **Bind the Tailscale IP + shared stable token (Option 2).** Rejected as the
  default: larger attack surface (agent-driving server on the tailnet) and a
  long-lived secret to manage, for no gain when the tunnel works. Retained as
  the documented fallback if loopback-only trust ever breaks.
- **Keep the at-rest password, add launchd only, defer remote attach
  (Option 3).** This is precisely Slice 1 — adopted as the first slice, not as
  the terminal state (it never lets the MacBook attach, which is the point of a
  hub).
- **Promote nothing; rely on ADR 0020's detached survivor.** Rejected: it dies
  on reboot by design and cannot serve a roaming client.

## Flip condition

Revisit the auth model toward the shared-credential bind if the Studio stops
being single-user, or if opencode upstream gains a native adopt-with-identity
capability we would rather adopt than maintain.

## Slices → tracking issues

- Slice 1 — launchd reboot-survival hub service — #1258.
- Slice 2 — anonymous-loopback + client tunnel remote attach + attach-not-spawn —
  #1259 (blocked by #1258).

# ADR 0027 — Peer fleet studios, with compute federation as the declared end-state

- **Status:** proposed
- **Date:** 2026-09-20
- **Context refs:** ADR 0005 (managed fleet — defines `Server mode`, the never-fork guard), ADR 0023
  (base-tier projection — the one-parser invariant), ADR 0024 (pluggable transport), ADR 0025
  (Remote-SSH default / host-owns-all-state), ADR 0026 (generalizable capabilities + host-owned
  roster), ADR 0002 (loopback bind / mutation refusal). Program: #1316/#1323 (fleet setup +
  generalizable roles + Fleet Manager, merged on `feature/free-tier-fleet`).
- **Spec:** `config/specs/spec-20260920-213918-peer-fleet-compute-federation.md` (reviewed:
  tier-1 mechanical `approved-mechanical`; judgment critics run by-hand — see that spec's Review).
- **Supersedes:** nothing. **Additive.** It amends ADR 0025's *single-canonical-hub* premise to
  "one hub **or** many peers," and leaves the hub path (enroll, guard, Remote-SSH) byte-unchanged.

## Context

A fleet today is a **star**. `amico fleet enroll` (#1316/#1323) makes exactly one machine
`role=server` and every other machine a `role=client` whose never-fork guard
(`amico-opencode-fleet-guard`, `exit 1`) forbids it from running an engine — it tunnels to the one
hub and shares the hub's database. ADR 0025 reinforces this (Remote-SSH default, host owns all state).

Two observations reframe the goal:

1. **"Host a server" has two senses.** Running an engine *for yourself* is already universal: no
   `fleet.json` ⇒ `standalone`, and a standalone machine spawns/adopts its own loopback engine.
   Serving *for others* is the designated `role=server`, capped at one, with clients barred from
   serving.
2. **The north star is server-to-server agent spooling** — engines dispatching agents/subagents to
   one another and streaming results back. This is *impossible on one host by definition* (one
   engine, nothing to spool), and the star path provisions the wrong substrate for it (never-fork
   clients that cannot accept a dispatched agent).

The merged branch already built a **topology-agnostic foundation** this ADR reuses: the host-owned,
fleet-wide `roster.json` (`GET/POST /amicode/roster`), the open `capabilities[]` axis
(`compute`/`roaming`; `compute` shipped "declared but inert"), `fleet_discover.ts` (roster +
`~/.ssh/config` + tailnet), the roster-driven `ops/fleet-status.sh`, the Fleet Manager tab, the
`amicode_service` reverse proxy (`shouldProxyAmicodeToHost`, `server.ts:242`), and `fleet_transport.ts`.

## Decision

**Two horizons, one substrate.** Ship **peer studios** (Horizon 1) as an additive mode built on that
foundation, and design its substrate deliberately for **compute federation** (Horizon 2), which this
ADR declares but does not build.

1. **Additive peer topology.** Peers coexist with the hub/star mode; the hub `enroll`, the never-fork
   guard, and ADR 0025 remain for the thin-client→server case. A peer stays `standalone` and
   *advertises*; it never takes the `client` stance, so the guard is never triggered and never relaxed.

2. **Independent studios + a multiplexing `amicode_service`.** Each peer runs its own engine on its
   own DB (single-writer-per-DB preserved *per machine* by the existing adopt-or-spawn gate). The
   loopback service holds N keyed upstreams and re-targets by a **three-way resolver** generalizing
   `shouldProxyAmicodeToHost`: the local honesty surface → local; `/amicode/roster` → the **keeper**
   (§4); every other `/amicode/*` + engine + SSE → the **attached server**. **When the attachment
   pointer is empty (a fresh standalone peer), the studio branch routes to the local engine** — the
   attached branch is never undefined.

3. **Attach/switch is a first-class action.** A **switch-control pointer** (its state and its
   never-proxied local endpoint) is owned in one place; the resolver and the switch consume it.
   **Switching** flips the pointer and **resets the SSE cursor** (a different server is a fresh
   stream, never a `?after=` resume). An **attach/detach action** — an `amico`/service verb *and* a
   Fleet Manager "Attach" control on the existing device rows — adds/removes an upstream and drives
   the pointer, with the roster as the candidate list. (The baseline Fleet Manager reads
   `server.current` but never switches; this is the decision that adds switching.)

4. **Directory keeper, resolvable and decoupled from the hub.** Reuse the host-owned `roster.json`
   and its routes; the "keeper" is a *registry* role, **not** "the only server" — every peer still
   serves and can be attached to. The keeper's coordinate is carried by an explicit **keeper
   bootstrap pointer** (a resolvable address, sibling to the switch pointer), **not** discovered from
   the very `roster.json` the keeper hosts (which would be circular). Peers self-report their row to
   the keeper (single-writer upsert, unchanged).

5. **Serving advertisement = a placement-ready capability.** A peer advertises its already-running
   engine via a roster `serving` tag plus reach coordinates, designed as a **placement descriptor** a
   future scheduler reads (reachable? serving? headroom?), not a display-only chip. It rides the open
   `capabilities[]` axis (ADR 0026); it does **not** change `server_mode` (still the sole serve-stance
   authority) and needs **zero** `fleet.json`/`amicissimo` change.

6. **Per-attachment transport — SSH default, engine-reachable, no forced Tailscale.** Reuse
   `fleet_transport.ts`. Each transport is an authenticated, **engine-reachable channel**
   (bidirectional-capable) so Horizon 2's engine↔engine RPC reuses it. SSH is the universal default;
   `roaming`→tailscale and direct are opt-in. `fleet_discover.ts` already treats `~/.ssh/config` as a
   first-class source, so no one is forced onto a tailnet.

7. **The two recorded federation seams (this ADR is where they are decided):**
   - **Peer-trust credential — a NEW peer token.** Horizon 1 injects the existing UI client mint
     (#822/#1262) per attachment. For Horizon 2, peer-to-peer engine RPC is a *distinct* trust act
     (server A dispatching arbitrary agent compute to server B) and gets its **own** credential: a
     per-peer, separately-mintable and **separately-revocable** *peer token*, keyed by the machine's
     roster `machine_id`. It is deliberately **not** the ADR-0005 Fleet token (which guards SSH
     *enrollment*, a different act) and **not** the UI client mint (which authorizes a human's window,
     not a peer engine). Recording this now means Horizon 2 needs no credential re-plumbing.
   - **Event-relay seam — the multiplexing service's SSE path.** Horizon 1 exercises only the
     cursor-reset-on-switch (§3). For Horizon 2, the relay point is the same service SSE path: a
     remote child's events carry the **originating session id** and are **merged into that session's
     stream** over the per-attachment channel. The named consumer is the Horizon-2 executor's
     result/event path. Recording this now means the stream model does not need re-shaping later.

8. **Horizon 2 is declared, not built.** The compute-federation executor — server-to-server dispatch
   RPC, a placement scheduler (reading the §5 descriptor), artifact/result sync-back, inter-server
   trust made live (the §7 peer token), and event relay/merge (the §7 seam) — is the end-state this
   ADR names and an explicit **non-goal** of the Horizon-1 build. It makes `compute` live behind the
   tag ADR 0026 already ships. **Dispatched work is stateless work owned by the originating session**
   — the executor never grows a shadow session the originator must reconcile, so independent studios
   (§2) stay intact.

## The five substrate seams (Horizon-1 obligations for Horizon 2)

1. **Engine-reachable transport** — §6.
2. **Peer-trust credential** — §7 (the new peer token).
3. **Placement-ready capability descriptor** — §5 (`serving`/`compute`).
4. **Spawn-path placement target** — an optional target on `amicode_session`/Task dispatch, defaulting
   to `local`, so Horizon 2 populates it without re-plumbing the spawn path.
5. **Federatable event stream** — §7 (the SSE relay seam).

## Approaches considered

- **Keep one host (star only)** — rejected: server-to-server spooling is impossible on one engine,
  and the never-fork client is the wrong substrate for it.
- **Replace the star with peers** — rejected: discards the merged `enroll` flow and the thin-client
  case ADR 0025 targets. Additive keeps both.
- **Widen `Server mode` to carry "serving"** — rejected: conflates serve-stance with capability and
  breaks the closed union the guard + `amicissimo` depend on (the same reasoning ADR 0026 used). The
  advertisement is a capability tag, not a new role.
- **Un-pin the webview's native multi-server switcher (client-side N origins)** — rejected for the
  data plane: it bypasses the `amicode_service` `/amicode/*` ownership, credential translation, and
  the single-origin CSP/auth model. The switcher UI is reused as the front-end that drives the pointer.
- **Force Tailscale for multi-peer reach** — rejected: SSH is the universal default; tailscale is
  opt-in via `roaming`.
- **Reuse the ADR-0005 Fleet token (or the UI mint) for peer RPC** — rejected: each conflates a
  distinct trust act; Horizon 2 gets its own revocable peer token (§7).

## Invariants held

1. **One parser of `fleet.json` (ADR 0023).** Everything new is amicode-owned (roster + service
   registry + switch pointer). Zero `amicissimo` changes.
2. **Never-fork + single-writer-per-DB (ADR 0005).** The guard and `enroll` are byte-unchanged; peers
   never take the `client` stance; adopt-or-spawn keeps ≤1 writer per machine's DB. Attaching to a
   peer is a proxy operation that spawns no engine.
3. **Loopback bind + mutation refusal (ADR 0002).** The multiplexer keeps every upstream credentialed
   and loopback-bound; the roster self-report and the switch-control write ride the authenticated
   `/amicode/` plane to a loopback host.
4. **Local honesty surface.** `/amicode/fleet/*` and the switch-control pointer never proxy, so a
   peer's own posture/attachment can never be masked by a keeper's or a peer's.
5. **`Server mode` remains the only serve-stance authority.** The `serving` advertisement is orthogonal
   capability metadata.

## Consequences

- The product's "any capable machine can serve, and I can hop between them" lands as an additive mode;
  the thin-client→hub case and ADR 0025 keep working.
- The merged roster/discovery/status/UI are reused as the directory and front-end; the near-term build
  is a multiplexing service + a switch pointer + an Attach control, not new plumbing.
- The Horizon-2 executor can make `compute` live without re-opening this ADR — the transport, the peer
  token, the placement descriptor, the spawn-path target, and the event-relay seam are all designed for
  it here.

## Non-goals

- The Horizon-2 compute-federation executor itself (dispatch RPC, placement scheduler, artifact
  sync-back, inter-server trust made live, event relay/merge). Named here; specced/built later.
- Making `compute` live (stays "declared but inert").
- Any change to `FleetConfig`/`fleet.json`, the hub `enroll` flow, the never-fork guard, or the
  `amicissimo` contract.
- Replacing the hub/star mode or ADR 0025's Remote-SSH posture.

## Source

- Design-of-record spec: `config/specs/spec-20260920-213918-peer-fleet-compute-federation.md`
  (15 falsifiable acceptance criteria, Horizon-1 slice order with dependency edges).
- Program precedent: #1316/#1323 (merged foundation), ADR 0026 (the capability + roster substrate).

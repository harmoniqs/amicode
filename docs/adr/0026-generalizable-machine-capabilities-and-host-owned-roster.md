# ADR 0026 — Generalizable machine capabilities + a host-owned fleet roster

- **Status:** proposed
- **Date:** 2026-09-20
- **Context refs:** ADR 0005 (managed fleet — defines `Server mode`), ADR 0023 (base-tier
  fleet projection — the one-parser invariant), ADR 0025 (Remote-SSH default / host-owns-all-
  state), ADR 0002 (loopback bind / mutation refusal). Program: #792 (thin-client, merged),
  #1258 (durable hub, merged), #1260 (pluggable transport, merged), #1262 (`/amicode/*`→host
  proxy, merged), #780 (posture, merged).
- **Supersedes:** nothing. Additive to the fleet contract.

## Context

Today a machine's role in the fleet is exactly its **Server mode** — the closed union
`standalone | server | client` (ADR 0005) that says *where sessions are served from*. That
union is load-bearing: the never-fork guard, `tools/fleet/install.sh`, three TypeScript
consumers, and the external `amicissimo` parser all branch on it, and ADR 0023 makes
`amicissimo` the single parser of `fleet.json`.

Users want to say more than serve-stance. The motivating asks — "this laptop is Amicode on the
go," "this machine is the server," "this box runs solve jobs" — decompose into three *different*
kinds of statement: a serve-stance (`client`/`server`, which `Server mode` already covers), a
descriptive intent (`roaming`), and a compute capability that **has no backing infrastructure**
(a solve executes `local` or `remote`=Harmoniqs Cloud; a fleet *peer* as a compute target does
not exist). Overloading one enum to carry all three conflates orthogonal axes and forces a
cross-repo `amicissimo` contract change for every new label.

Separately, there is **no fleet-wide device roster** anywhere in the contract. The projection's
`topology` section describes only *this* machine's `{role, canonical}`; the `devices[]` list in
the `health` section is a **hardcoded bash array** in `ops/fleet-status.sh`, not derived from
membership. A "show me my fleet" surface has no roster to read.

## Decision

1. **Two axes, not a widened enum.** Keep `Server mode` (`standalone|server|client`) as the
   serve-stance, unchanged and still the sole driver of the guard/tunnel/hub-service behavior.
   Add an **orthogonal, open set of capability tags** per machine. Tags come in two classes:
   - **Known, behavior-driving** — `compute` (see #4) and `roaming` (a hint that defaults a
     machine's transport to `tailscale`).
   - **Descriptive** — any free tag or human nickname, with zero behavioral meaning.

2. **The capabilities live in an amicode-owned roster, not in `fleet.json`.** Introduce
   `~/.amico/ops/fleet/roster.json` on the **Canonical Server**. `fleet.json` is **untouched**
   (role + canonical only), so ADR 0023's one-parser invariant holds and this needs **zero
   `amicissimo` changes**. Each machine owns its own roster row (a registry/heartbeat model, no
   dual-writer conflict); the authoritative per-machine role remains its own `fleet.json`, and
   the roster row is the reconciled self-report.
   - Row shape: `{ machine_id, name, server_mode, capabilities[], sshAlias, transport,
     last_report, health }`; schema-versioned. `health ∈ { reachable, degraded, down }` (a
     per-device reachability tri-state — distinct from the *link-health* posture vocabulary
     `ok/degraded/hub-down`, which is about this machine's link to the hub, not a peer's
     reachability). The UI renders `server_mode` as "role" and `last_report` as "last-seen" —
     same fields, display labels.
   - Rows are written by the machine itself (a self-report over the authenticated `/amicode/`
     data plane — the accept-both service/engine mint of #822, to a loopback-bound host, NOT the
     ADR-0005 Fleet token, which guards SSH enrollment) or by the `/create-a-fleet` orchestrator
     acting for it during enroll. A write only ever touches the reporting machine's own row. The
     reachability status job (`ops/fleet-status.sh`) probes per roster row, retiring its
     hardcoded device array.

3. **Surface the roster via a host route on the proxied `/amicode/` namespace — not the
   per-machine projection, and NOT under `/amicode/fleet/*`.** The projection is published
   *locally* per machine from that machine's own `fleet.json`, so it is the wrong vehicle for
   fleet-wide state. Instead the host serves the roster at **`GET /amicode/roster`** (read) and
   accepts the self-report at **`POST /amicode/roster`** (write), and every client obtains the
   identical fleet-wide roster through the already-merged `/amicode/*`→host proxy (#1262).
   **Critically, the roster must live OUTSIDE `/amicode/fleet/*`:** that prefix is the client's
   own *local* honesty surface (its posture/mode/staging), which `shouldProxyAmicodeToHost`
   (`amicode_service/server.ts:250`) deliberately refuses to proxy so a client's own status can
   never be masked by the host's — verified by `fleet_client_relay.test.ts` (the host never sees
   `/amicode/fleet/*`). A roster route under that prefix would 404 on every client. Every OTHER
   `/amicode/*` path IS proxied to the host (`server.ts:251` returns `true`), so `/amicode/roster`
   is carried unchanged — the read as a GET proxy, the write as a proxied mutation to the
   loopback-bound host (the accepted-mutation path `fleet_client_relay.test.ts` covers). This is
   consistent with the host-owns-all-state model ADR 0025 adopts, and adds no second topology
   reader (ADR 0023 stays green).

4. **`compute` is declared-but-inert.** The capability model, the enroll flow, and the Fleet
   Manager UI all carry `compute`, but it **drives no solve routing**: a fleet-peer executor
   (SSH-dispatch a solve to a compute-tagged machine + artifact sync-back + tier/warrant
   integration) is a greenfield subsystem and an explicit **non-goal** of this work, named for a
   future issue. The UI shows `compute` with an honest "not yet wired" affordance. `compute` is
   the first known behavior-driving tag; it proves the open-capability pattern without forcing
   the subsystem.

## Approaches considered

- **Widen the `Server mode` enum** (add `cluster`, `laptop`, …) — rejected: conflates
  serve-stance with capability, breaks the closed union the guard + `amicissimo` + three
  consumers depend on, and forces an `amicissimo` contract change per new value. (It also walks
  into the glossary's `Fleet` `_Avoid_: cluster`.)
- **Put `capabilities[]` in `fleet.json`** — rejected: cleanest single source per machine, but
  forces a cross-repo `amicissimo` parser change (or capabilities vanish on machines that *have*
  `amicissimo`), which can block the UI on external work.
- **Capabilities in VS Code machine settings** — rejected: fully amicode-owned, but each machine
  sees only itself; there is no cross-fleet roster, so a manager view cannot show peers.
- **Roster in an additive projection section** — rejected in favor of the host route: the
  projection is locally published, so it cannot carry fleet-wide state to a client without a new
  aggregation path; the host route + #1262 proxy already exists.
- **A roster route under `/amicode/fleet/*`** — rejected: that prefix is the one namespace
  `shouldProxyAmicodeToHost` (`server.ts:250`) refuses to proxy (the client's own local honesty
  surface), so it would 404 on every client. The roster is host-owned fleet-wide state, the
  opposite of a local honesty surface, and belongs on the proxied `/amicode/roster` path.

## Invariants held

1. **One topology reader (ADR 0023).** The roster is a *new amicode-owned artifact*, not a second
   `fleet.json` parser; the guard-assert gate stays green.
2. **Never-fork (ADR 0005).** Enroll on a client installs the guard (`role: client` → `exit 1`);
   no client spawns an engine. Capabilities never change serve-stance behavior.
3. **Loopback bind + mutation refusal (ADR 0002/0005).** The roster self-report write rides the
   authenticated `/amicode/` data plane (the accept-both service/engine mint, #822) to a
   loopback-bound host — the same inject-the-credential, keep-loopback model #1262 uses; the new
   write route calls the `bind_host` loopback check like the other mutation routes
   (`solver_mode.ts`, `connections.ts`).
4. **No silent fallback (ADR 0024/0025).** Roster health reflects honest reachability; nothing
   reroutes silently.
5. **Server mode is the only serve-stance authority.** Capabilities are orthogonal metadata; a
   tag never overrides the guard/tunnel/hub-service decision.

## Consequences

- The generalizable role model the product wanted lands without a cross-repo contract change; the
  first two useful tags (`roaming`, `compute`) ship immediately, one live and one honestly inert.
- The fleet gains a real device roster; `ops/fleet-status.sh` stops hardcoding membership.
- A future fleet-peer executor can make `compute` live without re-opening this ADR — it only adds
  behavior behind an already-modeled tag.
- `amicissimo` may later enrich the roster; amicode owns the public floor, mirroring ADR 0023.

## Non-goals

- The fleet-peer solve executor (the subsystem that would make `compute` live).
- Any change to `Server mode`'s union or the `fleet.json` contract.
- `amicissimo` parser changes.

## Source

- Design of record: the fleet-setup PRD-parent, #1316 (this branch's
  `feature/free-tier-fleet` design-of-record), which decomposes into **five** slice sub-issues:
  capability model + roster (#1318) · enroll primitive (#1319) · `/create-a-fleet` orchestrator
  (#1320) · sidebar section (#1321) · Fleet Manager tab (#1322).

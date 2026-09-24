---
type: spec
schema_version: "1"
spec_id: spec-20260920-213918-peer-fleet-compute-federation
task_type: plan
acceptance:
  - serving_tag_present_on_roster == 1
  - placement_target_defaults_local == 1
  - attach_over_real_transport == 1
  - attach_injects_client_credential == 1
  - peer_trust_identity_recorded == 1
  - event_relay_seam_recorded == 1
  - hub_enroll_guard_bytes_changed == 0
  - new_fleet_json_parsers == 0
  - peer_client_stance_used == 0
  - roster_route_resolves_to_distinct_keeper == 1
  - studio_state_resolves_to_attached_server == 1
  - honesty_surface_stays_local == 1
  - empty_attachment_routes_local == 1
  - attach_detach_action_exercised == 1
  - fleet_manager_attach_control_exercised == 1
  - sse_cursor_resets_on_switch == 1
  - attach_switch_p95_ms <= 2000
  - max_db_writers_per_machine <= 1
invariants:
  - Additive only — the hub/star topology, `amico fleet enroll`, and the never-fork guard (`amico-opencode-fleet-guard`) are byte-unchanged; peer support adds files, it does not edit the hub path. ADR 0025 (Remote-SSH default) remains valid for the thin-client case.
  - Independent per-machine studios — each machine owns its own sessions and database; there is no shared cross-machine DB. Single-writer-per-DB is preserved by the existing adopt-or-spawn gate, per machine.
  - Peer machines never take the `client` serve-stance — a peer stays `standalone` and advertises; it attaches to others by PROXY (which spawns no engine), so the never-fork guard is never triggered and never relaxed.
  - The directory keeper holds `roster.json` and is decoupled from "the only server" — it is the registry host, not necessarily a hub; every peer still serves and can be attached to.
  - Compute federation (Horizon 2) dispatches STATELESS work owned by the originating session — the executor never grows a shadow session the originator must reconcile.
  - One parser of `fleet.json` (ADR 0023) — everything new is amicode-owned (roster + service registry + switch pointer); zero `amicissimo` contract changes.
  - The local honesty surface (`/amicode/fleet/*`) and the switch-control pointer are never proxied — a client's own posture can never be masked by a peer's.
baseline: { none_because: "design-of-record for a topology change, not a numeric-metric task; the baseline is the merged feature/free-tier-fleet @ 97709e25 (#1316/#1323) single-hub topology — one role=server + N never-fork clients sharing the hub DB, and a Fleet Manager tab whose action set is the closed union repair|goStandalone|restartHub, reading server.current but never calling setActive" }
---

# Peer fleet with compute federation as the declared end-state

## Context

Today a fleet is a **star**: `amico fleet enroll` (merged in #1316/#1323) makes exactly one machine
`role=server` and every other machine a `role=client` whose never-fork guard
(`amico-opencode-fleet-guard`, `exit 1`) forbids it from running its own engine — it tunnels to the
one hub and shares the hub's database. ADR 0025 (also merged) doubles down on this with a
Remote-SSH-default posture and host-owns-all-state.

Two facts reframe the problem:

1. **"Host a server" has two senses.** Running an engine *for yourself* is already true of every
   machine: no `fleet.json` means `standalone`, and a standalone machine spawns/adopts its own
   loopback engine. Serving *for others* is the designated `role=server`, capped at one, with
   clients barred from serving.
2. **The north star is server-to-server agent spooling** — engines dispatching agents/subagents
   to one another and streaming results back. This is *impossible on one host by definition*
   (one engine, nothing to spool), and the star path actively provisions the wrong substrate
   (never-fork clients that cannot accept a dispatched agent).

**Reused, merged foundation (the starting substrate for slice 1 — all present at the baseline):**
`/amicode/roster` (a fleet-wide, host-owned device registry) and `amicode_service/roster.ts`;
`fleet_roster.ts` (an open `capabilities[]` axis with `compute`/`roaming` known tags — `compute`
shipped "declared but inert"); `fleet_discover.ts` (candidate discovery over roster + `~/.ssh/config`
+ tailnet); a roster-driven `ops/fleet-status.sh`; `versionSkewVerdict` in `@amicode/schema`; the
Fleet Manager tab + sidebar; **the `amicode_service` reverse proxy and its `shouldProxyAmicodeToHost`
(`amicode_service/server.ts:242`)**; **`fleet_transport.ts`** (ssh/tailscale/direct providers); and
**`fleet_client_relay.test.ts`** (the relay-law suite the routing criteria extend).

This spec is the design-of-record (→ ADR 0027) for making the fleet **peer-capable** as the
buildable increment (**Horizon 1**), designed deliberately as the substrate for **Horizon 2**
(compute federation). It does not build Horizon 2.

## Decisions

- **D1 — Additive peer topology.** Peers ride the merged roster/discovery/UI as a NEW mode
  alongside the hub/star mode. The hub `enroll`, the never-fork guard, and ADR 0025 stay for the
  thin-client→server case. Replacing the star is rejected (§Approaches).
- **D2 — Independent studios.** Each peer runs its own engine on its own DB; single-writer-per-DB
  is preserved per machine by the existing adopt-or-spawn gate — untouched.
- **D3 — Multiplexing service (the three-way resolver).** The loopback `amicode_service` holds N
  keyed upstreams and re-targets by generalizing `shouldProxyAmicodeToHost` into a THREE-way
  resolver: local honesty surface → local; `/amicode/roster` → the **keeper** (D7); every other
  `/amicode/*` + engine + SSE → the **attached server** named by the D6 pointer. **Default: when the
  pointer is empty (a fresh standalone peer), the studio branch routes to the LOCAL engine** — the
  attached branch is never undefined. D3 CONSUMES the D6 pointer; it does not own it.
- **D4 — Switch = pointer flip + SSE cursor reset.** Switching attachment flips the D6 pointer and
  RESETS the SSE cursor (a different server is a fresh stream, never a `?after=` resume). This is the
  ONLY Horizon-1 obligation of the event-stream seam (D12), and it carries its own acceptance
  criterion (`sse_cursor_resets_on_switch`).
- **D5 — Attach/detach action + upstream lifecycle.** A first-class control ADDS/REMOVES an upstream
  and drives the D6 pointer. H1 ships an **API (an `amico`/service verb)** AND a **Fleet Manager
  "Attach" control** on the existing device rows (the baseline tab reads `server.current` but never
  switches — this decision is what adds switching). Both surfaces carry acceptance criteria
  (`attach_detach_action_exercised` for the verb, `fleet_manager_attach_control_exercised` for the
  control). The attach candidate list is the roster (D7).
- **D6 — Switch-control pointer (sole owner).** The "current attached server" pointer — its state AND
  its local endpoint under `/amicode/fleet/*`-class routing (never proxied) — is owned here and only
  here. D3 and D4 consume it. A peer's attachment state is thus always its own.
- **D7 — Directory keeper, resolvable and decoupled from hub.** Reuse the host-owned `roster.json` and
  its GET/POST `/amicode/roster` routes; the "keeper" is a registry role, not "the only server". To
  make "resolves to the keeper" non-circular, the keeper's coordinate is carried by an explicit
  **keeper bootstrap pointer** (a resolvable address, sibling to the D6 pointer) — NOT discovered from
  the very `roster.json` the keeper hosts. Peers self-report their row to the keeper (single-writer
  upsert). The bootstrap pointer is first exercised by `roster_route_resolves_to_distinct_keeper`
  (Slice 2).
- **D8 — Serving advertisement as a placement-ready capability.** A peer advertises its already-running
  engine via a roster `serving` tag PLUS reach coordinates — a **placement-ready descriptor** (a
  `serving` marker + reach coordinates: reachable + serving). Richer placement fields a future
  scheduler may want (e.g. headroom) are a Horizon-2 concern, not asserted in H1. It sits on the open
  `capabilities[]` axis (ADR 0026); it does NOT change `server_mode` (still the sole serve-stance
  authority) and needs no `fleet.json`/`amicissimo` change.
- **D9 — Per-attachment transport, SSH default, engine-reachable.** Reuse `fleet_transport.ts`. Each
  transport is an authenticated, engine-reachable channel (bidirectional-capable) so Horizon 2's
  engine↔engine RPC reuses it; `roaming`→tailscale, direct optional, SSH the universal default. Nobody
  is forced onto tailscale (`fleet_discover.ts` already treats `~/.ssh/config` as first-class).
- **D10 — Peer credential + peer-trust identity.** *D10a (H1, code):* inject a UI client credential
  per attachment (as #1262 does) — a proxied request must carry it to authenticate to the peer engine,
  so **it lands with the transport (Slice 3), not later**, and it carries its own criterion
  (`attach_injects_client_credential`). *D10b (H1, recorded design):* ADR 0027 NAMES a peer-trust
  identity (server A proving fleet membership to server B) distinct from the UI mint AND states the
  token choice as one of {ADR-0005 Fleet token, a new peer token} — so H2 needs no re-plumbing.
- **D11 — Placement seam on the spawn path.** `amicode_session` / Task dispatch thread an OPTIONAL
  placement target defaulting to `local`, so H2 populates it without re-plumbing the spawn path. H1
  proves the default and the threaded field; nothing reads it as a route yet. This is a pure
  spawn-path signature/default change with **no dependency on the resolver** (no attachment needed).
- **D12 — Federatable event stream (seam).** ADR 0027 names an SSE model in which a remote child's
  events can relay into the originating session's stream. H1 exercises ONLY D4 (cursor-reset-on-switch,
  with its own criterion); relay/merge is Horizon-2-only.
- **D13 — Horizon 2 is declared, not built.** The compute-federation executor (dispatch RPC, placement
  scheduler, artifact sync-back, inter-server trust made live, event relay/merge) is the end-state
  ADR 0027 declares and an explicit non-goal of this spec's build. It makes `compute` live behind the
  capability tag ADR 0026 already ships.

## The five substrate seams → each bound to an acceptance criterion (no hollow count)

1. **Engine-reachable transport** (D9) → `attach_over_real_transport == 1`.
2. **Peer-trust credential** (D10b, the recorded H2 peer token) → `peer_trust_identity_recorded == 1`.
   (The H1 UI credential, D10a, is separate plumbing → `attach_injects_client_credential == 1`.)
3. **Placement-ready capability descriptor** (D8) → `serving_tag_present_on_roster == 1`.
4. **Spawn-path placement target** (D11) → `placement_target_defaults_local == 1`.
5. **Federatable event stream** (D12; H1 obligation D4) → recorded: `event_relay_seam_recorded == 1`;
   behavioral H1 slice: `sse_cursor_resets_on_switch == 1`.

## Horizon-1 slice order (dependency edges explicit)

- **Slice 0 — ADR 0027.** Records D10b (peer-trust identity + token choice) and D12 (relay seam).
  → `peer_trust_identity_recorded`, `event_relay_seam_recorded`.
- **Slice 1 — Advertise + keeper coordinate** (D8, D7). → `serving_tag_present_on_roster`. No deps.
  (D7's keeper bootstrap pointer is first exercised in Slice 2 by
  `roster_route_resolves_to_distinct_keeper`.)
- **Slice 2 — Pointer + multiplexing resolver** (D6, then D3). Needs Slice 1's keeper coordinate.
  → `roster_route_resolves_to_distinct_keeper`, `studio_state_resolves_to_attached_server`,
  `honesty_surface_stays_local`, `empty_attachment_routes_local`. (Resolver criteria set the pointer
  directly — they do not need real transport, Slice 3.)
- **Slice 3 — Per-attachment transport + credential** (D9, D10a). Needs Slice 2.
  → `attach_over_real_transport`, `attach_injects_client_credential`. (The credential lands here
  because a proxied request must authenticate to the peer engine to *reach* it.)
- **Slice 4 — Switch + attach/detach action** (D4, D5). Needs Slices 2–3.
  → `attach_detach_action_exercised`, `fleet_manager_attach_control_exercised`,
  `sse_cursor_resets_on_switch`, `attach_switch_p95_ms`. (The p95 harness runs over Slice 3's REAL
  transport, not a stub — so it genuinely inherits Slice 3.)
- **Slice 5 — Placement seam** (D11). No deps — a pure spawn-path signature/default.
  → `placement_target_defaults_local`.
- **Cross-cutting:** `hub_enroll_guard_bytes_changed`, `new_fleet_json_parsers`,
  `max_db_writers_per_machine` are measurable from the baseline (not slice-gated).
  `peer_client_stance_used` is a continuous invariant, non-vacuously exercised once the attach flow
  lands (Slice 4).

## Measurement Protocol

- `serving_tag_present_on_roster == 1` — a peer that advertises writes a roster row carrying a
  `serving` marker + reach coordinates (reachable + serving); a read of `GET /amicode/roster` asserts
  them present. Richer placement fields (headroom) are H2, not asserted here.
- `placement_target_defaults_local == 1` — a signature/default test proves the spawn path accepts an
  optional placement target and that its absence resolves to `local`. No attachment needed.
- `attach_over_real_transport == 1` — at least one attach is exercised over a REAL (SSH-default)
  `fleet_transport.ts` channel, not a stub, and *reaches the peer engine*, proven by a
  peer-identifying field in the response the loopback mux cannot forge (the peer's engine/machine
  identity).
- `attach_injects_client_credential == 1` — an attach with NO injected credential is refused by the
  peer engine (401/403); a credentialed attach returns 2xx carrying the peer-identifying field.
- `peer_trust_identity_recorded == 1` — ADR 0027 §D10b states the peer-trust identity AND the token
  choice is explicitly ONE of {ADR-0005 Fleet token, a new peer token}; an absent, ambiguous, or
  un-chosen statement fails.
- `event_relay_seam_recorded == 1` — ADR 0027 §D12 names all three of: the relay point, the
  originating-session-id merge rule, and the H2 consumer; a missing element fails.
- `hub_enroll_guard_bytes_changed == 0` — `git diff` on `packages/amico-run/src/fleet_enroll_verb.ts`,
  `tools/fleet/amico-opencode-fleet-guard`, and the enroll test suites is EMPTY, full stop.
- `new_fleet_json_parsers == 0` — no new parser of `fleet.json`; peer reads go through the existing
  `@amicode/schema` reader (guard-assert gate stays green).
- `peer_client_stance_used == 0` — a test proves the peer-attach flow (Slice 4) writes no `fleet.json`
  with `role=client` and never installs the never-fork guard (attach is proxy-only, spawns no engine).
  A continuous invariant, non-vacuously exercised once the attach flow exists.
- `roster_route_resolves_to_distinct_keeper == 1` — a relay test with a keeper host and an attached
  host that are DISTINCT addresses asserts `GET/POST /amicode/roster` RESOLVES TO the keeper's address
  (a routing-target assertion) regardless of which studio is attached.
- `studio_state_resolves_to_attached_server == 1` — the same distinct-host test asserts every other
  `/amicode/*` path + engine proxy + SSE RESOLVE TO the ATTACHED host's address, not the keeper.
- `honesty_surface_stays_local == 1` — the same test asserts `/amicode/fleet/*` and the D6 pointer
  endpoint are never proxied (extends `fleet_client_relay.test.ts`).
- `empty_attachment_routes_local == 1` — with the pointer empty, a test asserts studio `/amicode/*` +
  engine resolve to the LOCAL engine (the D3 default branch); testable at Slice 2 by setting the
  pointer directly.
- `attach_detach_action_exercised == 1` — a test drives the D5 verb: attach adds an upstream and sets
  the pointer; detach removes it and clears the pointer; the roster is the candidate source.
- `fleet_manager_attach_control_exercised == 1` — a Fleet Manager tab test drives the "Attach" control
  (the UI surface, not only the verb) through attach and detach end-to-end.
- `sse_cursor_resets_on_switch == 1` — after a switch, the new SSE subscription the multiplexer issues
  to the attached server opens a FRESH stream with NO `?after=` cursor (the one behavior D4 ships).
- `attach_switch_p95_ms <= 2000` — a harness running over Slice 3's REAL (SSH-default) transport (not
  a stub) measures BOTH initial attach AND a switch between two attached peers, where "usable" = the
  first 2xx FROM THE PEER ENGINE (the peer-identifying field present, distinguishing it from a local
  2xx); p95 ≤ 2000 ms — the hard not-to-exceed ceiling (the `amicode.fleetDegradedLatencyP95Ms`
  default; "swift" is the intent, this is the fail bound).
- `max_db_writers_per_machine <= 1` — a test proves that on any single machine a second engine cannot
  become a writer against that machine's DB (adopt-or-spawn adopts; it does not create a second writer),
  independent of how many peers are attached.

## Non-goals

- The Horizon-2 compute-federation executor itself: server-to-server dispatch RPC, the placement
  scheduler, artifact/result sync-back, inter-server trust made live, and event-stream relay/merge.
  Declared by ADR 0027; built later.
- Making `compute` live (it stays "declared but inert").
- Any change to `FleetConfig`/`fleet.json`, the hub `enroll` flow, the never-fork guard, or the
  `amicissimo` contract.
- Replacing the hub/star mode or ADR 0025's Remote-SSH posture.

## Approaches considered

- **Keep one host (star only)** — rejected: server-to-server spooling is impossible on one engine, and
  the never-fork client provisions the wrong substrate for it.
- **Replace the star with peers** — rejected: discards the merged `enroll` flow and the thin-client
  case ADR 0025 targets.
- **Un-pin the webview's native multi-server switcher (client-side N origins)** — rejected for the data
  plane: it bypasses the `amicode_service` `/amicode/*` ownership, credential translation, and the
  single-origin CSP/auth model. The switcher UI is instead reused as the front-end that drives the D6
  pointer (D5).
- **Force Tailscale for multi-peer reach** — rejected: SSH is the universal default; tailscale is opt-in
  via `roaming` (D9).

## Review

**Round 1 — mechanical (tool-run):** `amico spec validate` → ok; `amico spec review --offline` →
`approved-mechanical`, 0 findings (schema/falsifiable/provenance lenses ran).

**Round 1 — judgment critics (tool-run):** `amico spec review` returned `degraded` — the three
judgment lenses (`hidden-failure`, `decomposition`, `sequencing`) SKIPPED ("the child did not report
the model it ran as"; filed as a tooling bug, #1347). `degraded` is NOT `approved`; recorded as such.

**Round 2 — judgment critics by hand (independent subagents, one lens each, spec-only):** no blocking
contradiction. Advisories resolved into the round-2 spec: replaced the hollow `seams == 5` count with a
behavioral AC per seam; defined `attach_switch` "usable"; gave the keeper a bootstrap pointer; required
distinct keeper/attached hosts; hardened `hub_enroll_guard_bytes_changed` to an empty diff; added
`empty_attachment_routes_local`; split D2→D2/D3/D4, D6 sole pointer owner, D7/D10 split, added D5.

**Round 3 — judgment critics by hand re-run on the round-2 spec (independent subagents, spec-only):**
no blocking contradiction; three convergent advisory clusters, all resolved into this round-3 spec:
- *event seam had no behavioral gate* → added `sse_cursor_resets_on_switch` (D4's one H1 behavior).
- *credential ordering was backwards* → moved D10a (credential) from Slice 5 into Slice 3 (a proxied
  request must be credentialed to reach the peer engine) and gave it `attach_injects_client_credential`.
- *p95 could pass on stubs* → the harness now runs over Slice 3's real transport and "usable" = a 2xx
  from the peer engine (peer-identifying field), distinguished from a local 2xx.
- *"reaches" vs "resolves"* → renamed the Slice-2 routing criteria to `…_resolves_to_…`; reserved
  "reaches" for the Slice-3 real-transport criterion.
- *D11 spurious dependency* → Slice 5 (D11 placement seam) is now no-deps.
- *self-certifying ADR checks* → tightened `peer_trust_identity_recorded` (token choice must be one of
  two enumerated options) and `event_relay_seam_recorded` (all three elements named).
- *`peer_client_stance_used` mislabelled baseline* → reclassified as a continuous invariant exercised
  from Slice 4.
- *UI control unexercised* → added `fleet_manager_attach_control_exercised`.

**Verdict: approved-by-hand (round 3)** — tier-1 clean (tool-run); the judgment lenses were run by
independent spec-only critics across two rounds with no contradictions and every advisory resolved.
This is a weaker claim than tool-run `approved`; the tool critics degraded on the #1347 harness fault,
not on spec content. When #1347 is fixed, re-run `amico spec review` for the first-class verdict.

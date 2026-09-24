# ADR 0033 — Fleet Studio: per-session SSE fan-out and lossless resume

- **Status:** **accepted** (design gate #1450 resolved by human review 2026-09-24 — D1–D4 accepted as-is; the three open questions resolved A / A / B, see "Decision record" below; unblocks ONE implementation issue behind `AMICO_FLEET_MULTIPLEX`)
- **Date:** 2026-09-23 (accepted 2026-09-24)
- **Context refs:** ADR 0031 (Fleet Studio in-window multi-machine sessions — §D1 retires the single attachment pointer, which W1b/#1449 implemented), ADR 0027 (§7 event-relay seam — **consumed here**; single-origin invariant — **preserved here**), ADR 0032 (peer-trust credential — the per-peer auth this relay will need, see Open Questions), #1264 (global lossless-reconnect cursor — **generalized here**).
- **Supersedes/blocks:** unblocks a future *implementation* issue for per-session SSE fan-out, to be opened only after this design is reviewed.

## Context

W1a (#1448) put the session multiplexer into dispatch behind `AMICO_FLEET_MULTIPLEX` (default OFF), exposing only `resolveTarget` — the AC4 structural guard forbids any SSE crossing the multiplexer. W1b (#1449) made per-session **request + upgrade** routing real: an owned session's non-stream requests route to `resolved.url`, an owned-but-unreachable peer degrades to a `FLEET_PEER_UNREACHABLE` 503 (never a silent local fallback, the #1382 invariant), and the `SessionOwnerMap` is fed by a timer.

**What is still missing is the event stream.** "Interact with a peer's session as if local" is not real until the peer's *events* reach this window. The existing pieces do not compose:

1. **Wrong stream.** The app's live feed is a **single global `/event` stream** opened once per window (`packages/app-bundle/overlay/packages/app/src/context/server-sdk.tsx:254-277`). The multiplexer's `openSseStream` (`packages/extension/src/amicode_service/session_multiplexer.ts:284-357`) connects instead to a peer's **per-session** `/api/session/{id}/event`. Nothing bridges per-session peer streams into the one global stream the app actually consumes.
2. **No `res` adapter.** `openSseStream` returns an in-memory `SseStreamHandle` (`next()`/`close()`) designed for a test to pull events one at a time. It is **not** an HTTP response writer — it cannot emit SSE frames onto the global `/event` `res` the app is attached to.
3. **`id:` is dropped.** The relay parses only the `data:` line (`session_multiplexer.ts:323`) and discards the `id:` line. The app's lossless reconnect (#1264) depends on the server id-ing every event and the client tracking `lastEventID` (`server-sdk.tsx:243-253`). A relay that drops `id:` silently breaks reconnect for peer-owned sessions.
4. **A single scalar cannot track N peers.** The client cursor is one window-scoped string persisted in `sessionStorage` (`CURSOR_KEY = "amicode.sse.lastEventID"`). Peer A and peer B each have their **own** monotonic event id-space; one scalar cannot encode where we are in N independent streams. Merging N id-spaces into one cursor is the unsolved core.
5. **No local arm.** `openSseStream` only connects when a peer URL exists. A single-machine user (fleet-of-one, the common case) would get **zero events** if dispatch ever routed the global stream through the multiplexer. The local machine's own event source must remain the spine.

The single-origin invariant (ADR 0027) holds: the app keeps exactly one server connection. The question is what happens *behind* that origin.

## Decision

**Aggregate at the origin; keep the app on its single global `/event` subscription; make the cursor a namespaced composite.** Concretely, the origin's multiplexer fans **in** each owned session's peer event stream and the local event source into the one global `/event` response the app already reads. Four mechanisms, each independently testable:

### D1 — Stream inversion: fan-in, not per-session subscription

The app does **not** move to N per-session subscriptions. It keeps its single global `/event` GET. On the origin, the handler for `/event` becomes a **fan-in aggregator**: it opens (a) the local event source and (b) one upstream SSE connection per **reachable owner peer** that owns at least one session in the current `SessionOwnerMap`, and writes all of their frames onto the single downstream `res`. Peers are added/removed as the owner-map timer changes the owned-peer set. An unreachable owner contributes no frames and is surfaced honestly (a `FLEET_PEER_UNREACHABLE`-style comment frame, not a silent gap — mirrors the W1b request-path invariant).

*Rationale:* preserves the single-origin model and the app's one-cursor client with the smallest app-side change; per-session subscription (the rejected alternative, see below) multiplies connections and rewrites the client's whole reconnect model.

### D2 — `id:`-verbatim, namespaced relay + a real `res` adapter

Replace the `data:`-only parse with a **frame-preserving relay**: read each upstream SSE frame and re-emit it onto the downstream `res` with its `event:`/`data:`/`retry:` lines intact, and its `id:` line **namespaced by owner**: `id: <machineId>\u001f<peerId>` (unit-separator-joined; the local arm uses a reserved `local` namespace). Introduce an `SseStreamHandle → res` adapter (a `pipeToResponse(handle, res)` that writes real SSE bytes and flushes), so the relay drives the actual global-stream response rather than a test's `next()`. The `data:` payload is passed through unmodified except for the existing `session_id` attribution tag, so the reconcile-based reducers are unaffected.

### D3 — Per-peer cursor set (a composite cursor, parsed at the origin)

Generalize #1264's scalar. On reconnect the client still sends **one** `?lastEventID=<value>` (no client change beyond value opacity), but that value is a **composite** the origin parses into a per-namespace map: `local=<id>;<machineIdA>=<idA>;<machineIdB>=<idB>`. The origin re-subscribes each upstream with **its own** resume param (`/api/session/{id}/event?lastEventID=<idX>` or the peer's equivalent) and replays the local arm from `<id>`. The client's `trackEventID` (`server-sdk.tsx:243`) keeps overwriting the whole composite string as the latest namespaced `id:` arrives — the origin is the only component that needs to understand the composite's structure. Over-delivery on replay remains tolerated by the reducers, exactly as #1264 already assumes.

### D4 — Local arm always present

The aggregator **always** includes the local event source, whether or not any peer is owned. Fleet-of-one → the aggregate is byte-identical to today's single local `/event` (one namespace, `local`), so single-machine users are unaffected — this is the invariant the implementation's first test must pin.

## Test plan

Unit-testable on a single host (no fleet required):
- **D2 relay:** feed a synthetic upstream frame sequence (with `id:`, multi-line `data:`, comments, `retry:`) through the relay; assert the downstream bytes preserve every line and namespace only the `id:`. Assert `pipeToResponse` writes well-formed SSE and flushes per frame.
- **D3 cursor:** round-trip `format(parse(composite)) === composite`; assert a reconnect with a composite cursor issues the correct per-namespace resume params (spy the upstream opener); assert an id-less frame does not advance its namespace (matches #1264).
- **D4 local arm:** with zero peers, assert the aggregate stream equals the local stream frame-for-frame (fleet-of-one byte-identity) and that `?lastEventID=local=<id>` resumes the local arm.
- **D1 fan-in membership:** drive the `SessionOwnerMap` timer; assert peers are added/removed from the upstream set as owned-session ownership changes, and that an unreachable owner emits the honest comment frame rather than a silent gap.

Requires a real fleet (deferred, human-in-the-loop, needs the Mac Studio):
- Actual cross-machine event delivery end-to-end; per-peer **authentication** of the upstream SSE connection (see Open Questions); reconnect across a real peer flap.

## Alternatives considered

- **Move the app to per-session subscriptions (N streams).** Rejected as primary: multiplies connection count, discards the single global-cursor model, and is a large app-side rewrite for the same observable behavior. Kept as the fallback if origin-side fan-in proves to have unacceptable head-of-line coupling.
- **One cursor, last-writer-wins (ignore N id-spaces).** Rejected: silently loses the reconnect gap for all but one peer — reintroduces exactly the data-loss #1264 fixed.

## Constraints & invariants

- No SSE crosses the multiplexer until this design is reviewed and its implementation issue lands behind `AMICO_FLEET_MULTIPLEX` (still default OFF). The AC4 guard (`resolveTarget`-only) stays until then.
- W1a/W1b must not regress the existing global lossless-reconnect cursor for the flag-OFF / fleet-of-one path — D4's byte-identity test is the guard.

## Open questions (for the reviewer)

1. **Per-peer auth (ADR 0032).** `ResolvedTarget` carries no token today; W1b's request path reuses the attached hub-mint credential (H1). The upstream SSE connections in D1 need per-peer credentials (H2) before this is real cross-machine. Does the fan-in aggregator read the peer token from the peer-store per upstream, or is a hub-mediated relay credential preferable?
2. **`GET /amicode/fleet/focus` snapshot.** W4b (#1453) noted the machine picker cannot seed on a cold webview because focus is a best-effort push with no read-back. If this design adds a fleet-state channel, exposing current focus on connect would close that gap cheaply — worth folding in or keeping separate?
3. **Head-of-line / back-pressure** across N upstreams sharing one downstream `res`: acceptable at expected fleet sizes (2–4 machines), or does D1 need per-namespace buffering bounds?

## Decision record (human review, 2026-09-24)

The reviewer accepted **D1–D4 as-is** and resolved the three open questions with **robustness under a poor network connection as the stated priority**. The core resume mechanism (D2 `id:`-verbatim relay + D3 composite cursor) is the lossless-reconnect foundation and stands unchanged.

1. **Per-peer auth → Option A: the aggregator reads each peer's token from the peer-store per upstream.** Each upstream SSE authenticates *as itself* (H2), matching the independent-peer topology the rest of Fleet Studio adopts (#1477–#1487). Rejected Option B (hub-mediated relay credential): it makes the hub a single trust *and* connectivity chokepoint — a degraded link to the hub would kill every peer stream at once. With A, peer connections fail independently: one dark peer never takes down another's stream or the local arm.

2. **Focus snapshot → Option A: fold a focus-on-connect snapshot into the fan-in channel.** Under a flaky link the webview reconnects often; folding the current focus/picker state into the connect snapshot makes each reconnect **self-healing** (the cold-seed gap W4b flagged closes on every reconnect), rather than leaving a stale picker after a drop. The snapshot is emitted as the first frame on the `local` namespace at connect/reconnect.

3. **Back-pressure → Option B: per-namespace buffering bounds (the robustness-priority choice).** Each peer namespace gets its own bounded buffer on the shared downstream `res`; an overflowing (slow/flapping) peer degrades **in isolation** and resumes from its D3 cursor on recovery, instead of head-of-line-blocking the shared response and freezing every other session (including local). This is deliberately more machinery than the ADR's "defensible at 2–4 machines" Option A, chosen because the reviewer prioritized consistent behavior on a bad connection over v1 simplicity. Buffer-overflow drops are safe precisely because D3 replays the gap on reconnect — B and the composite cursor compose into graceful degradation + lossless catch-up.

**Honest boundary:** this makes a bad connection *recover correctly* (no lost/duplicated events, no one peer freezing the rest), NOT *feel instant* — a peer on a poor link still lags and catches up on reconnect. The first implementation test remains D4's fleet-of-one byte-identity guard.

## Source

Part of #1436. W1c / #1450 (labeled `hitl`; the design gate). Blocked-by W1b (#1449, landed). This ADR is the design deliverable; the AC's "reviewed before implementation" gate is a **human** review — no implementation issue is opened by the overnight campaign.

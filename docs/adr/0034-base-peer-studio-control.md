# ADR 0034 — Complete the base peer-studio; reserve premium for managed autonomy

**Status:** **accepted** (design review with JJ, 2026-09-24 — the grill-with-docs pass in the B2b brainstorm resolved the seven open decisions D1–D7 recorded below; the proposed sketch stands as the intent, the decision record makes it buildable). Blocks the B2b implementation issue.

**Date:** 2026-09-24

**Context refs:** ADR 0031 (Fleet Studio in-window multi-machine sessions — the independent-peer/keeper shape this completes), ADR 0033 (per-session SSE fan-in — **consumed here** for the live-events plane; its `AMICO_FLEET_MULTIPLEX` gate is reconciled in D6), ADR 0026/0028 (Roster, Device identity), ADR 0002/0005 (per-boot password, Fleet token). Substrate PRs: #1480 (identity-bound Observe bootstrap), #1482 (`ControlGatedResolver`), #1484 (`evaluateRemoteWriteGate`), #1486 (grant lifecycle state machine), #1537 (the observation read plane — the read half B2b extends).

Fleet Studio is completed by base-enabling and finishing the dormant #1455/#147x slices, not by rebuilding them. Independent serving peers own their Sessions; a keeper/canonical coordinate owns roster and bootstrap authority. Existing N-peer projection, owner routing, provenance, focus, picker, and write-confirmation foundations remain the substrate. Base Amicode owns verified peer observation and explicit peer control; Amicissimo remains an additive tier for managed autonomy, governance, premium methods, tuned routing, and managed fleet infrastructure.

Trust unlocks remote Session observation. A persisted, explicit per-peer Control grant unlocks interaction only after a mechanical readiness gate verifies stable identity, managed peer transport, bilateral token state, projection, owner routing, and SSE. The grant fails closed on revocation, identity change, transport loss, or disable; remote file writes remain per-action confirmed.

## Considered options

- **Keep the existing premium data-plane gate** — rejected: it prevents self-owned peer control while the underlying security primitives already live in base code.
- **Rebuild Fleet Studio from scratch** — rejected: #1455 already landed the majority of the correct substrate; replacing it would waste tested work and create drift.
- **Automatic control after roster discovery** — rejected: peer reachability is not authority.

## Consequences

- The work decomposes into base activation, peer lifecycle, peer transport/identity hygiene, SSE/interactive completion, and UI/E2E wiring (the slices in the Source section — five tracked sub-issues, plus docs that ride slice 1).
- Existing premium staging becomes a managed-overlay policy mechanism rather than the sole route-mount gate for self-owned peer control.
- The glossary reconciles its single-store Fleet language with the independent-peer/keeper model — see the `CONTEXT.md` `Fleet & serving` additions (Peer studio, Observe, Control, Enable control, Lifecycle-admin authority, Driving) that ship with this ADR.

## Decision record (grill-with-docs, 2026-09-24)

The B2b brainstorm resolved the following, in dependency order. Each decision is grounded against the substrate code cited.

### D1 — Scope: control **and** live streaming, together

B2b delivers remote prompt / archive / delete **and** live event streaming of the remote response. Rationale (the reviewer's, verbatim in spirit): a prompt you cannot watch land is not control. Live events are part of the control experience, not a follow-on — so ADR 0033's fan-in is pulled into B2b's boundary rather than deferred.

### D2 — Path: extend the observation path into the base peer-studio (no premium arming)

Control + streaming are added to the **observation path** (`baseStudioActivates`, `observationOnly`), not the armed premium multiplex. The observation path already carries grant-free reads (#1537). We keep those unchanged and add a write plane and a fan-in aggregator beside them.

- **Rejected — arm the premium multiplex:** contradicts this ADR's own first rejected option, and undoes the reason the #1537 read fix exists (the observation path routes *around* the premium gate).
- **Rejected — unify read + write onto `ControlGatedResolver`:** that resolver requires an active grant (observe scope minimum) or returns `unavailable`; unifying regresses the working **grant-free** read path the moment no grant exists (which is the default — the grant store is absent). Reads stay reader-token-based; only writes require a grant.

Two trust levels, two mechanisms: **trust / reader-token unlocks Observe; an explicit `control` grant + per-action confirm unlocks writes.**

**Grant-key correction (deliberate review):** `evaluateRemoteWriteGate` reads `grantReader(ownerMachineId)`, but `fleet_control_lifecycle` persists/reads grants keyed by **`requesterMachineId`**. In the self-owned case the controlling machine is the *requester* and the driven session's owner is the *target*, so a naïve `grantReader(ownerMachineId)` returns `undefined` and every write denies `no-control-grant`. Resolution: the write plane's `grantReader` resolves the controlling machine's own **`control`** grant by **`targetMachineId === ownerMachineId`** (a `LifecycleGrant` already carries `targetMachineId`) — i.e. it composes `readAllLifecycleGrants().find(g => g.targetMachineId === ownerMachineId && g.scope === "control" && g.state === "active")`, not a `requesterMachineId`-keyed lookup. #1541 delivers this owner/target-resolvable read and persists the issued grant (incl. its `token`) on the controlling machine; #1542 presents that `token` via its own `proxyToPeer` (see D6-adjacent note in #1542), **not** through `ControlGatedResolver`, whose adapter drops the peer credential today.

### D3 — Establishment: self-owned fast-path + shared handshake; authority seeded at Enroll

- **Self-owned peer** (the operator owns both machines): Control is armed by **one explicit "Enable control" act on the controlling machine**, authorized by *verified management access* established at Enroll. This is a **net-new** control-scoped bootstrap decision (`evaluateControlBootstrap`, structurally mirroring `evaluateObserveBootstrap`) — **not** an extension of `evaluateObserveBootstrap`, which *explicitly refuses* a control outcome ("there is NO control outcome here — Control scope is #1486; a natural Control seam is … deliberately NOT implemented"). *Verified management access* must be a **defined predicate**, not the bare `managementVerified` boolean the observe path takes on trust (that boolean is set true only in tests today): #1541 names the identity/transport/token check that establishes it. Not automatic (an explicit act; and re-armed each session), so "reachability is not authority" holds.
- **Shared peer** (a different operator's machine): the full **request → approve handshake**, routed to whoever holds that peer's **Lifecycle-admin authority**.
- **`lifecycle-admin` authority is NET-NEW persistence, seeded at `amico fleet enroll`:** today `authorityIdentityKey` exists *only* as an injected parameter to the pure `isLifecycleAuthority` predicate — there is **no store, no writer, no resolver**. #1541 therefore defines (a) a persisted authority record, (b) a writer invoked at Enroll that records the enroller as the target's authority, and (c) a resolver answering *who holds authority for machine X* from another machine. This is what makes a **headless** peer approvable — the approval act runs on a UI-bearing authority machine; the headless peer only **enforces** the presented token (`enforceScopeForRequest`) and never renders an approval prompt.

### D4 — Confirmation: authorize at the service, confirm with the closest existing UI

The write gate (`evaluateRemoteWriteGate`) **authorizes** (active `control` grant + reachable transport); **human-intent confirmation is rendered by the UI closest to the human**, so a write is never double-confirmed.

- **Enable control** is the one net-new confirmation surface — a VS Code **native modal** — plus a persistent **"driving `<peer>`" banner** so control is never ambient. Per-session, re-armed (`fleet_headless_rehydration.ts` never auto-restores control).
- **prompt** flows freely under enabled control (no per-message confirm).
- **archive** takes **no discrete confirm** — it is reversible (an unarchive action sits beside it).
- **delete** reuses the **existing local confirmation** (the dropdown's arm→confirm / the timeline's modal). Note the existing delete surfaces are **local-only** today (a peer/remote row renders no delete affordance, and the timeline delete calls the local SDK keyed on `sessionID`), so #1544 must *build* the remote-delete surface and route it by owner — "reuse" means reuse the arm→confirm *interaction*, over a new owner-routed action.

**Confirmation is a consumer policy, not a gate output (deliberate review):** `evaluateRemoteWriteGate` returns `requiresConfirmation: true` for *every* remote write with an active grant — it does not branch on action-kind. So the gate is not "reused unchanged to get prompt-free / delete-confirmed"; instead the gate **authorizes**, and the **consumer applies confirmation policy keyed on the `action` the gate already carries** in `WriteConfirmationContext` (prompt → none under enabled control; archive → none; delete → the existing arm→confirm). The gate's `requiresConfirmation` flag is therefore *advisory metadata* the consumer interprets, not a mandatory second modal.

**Reason-vocabulary source of truth (deliberate review):** three modules emit overlapping-but-different reason strings — notably `evaluateRemoteWriteGate` **collapses `revocation-pending` → `grant-revoked`**, while `remote_session_state` / `control_gated_routing` keep them distinct. The UI's single source of truth for the fail-closed chip is **`remote_session_state.ts`** (the only session-UI-state type); the raw write-gate reason is not surfaced directly.

This is a deliberate reading of "remote file writes remain per-action confirmed": the per-session control-enable is the authorization for the prompt stream; discrete confirmation is reserved for the destructive, irreversible act (`delete`), rendered once by the UI that already owns it.

### D5 — Fail-closed surface

The UI honors the existing `read-only` / `unavailable` states (`remote_session_state.ts`, `control_gated_routing.ts`) with their named reasons (`no-control-grant`, `revocation-pending`, `transport-down`, `insufficient-scope`). Write affordances (composer→peer, delete, archive) are **disabled with a visible reason chip** when control is not held, with an **Enable control** (self-owned) / **Request control** (shared) affordance when eligible. **Never** a live button that 500s; **never** a silent local fallback (the #1382 invariant, already upheld on reads).

### D6 — Live events on the observation path; `AMICO_FLEET_MULTIPLEX` reconciled

ADR 0033's fan-in mechanics (D1 aggregator · D2 `id:`-namespaced relay · D3 composite cursor · D4 always-local arm · per-namespace buffering) are **reused as a library** (`SseFanIn*`) on a **NEW, separately-armed `/event` interception** on the observation path. This is *not* a re-gate of the existing fan-in: the only wired `/event` fan-in today is `server.ts` `fleetMultiplexEnabled() && this.fleetPlane?.eventFanIn` (premium flag + premium plane), and the observation branch deliberately wires none ("NO SSE fan-in — that stays flag-gated/premium"). The new interception is armed on **observation readiness** — *holding `observe` on ≥1 reachable session-owning peer* — and the premium `server.ts` gate is left untouched. Each upstream authenticates **as itself** (ADR 0033 Decision 1, Option A). Because this path is **not behind the multiplexer at all**, it does not violate ADR 0033's "no SSE crosses the multiplexer until behind the flag" invariant — see **ADR 0033 Amendment 1**, which records this reconciliation. Fleet-of-one byte-identity is guarded by the **driver declining at zero non-local owners** (not merely "an always-present local arm"), and holds only when **no focus-snapshot provider is installed** (the aggregator emits a focus frame ahead of the local arm when one is); that guard is the first implementation test.

### D7 — Terminus & documentation

This ADR (accepted) + the `CONTEXT.md` `Fleet & serving` glossary additions are the durable record; the implementation is tracked by a GitHub issue decomposed into **five** sub-issues (#1541–#1545); the sixth "slice" (docs) is this ADR + `CONTEXT.md`, which ride slice 1's PR rather than a separate issue. The app-surface glossary (`packages/app-bundle/overlay/packages/app/CONTEXT.md`) keeps the sidebar fleet section **read-only**; the control affordances land on the **session surface** + the **Fleet Manager** tab and are documented there when the UI slice (slice 4) lands.

## Constraints & invariants

- **Fail-closed, never local:** a known remote owner whose grant/transport/scope forbids a write returns a named denial, never a local execution and never a silent local read fallback (#1382).
- **Grant-free reads preserved:** Observe continues to work with the reader token and no lifecycle grant; the write plane's grant requirement must not regress it.
- **Control is never auto-restored:** every service restart / reconnect leaves control suspended until an explicit re-enable (`fleet_headless_rehydration.ts` AC2).
- **Byte-identity for fleet-of-one / flag-off:** with zero non-local owners the driver declines and `/event` stays frame-for-frame the local stream (guarded in the driver, and only absent a focus-snapshot provider); the write plane is inert for local-owned and unowned sessions.
- **Headless peers enforce only:** a peer with no UI never renders approval; authority to mint/approve lives on a UI-bearing Lifecycle-admin machine, seeded at Enroll.
- **`lifecycle-admin` ≠ `control`, even for the holder:** the route matrix authorizes `lifecycle-admin` only for mint/revoke/re-admit — an authority holder cannot drive a peer's session. To drive, the holder must **self-issue a `control` grant** separately. (`control` does subsume `observe` routes at the matrix; `lifecycle-admin` does not.)
- **Fan-in is not behind the multiplexer:** the observation `/event` interception is separately armed on observation readiness; the premium `server.ts` fan-in gate (`fleetMultiplexEnabled()` + `fleetPlane`) is untouched (ADR 0033 Amendment 1).

## Source

Part of the Fleet Studio line (#1436, #1455). Grounds the B2b implementation issue **#1540**. Slices (vertical tracer bullets):

1. **Grant foundation** — Enroll seeds `lifecycle-admin`; self-owned `control` issuance; per-session re-arm. (unit-testable, no UI)
2. **Observation write plane** — gated writes route to the owner with the control token; honest deny otherwise; enable→delete/archive end-to-end for a self-owned peer.
3. **Fan-in** — ADR 0033 D1–D4 on the observation `/event` aggregator (the largest; may sub-split per-D).
4. **UI** — Enable control + driving banner + fail-closed states + write affordances (session surface); Fleet Manager grant management.
5. **Shared handshake** — request→approve routed to the Lifecycle-admin authority; pending-request surface.
6. **Docs** — this ADR + `CONTEXT.md`, landed with slice 1 (not a separate issue; a single-artifact deliverable). The tracked implementation is **five** sub-issues, #1541–#1545.

Sequencing option (reviewer to confirm at decomposition): slices **1 → 2 → 4** ship self-owned control (prompt/delete/archive, results seen on session re-fetch) *before* the fan-in weight of slice 3, which then upgrades it to live streaming — a smaller first PR that briefly trades away D1's "streaming is part of control" until 3 lands.

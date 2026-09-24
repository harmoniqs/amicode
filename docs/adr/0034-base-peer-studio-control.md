# ADR 0034 — Complete the base peer-studio; reserve premium for managed autonomy

**Status:** proposed

Fleet Studio is completed by base-enabling and finishing the dormant #1455 slices, not by rebuilding them. Independent serving peers own their Sessions; a keeper/canonical coordinate owns roster and bootstrap authority. Existing N-peer projection, owner routing, provenance, focus, picker, and write-confirmation foundations remain the substrate. Base Amicode owns verified peer observation and explicit peer control; Amicissimo remains an additive tier for managed autonomy, governance, premium methods, tuned routing, and managed fleet infrastructure.

Trust unlocks remote Session observation. A persisted, explicit per-peer Control grant unlocks interaction only after a mechanical readiness gate verifies stable identity, managed peer transport, bilateral token state, projection, owner routing, and SSE. The grant fails closed on revocation, identity change, transport loss, or disable; remote file writes remain per-action confirmed.

## Considered options

- **Keep the existing premium data-plane gate** — rejected: it prevents self-owned peer control while the underlying security primitives already live in base code.
- **Rebuild Fleet Studio from scratch** — rejected: #1455 already landed the majority of the correct substrate; replacing it would waste tested work and create drift.
- **Automatic control after roster discovery** — rejected: peer reachability is not authority.

## Consequences

- The work decomposes into base activation, peer lifecycle, peer transport/identity hygiene, SSE/interactive completion, and UI/E2E wiring.
- Existing premium staging becomes a managed-overlay policy mechanism rather than the sole route-mount gate for self-owned peer control.
- The glossary must reconcile its single-store Fleet language with the independent-peer/keeper model.

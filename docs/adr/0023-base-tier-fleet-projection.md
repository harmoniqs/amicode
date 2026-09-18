# ADR 0023 — Base-tier fleet projection (a public floor under the amicissimo authority)

- **Status:** accepted
- **Date:** 2026-09-18
- **Context refs:** ADR 0005 (managed fleet), the fleet rearchitect (#1068 P3b-1,
  #1106 P3b-2, #1194), spec-20260913-114814 (amicissimo the fleet authority),
  `spec-20260904-fleet-boundary-and-thin-client` (the split + thin client).

## Context

The fleet rearchitect made **amicissimo** the single parser: its Python
`fleet_authority` package publishes a contract-v1 `projection.json`, and every
amicode consumer (extension `fleet_topology.ts`, `tools/fleet/install.sh`, the
`amico-opencode-fleet-guard`) reads **only** that projection — never the raw
`fleet.json`. The publisher is entitlement-gated (`PREMIUM_CODE = "amicissimo"`):
an unentitled or checkout-less machine hits the **bootstrap exception**
(`FLEET_BOOTSTRAP_EXIT = 75`) and every consumer honestly degrades to
base-standalone.

That coupling has a consequence the rearchitect did not intend to be permanent:
**the base (public) product cannot run a hardened fleet client at all.** The
never-fork guard's `exit 1` fires only when the projection says `role: client`;
with no amicissimo, the projection never says that, so a client machine's guard
falls through and spawns a local server — the exact silent-fork the guard exists
to prevent (the 2026-08-07 incident class, #1227). A base-path user with two
machines (a hub + a roaming client) therefore has no enforced client.

## Decision

Add a **base-tier projection producer**: a TS-native path so that when the
amicissimo authority is unavailable (no entitlement, or entitled but no
checkout) **but the machine carries a `fleet.json` declaring a real role
(`client`/`server`)**, `amico fleet status --projection` renders and caches a
minimal contract-v1 `projection.json` **itself**, and returns success — instead
of exiting 75.

Invariants held:

1. **One reader, unchanged.** Consumers still read only `projection.json`
   through `@amicode/schema`'s `readProjection`. We add a *producer* under the
   authority, never a second consumer-side raw read. `assert_fleet_guard.sh` and
   the single-parser test stay green by construction.
2. **amicissimo stays canonical.** Entitled + checkout present → the Python
   publisher runs exactly as before (health, locks, program, org sections, the
   provenance-stamped epoch). The base tier fills only `mode` + `topology`
   (role + canonical) + a stable local epoch — the floor, not the rich surface.
3. **Surgical, minimal blast radius.** The base tier engages ONLY for an
   enrolled machine (`fleet.json` role `client`/`server`). An unenrolled machine
   (no `fleet.json`, or `role: standalone`) keeps the existing bootstrap-75
   behavior verbatim — all existing bootstrap tests are preserved.
4. **Honest provenance.** The base projection stamps
   `publisher.identity = "amicode-base-tier"` and section provenance
   `source: fleet.json`, so a reader can always tell a base-tier floor from the
   amicissimo authority. The verb's JSON carries `base_tier: true`.

### Freshness

The base tier has no hub epoch, so it mints a **stable per-machine epoch**
persisted at `~/.amico/ops/fleet/base_epoch` (a UUID; reused across calls so
`freshnessBetween` compares within one epoch and never loops on "unknown").
The counter is persisted beside the epoch and seeded from the publish
wall-second. Each publish atomically advances it, including when publishes land
within one second or the wall clock moves backwards.

## Consequences

- A base-path client is now enforced: guard reads `role: client` → `exit 1` →
  the panel rides the tunnel, never forks. The installer stamps guard + settings
  + tunnel from the base projection's `canonical`.
- The dual-role hub case (a workstation that is both hub and editor) becomes
  expressible: the machine can carry a `client`/`server` role and the consumers
  behave accordingly without amicissimo.
- No change to the entitled path, the contract version, or the consumers.
- When the base tier and amicissimo disagree, amicissimo wins (it runs whenever
  present); the base tier is strictly the fallback floor.

---
type: adr
date: 2026-09-04
status: accepted
title: Fleet boundary — provisioning to amicissimo, architecture stays as the entitled surface
tags: [adr, fleet, split, boundary, entitlement]
---

# ADR-0012 — Fleet boundary: provisioning to amicissimo, architecture stays as the entitled surface

## Status

Accepted (2026-09-04, Aaron) — applies amicissimo ADR-0002's split boundary to the
fleet asset class, using this repo's ADR-0011 entitled-surface pattern and
amicissimo ADR-0003's architecture/overlay framing.

## Context

Everything fleet currently lives in this repo: the provisioning tooling
(`tools/fleet/` — installer, spawn guard, tunnel plist), the extension's fleet
architecture (role detection in the fleet fallback module, the attach state
machine, health checks, panel posture), and fleet logic woven through the
extension host wiring. amicissimo ADR-0002 classified "the fleet-specific
provisioning" as premium-side, and the 2026-09-03 outage marathon produced a
fleet design corpus (incident record, improvement backlog, the thin-client PRD)
that belongs with the premium ops knowledge.

The boundary test (amicissimo ADR-0002): does a customer need it before they pay?
→ public funnel (amicode). Does it constitute the tuned advantage? → amicissimo.

## Decision

1. **Fleet provisioning moves to amicissimo** — `tools/fleet/` (installer, guard,
   tunnel plist) is carried byte-identical into amicissimo `automation/fleet/`
   (amicissimo PR #379), which becomes the home of record and where its defects
   (the `FLEET_SSH_ALIAS` placeholder leak, amicissimo#791) get fixed first.
2. **The extension's fleet architecture stays here, as the entitled surface** —
   role detection, the attach state machine, health checks, and the honest
   posture surfaces are the generic client behavior a premium entitlement lights
   up (ADR-0011's pattern: an entitlement lights a surface honestly, not a stub).
   The guard-binary name check in the extension is the entitlement seam: fleet
   machines get the guard from premium provisioning.
3. **The fleet design record moves to amicissimo `docs/fleet/`** (anatomy,
   incident record, improvement backlog, thin-client PRD); the decision history
   lives in the armonissima vault (spec-20260904-fleet-boundary-and-thin-client).
4. **`tools/fleet/` in this repo is deprecated, not deleted** — a pointer banner
   goes in now; removal happens only after amicissimo's installer entry point
   ships and no fleet machine depends on this copy (no fleet machine stranded).

## Consequences

- Premium provisioning owns its own install path; this repo stops shipping fleet
  install machinery in a future slice.
- Extension fleet code changes (the WIP bundle: posture #780, spawn hardening
  #781, rejoin #783) are architecture-side and unaffected.
- The thin-client PRD (#792) spans both sides: the relay lives in the vendored
  fork; the extension's relay-mode spawn is architecture (here); the fleet-side
  rollout tooling is premium (amicissimo).

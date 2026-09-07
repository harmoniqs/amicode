# FLEET BETA — provisioning checklist and what the smoke proves

Slice 4e (amicissimo#398) makes the local-shell data plane testable
end-to-end. This is the checklist a beta tester works through, and what
each smoke leg proves. The sub-spec of record:
`spec-20260905-193000-local-shell-data-plane` (D1 one service / three
upstream modes, D6 degradation steady state, D7 the tunnel stamps its own
config).

## What a beta tester provisions

| # | Item | Where | Notes |
|---|------|-------|-------|
| 1 | **The amicissimo entitlement** | `~/.amico/amicode/entitlements.toml` → `codes = ["amicissimo", …]` | Without it the overlay is never even read: the base posture is byte-identical. |
| 2 | **The overlay source** (the amicissimo checkout holding `fleet_overlay/overlays/fleet-data-plane.json`) | resolved by the ladder: `AMICO_OVERLAY_SOURCE` → `AMICISSIMO_ROOT` → `~/armonia/repos/amicissimo`; settings override: `amicode.fleetOverlaySource` | The staging gate refuses to arm anything without a lawful manifest declaring the `data-plane-routing` surface. |
| 3 | **The hub base URL** | setting `amicode.fleetHubUrl` (e.g. `http://127.0.0.1:4096`); env `AMICODE_FLEET_HUB_URL` overrides | The fleet mode's data + SSE upstream. |
| 4 | **The tunnel ssh alias** | setting `amicode.fleetTunnelAlias`; env `AMICODE_FLEET_TUNNEL_ALIAS` overrides | REQUIRED — D7: the installed tunnel config must carry the stamped alias (never the literal `FLEET_SSH_ALIAS` placeholder). Activation without an alias cannot arm. |
| 5 | **The tunnel config path** (optional) | setting `amicode.fleetTunnelConfigPath`; env `AMICODE_FLEET_TUNNEL_CONFIG` | Makes the D7 stamp (stamped alias + tunnel generation) visible on `/amicode/fleet/status`. |
| 6 | **The hub credential** | `~/.amico/fleet-hub.json` (`AMICO_FLEET_HUB_FILE` override) — `{ base_url, token }` | The hub mint: used ONLY on the upstream hop, never accepted client-side. Missing = the named `hub-credential-missing` 503. |
| 7 | **Posture tuning** (optional) | settings `amicode.fleetDegradedLatencyP95Ms` (default 2000), `fleetDegradedWindowSamples` (5), `fleetHubDownConsecutiveNoResponses` (3), `fleetRecoveryConsecutiveHealthy` (3) | `0` = the default. No behavior change unless set. |

**Absent activation config (no hub URL + alias) means the fleet option is
never passed at boot: the service is byte-identical to base — the H3
discipline extends to activation.**

## Running the smoke

```bash
# DRY — fixtures only, nothing real touched (the CI-shaped run):
pnpm --filter amicode run smoke:fleet

# LIVE — the real hub through the real tunnel (gated on the explicit flag):
AMICODE_FLEET_SMOKE_LIVE=1 \
AMICODE_FLEET_HUB_URL=http://127.0.0.1:4096 \
AMICODE_FLEET_TUNNEL_ALIAS=<your-tunnel-alias> \
[AMICODE_FLEET_TUNNEL_CONFIG=/path/to/tunnel.plist] \
  pnpm --filter amicode run smoke:fleet
```

## What each leg proves

| Leg | Proves |
|-----|--------|
| **A · no-entitlement byte-identity** | With activation configured but the entitlement absent, the service is byte-identical to base (6-request spot check) and the fleet paths answer the base no-route 404 — the fleet mode does not exist. |
| **B · armed boot** | Entitlement + lawful manifest + activation config → the fleet mode arms through the REAL wiring: `/amicode/fleet/status` answers (staged provenance, the three named mints, the hub credential), and `/amicode/fleet/sessions` returns the MERGED projection — both stores, provenance-tagged, hub the store of record, currency derived over what was fetched. |
| **C · kill leg** | The hub dies → N consecutive no-responses → the hub-down posture (standalone + surfaced pointer); data requests route LOCALLY (the base standalone posture runs); the projection names the hub absence; rejoin → recovery re-enters fleet and the refetch epoch bumps (refetch-before-first-render). |
| **C · hang leg** | A WEDGED hub (connections accepted, never answered) resolves through the CLIENT-enforced timeout — the detector cannot await a wedged tunnel — and enters hub-down; recovery holds hysteresis. Degraded is never welded to a wedged tunnel (D6). |
| **D · revocation leg** | A fleet write is delivered while entitled; the hub 401s the next write after revocation → failed + **read-only-with-pointer** + the Go-Standalone handoff; the base posture keeps running. Content is never eaten, never a wedge (D5). |
| **LIVE · staging + hub + tunnel stamp** | The machine's REAL entitlement and overlay stage the plane; the real hub answers through the real tunnel (merged projection, hub side present); the installed tunnel config carries the stamped alias, never the placeholder (D7's sharp form). Destructive legs are named skips — never run against a real hub. |

## Not in this beta

- Production credential distribution (the hub credential is hand-provisioned).
- The public opt-in flow (spec-first, rides its own spec).
- Write-path semantics beyond the write-failure contract (Slice B owns them).

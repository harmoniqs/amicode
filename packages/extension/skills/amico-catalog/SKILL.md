---
name: amico-catalog
description: Pulse catalog management — warm-start retrieval, pulse ingestion, and versioning. Use when looking up existing pulses or adding new ones to the catalog.
agents: [researcher, librarian, dreamer]
surface: public
---

Pulse catalog management for the Amico system. Covers warm-start retrieval, pulse ingestion, and versioning. Phase 0 scope: basic warm-start retrieval and ingestion only. Compiler stack fields (system_hash, calibrated, etc.) are not present yet.

## Catalog Structure

The central pulse catalog lives in the **team vault** (the `kind=team` mount, `<team-vault>/catalog/`; binaries via git-lfs).

```
<team-vault>/catalog/      # the team mount's catalog partition
  pulses/
    {id}/
      metadata.toml    # flat key-value pairs
      pulse.jld2        # binary pulse data (git-lfs)
```

Engagement vaults may carry a per-lab `catalog/` partition; warm-start retrieval searches the mounted catalogs.

## metadata.toml Schema

All keys are flat (NOT `[[entries]]` TOML arrays). Example:

```toml
id = "rydberg-CZ-v1"
platform = "rydberg"
gate = "CZ"
fidelity = 0.9999
duration_us = 0.5
pulse_type = "cubic"    # or "linear"
N_knots = 11
free_phase = true
path = "pulses/rydberg-CZ-v1/pulse.jld2"
branch = "main"
warm_started_from = ""  # or "rydberg-CZ-v0" for lineage
tags = ["seed", "three-level"]
created = 2026-03-24
```

Note: Compiler stack fields (`system_hash`, `calibrated`, etc.) are NOT present in Phase 0. They will be added when those phases land.

## Warm-Start Retrieval

To retrieve the best pulse for a given platform and gate:

```julia
# 1. Filter by platform + gate
# 2. Rank by fidelity (descending)
# 3. Load best match
pulse, meta = load_pulse("<team-vault>/catalog/pulses/rydberg-CZ-v1/pulse.jld2")
```

Steps:
1. Scan `<team-vault>/catalog/pulses/*/metadata.toml` for entries matching `platform` and `gate`
2. Sort candidates by `fidelity` descending
3. Load the `pulse.jld2` from the top candidate's `path`

## Versioning Convention

- ID format: `{platform}-{gate}-v{N}` (e.g., `rydberg-CZ-v1`, `rydberg-CZ-v2`)
- `warm_started_from` records lineage: which catalog entry was the starting point
- Version increment: v1 → v2 when a new pulse beats the incumbent for the same (platform, gate)

## Ingestion Protocol

1. Run optimization, obtain result with fidelity
2. Compare fidelity to current incumbent for this (platform, gate)
3. If better: create new catalog entry with incremented version number
4. Set `warm_started_from = "{previous-id}"` to record lineage
5. Write `metadata.toml` and `pulse.jld2` to `<team-vault>/catalog/pulses/{new-id}/`
6. Commit both files together

## Catalog Lifecycle

### Create
Experimenter creates new entry after achieving new-best result. Entry includes `metadata.toml` + `pulse.jld2`.

### Version
If new result is better than incumbent → create `v{N+1}`. "Better" = higher fidelity. If fidelity tied, shorter duration wins. If both tied, don't create new version.

### Lineage
`warm_started_from` must be a valid catalog ID (not free text). Schema-check validates this.

### Deprecate
Old versions remain in catalog (never deleted) but are not candidates for warm-start unless explicitly requested.

## Phase 0 Scope

No compiler stack fields in metadata. No multi-branch catalog management yet. Retrieval is by platform+gate only; system-specific matching (e.g., by Hamiltonian hash) is a future phase concern.

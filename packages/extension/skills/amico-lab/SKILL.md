---
name: amico-lab
description: Lab model and device management — device status, allocation, and locking for experiment dispatch. Use when checking device availability or dispatching experiments.
agents: [dispatcher]
surface: public
scenarios: [characterize-new-device]
---

Lab model and device management for the Amico system. Covers device status, allocation, and locking for experiment dispatch. Phase 0 scope: simulation devices only. No QPU allocation and no hardware export yet.

## Device Note Schema

Device notes live in `model-of-lab/` in the vault. YAML frontmatter:

```yaml
---
type: device
device_class: classical | quantum | lab
name: "{name}"
status: online | offline | maintenance
platform: null | "{platform}"
provider: local | cloud | partner
notes: "{description}"
tags: [device, {class}, ...]
---
```

## Current Devices (Phase 0)

| Device | Class | Platform | Provider | Status |
|--------|-------|----------|----------|--------|
| local-workstation | classical | null (all platforms via simulation) | local | online |

- `local-workstation` — classical simulation device, supports all platforms, always online in Phase 0

## Allocation (Phase 0 — simulation only)

- All experiments use `local-workstation`
- No QPU allocation yet (future phases)
- No hardware export yet (future phases)
- Device selection is trivial in Phase 0: always use `local-workstation`

## Lock Protocol

Before dispatching an experiment, acquire a lock to prevent concurrent writes to the same device.

### Acquiring a lock

Create `~/.amico/ops/locks/devices/{name}.lock` (mkdir the parent first: `mkdir -p ~/.amico/ops/locks/devices`) with contents:

```
session_id: {uuid}
created: {ISO-8601}
experiment: {experiment-note-name}
```

### Releasing a lock

Remove the lock file after the experiment completes or fails.

### Stale lock detection

If a lock file is more than 2 hours old, consider it stale and safe to remove. Always log when removing a stale lock.

## Julia Environment

Use these settings for all optimization scripts dispatched through Amico:

```bash
OPENBLAS_NUM_THREADS=1 julia -t auto --project=. script.jl
```

| Setting | Reason |
|---------|--------|
| `OPENBLAS_NUM_THREADS=1` | Prevents BLAS from competing with Julia threads in multistart workflows |
| `-t auto` | Enables Julia multithreading for parallel multistart |
| `--project=.` | Activates the correct Julia project environment |

In Julia code, also set:

```julia
using LinearAlgebra
BLAS.set_num_threads(1)
```

## Phase 0 Scope

QPU allocation and hardware export are not implemented. Do not attempt to allocate quantum hardware or export pulses to hardware-native formats until those phases land.

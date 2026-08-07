# The pulse.toml contract

The versioned interface between a Piccolo solve and a neutral-atom device. One file, two
consumers (local emulation and cloud submission), one validator — so a pulse that emulates
cannot fail differently in the cloud. Loaded on demand from [`../SKILL.md`](../SKILL.md).

## Schema

```toml
schema_version = 1          # REQUIRED, checked exactly (not >=)
units          = "rad/us"   # REQUIRED, checked exactly
dt_ns          = 16.0       # REQUIRED, positive finite; integer multiple of the clock period
n_knots        = 25         # REQUIRED, integer >= 2
amplitude      = [ ... ]    # REQUIRED, length == n_knots, finite; >= 0
detuning       = [ ... ]    # REQUIRED, length == n_knots, finite
fidelity       = 0.99999    # optional; if present must be in [0, 1]
atoms          = [[0.0, 0.0], [5.0, 0.0]]   # optional; [x, y] pairs in µm
T_ns           = 384.0      # informational — must equal (n_knots-1) × dt_ns
```

Two policies to internalize:

- **`schema_version` is checked exactly**, not as a minimum. A bump is a coordinated change to
  emitter and consumer, never a silent widening.
- **Unknown keys are ignored** (additive schema policy, matching the run-dir and score
  contracts). So adding provenance keys is free and safe: stamp `spike`, `target`, `run_id`,
  `git_sha`, whatever helps you later. Do it — an unlabelled `pulse.toml` six weeks old is
  archaeology.

## Duration arithmetic — the off-by-one that bites

$$\text{duration} = (n_{\text{knots}} - 1)\times dt_{\text{ns}}$$

$n$ knots bound $n-1$ intervals. Getting this wrong by one interval is the classic way a pulse
"just" exceeds the max sequence duration or "just" misses the channel minimum. When you build
`times = range(0, T, length = N)`, the resulting `dt` is $T/(N-1)$ — set `Δt_bounds` to that
value, not to $T/N$.

That same $n-1$ is the solver's unit of parallel work (`Threads.@threads for k = 1:(N-1)`), so
the interval count is worth choosing deliberately rather than inheriting: pick `dt_ns` as a
clock multiple and the interval count divisible by your thread count, then read `T_ns` off the
product. Above, 24 intervals × 16 ns = 384 ns balances on 4, 6, 8 and 12 threads.

## Validation, in the order it runs

**Structural** (device-independent — a malformed file never reaches a device):

| Rule | Failure means |
|---|---|
| `schema_version == 1` | emitter/consumer version mismatch |
| `units == "rad/us"` | you emitted rad/ns (Piccolo's convention) without the ×1e3 |
| `dt_ns` positive + finite | a degenerate or NaN timestep escaped the solve |
| `n_knots` integer ≥ 2 | ditto |
| `amplitude`/`detuning` length == `n_knots`, all finite | array/knot mismatch, or a NaN in the solution |
| `fidelity ∈ [0, 1]` if present | you wrote an infidelity, or an un-normalized number |
| `atoms[i]` is a finite `[x, y]` pair | register malformed |

**Against the target device** (every limit read off the device object at call time):

| Rule | Source |
|---|---|
| `dt_ns` is an integer multiple of the channel clock period | `channel.clock_period` |
| duration ≥ channel minimum | `channel.min_duration` |
| duration ≤ device max sequence duration | `device.max_sequence_duration` |
| `0 ≤ amplitude ≤ max_amp` | `channel.max_amp` |
| `|detuning| ≤ max_abs_detuning` | `channel.max_abs_detuning` |
| atom count ≤ device max | `device.max_atom_num` |
| every pair spacing ≥ device minimum | `device.min_atom_distance` |
| the named channel exists on the device | `device.channels` |

Because these come from the device object, **the numbers in this skill are for orientation
only** — a device-spec update propagates to the validator automatically and to this document
not at all. When a limit matters, read it from the device.

## Dust versus violation

A converged optimizer sits *on* its bounds, so the last digits will poke past them by ~1e-9
rad/µs. That is numerical dust and is clipped silently. Anything beyond **1e-6 rad/µs** raises,
naming the index and the overshoot:

```text
amplitude[57] = 13.204 violates bounds [0, 12.566] by 0.638 rad/us —
this is a bad solve, not numerical dust (tolerance 1e-06); refusing to clip it silently
```

Do not "fix" this by widening the tolerance. A 0.6 rad/µs overshoot means the solve was run
with the wrong bounds, or with none. Re-solve with the device's bounds on the system.

## Zero-order hold

Knots expand to 1 ns samples by repeating each knot value across its interval — the device
executes a staircase, not an interpolation. Two consequences worth stating to a user who
expected smoothness:

- The **executed** pulse is the staircase, so verify against `:constant` interpolation
  (`ket_rollout_fidelity(traj, sys; interpolation = :constant)`), not a smooth rollout. A
  fidelity computed with smooth interpolation is optimistic about a pulse the device will run
  as steps.
- Device **output modulation** then low-passes that staircase. Real hardware executes neither
  your knots nor your staircase but the filtered staircase; check against the filter before
  quoting a hardware-facing number.

## Sequence construction

The validated dict becomes a measured single-channel sequence: register from `atoms` (default
`[[0, 0]]`), the global Rydberg channel declared, one custom-waveform pulse for amplitude and
detuning at phase 0, then `measure()`. The library's own sequence validation runs underneath
as a second, independent line of defence — so a pulse that passes the contract and then fails
in the library has found a real gap; report it rather than working around it.

## Emitter checklist

Before writing the file:

- [ ] `units` conversion applied (Piccolo rad/ns → rad/µs, ×1e3)
- [ ] `dt_ns` equals $T/(N-1)$ and is an integer multiple of the clock period
- [ ] amplitude array is nonnegative
- [ ] `fidelity` is the **independent rollout** value, at `:constant` interpolation
- [ ] `atoms` present for multi-atom, in µm, spacings above the device minimum
- [ ] provenance keys stamped (run id, git sha, target, solver settings)

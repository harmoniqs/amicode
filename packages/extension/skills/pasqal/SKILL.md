---
name: pasqal
description: Take a Piccolo-optimized neutral-atom pulse to a Pasqal device — the pulse.toml contract, Pulser translation, local emulation, and cloud submission with the paid-target confirm gate. Use whenever a solved atom pulse needs to run on an emulator or QPU.
agents: [experimenter, researcher]
surface: public
public_refs: [published-specs]
scenarios: [mis-on-aquila, bank-pulse-with-provenance, readout-bitstring-interpretation, resource-estimate-before-spending]
vault_contract:
  platform_cards: [rydberg-global]
  tags: [rydberg]
---

The device path for neutral atoms: **solve in Piccolo → translate to Pulser → emulate
locally → submit to the cloud**. Each arrow is a gate that can reject you, and being
rejected early is the cheap outcome.

## Usage

`/pasqal` — the solve → translate → emulate → submit chain.

The argument is: $ARGUMENTS

## Instructions

Work the chain **in order** and stop at the first failure. The order is not bureaucracy: a
pulse that fails device validation locally would fail identically in the cloud, only slower
and after spending shots.

1. **Solve**, parameterized so the controls *are* the device's controls (below).
2. **Emit** `pulse.toml` — the versioned contract between the solver and the device.
3. **Validate + emulate locally** — free, offline, no credentials.
4. **Submit** — free emulator first; a paid emulator or the QPU requires explicit confirmation.

References, loaded on demand:

- **[references/contract.md](references/contract.md)** — the full `pulse.toml` schema, every
  validation rule, and what each rejection means.
- **[references/devices.md](references/devices.md)** — device tiers, published limits, how to
  pick a target, and the free/non-free boundary.

Related: `atoms` for the physics (and `atoms/references/analog.md` for register/MIS work),
`simulate` for the verification contract, `warm-start` for seeding.

## Step 1 — parameterize the solve in the device's own terms

This is the whole trick, and it makes translation trivial. Pasqal's analog Hamiltonian for a
global channel is

$$H = \frac{\Omega(t)}{2}\sum_i \sigma^x_i - \Delta(t)\sum_i n_i + \sum_{i<j}\frac{C_6}{r_{ij}^6} n_i n_j$$

so if you give Piccolo drives $[\;\tfrac{1}{2}\sum_i\sigma^x_i,\; -\sum_i n_i\;]$ then
$u_1$ **is** $\Omega(t)$ and $u_2$ **is** $\Delta(t)$ — sign convention included, zero
additional algebra at translation time.

```julia
using Piccolo, LinearAlgebra, TOML, Random
Random.seed!(1234)

# Published analog-device figures. Piccolo works in rad/ns here; the device
# publishes rad/µs, so ×1e-3. Read them off the device object when you can.
const Ω_MAX    = 12.566370614359172e-3    # rad/ns  (12.566 rad/µs)
const Δ_MAX    = 125.66370614359172e-3    # rad/ns
const C6       = 865_723.02e-3            # rad/ns · µm⁶
const CLOCK_NS = 4.0                      # channel clock period
const Ω_SLEW   = 250.0e-6 * 2π            # rad/ns² — published amplitude slew cap
const Δ_SLEW   = 2000.0e-6 * 2π           # rad/ns² — detuning slews 8× faster

σx = ComplexF64[0 1; 1 0]; n_r = ComplexF64[0 0; 0 1]
sys = QuantumSystem(zeros(ComplexF64, 2, 2),   # resonant frame: no drift
                    [σx / 2, -n_r],            # [Ω, Δ] — Pulser's own terms
                    [(0.0, Ω_MAX), (-Δ_MAX, Δ_MAX)])

# Δt is pinned to a multiple of the clock, so T and N are not independent: T = (N-1)·Δt.
# Pick Δt = 16 ns (4 clocks) and 24 intervals -> T = 384 ns. 24 also balances on
# 4, 6, 8 and 12 threads (the solver threads over intervals, not knots).
const STEP_NS = 4 * CLOCK_NS                    # 16 ns — an integer multiple of the clock
T, N  = 384.0, 25                               # ns; 24 intervals × 16 ns = 384, on the grid
times = collect(range(0.0, T, length = N))
u_init = vcat(clamp.(fill(π / T, 1, N) .+ 0.05Ω_MAX * randn(1, N), 0.05Ω_MAX, 0.95Ω_MAX),
              0.01Δ_MAX * randn(1, N))

qtraj = UnitaryTrajectory(sys, LinearSplinePulse(u_init, times), GATES[:X])
qcp = SplinePulseProblem(qtraj;
    piccolo_options = PiccoloOptions(timesteps_all_equal = true),
    Δt_bounds = (STEP_NS, STEP_NS),             # pin the grid to the device clock
    du_bounds = [Ω_SLEW, Δ_SLEW],               # per-channel slew caps, enforced everywhere
    Q = 100.0, R_u = 1e-4, R_du = 1e-5)
solve!(qcp; max_iter = 300)
```

Four non-negotiables in that snippet:

- **`LinearSplinePulse`** — this device consumes *piecewise-linear* time series (Braket AHS takes
  them literally; Pulser composes them from ramps) and publishes hard slew caps. Design in the
  basis it will actually run: a linear spline's `du` is the constrained inter-knot slope, so
  `du_bounds` bounds the realized slew rate across the whole waveform, and translation is a
  transcription rather than a resampling. A cubic spline bounds slope only *at* knots and can
  overshoot in between, so it cannot certify the cap; a zero-order hold describes a staircase the
  channel will not actually play. Either way, a pulse you resample at translation time is a
  different pulse than the one you verified.
- **`Δt_bounds = (STEP_NS, STEP_NS)`** + `timesteps_all_equal` — knots must land on the
  clock grid, or the device resamples underneath you. Pick `STEP_NS` as an integer multiple of
  the clock period, then let `N = T/STEP_NS + 1` follow; choose the multiple so `N-1` also
  divides by your thread count.

  **This is the one place a pinned grid is correct, and it is a deliberate exception.**
  Everywhere else, leave time free and timesteps unequal — those are Piccolo's defaults
  (`timesteps_all_equal` is `false` out of the box) and they let the optimizer redistribute
  duration toward the dynamics that need it. Pin only here, at the device boundary. Note also
  that `Δt_bounds = (x, x)` already forces every Δt equal, so passing `timesteps_all_equal =
  true` next to it is redundant belt-and-braces, not a second constraint. And because a pinned
  grid fixes the total duration, **`MinimumTimeProblem` cannot do anything on this problem** —
  compress the gate *before* pinning to the clock, never after.
- **Amplitude bound `(0.0, Ω_MAX)`** — hardware amplitude is nonnegative; the sign lives in
  the phase.
- **A frame with no drift** for a single atom; for multi-atom, `H_drift` is the $C_6/r^6$
  interaction term (see `atoms`).

## Step 2 — emit `pulse.toml`, then verify by rollout

```julia
traj = get_trajectory(qcp)
Uroll = iso_vec_to_operator(unitary_rollout(traj, sys)[:, end])   # fresh, independent
fid   = abs2(tr(Uroll' * GATES[:X])) / 4

A  = :u in traj.names ? traj.u : traj.a
Δt = first(Piccolo.get_timesteps(traj))
open("pulse.toml", "w") do io
    TOML.print(io, Dict(
        "schema_version" => 1,               # checked EXACTLY by the contract
        "units"     => "rad/us",             # checked exactly
        "fidelity"  => fid,                  # the ROLLED number, never the optimizer's
        "T_ns"      => T,
        "dt_ns"     => Δt,
        "n_knots"   => N,
        "amplitude" => collect(A[1, :]) .* 1e3,   # rad/ns → rad/µs
        "detuning"  => collect(A[2, :]) .* 1e3,
        # multi-atom only: positions in µm, checked against min atom distance
        # "atoms"   => [[0.0, 0.0], [5.0, 0.0]],
    ))
end
```

Report the **rolled** fidelity, not `fidelity(qcp)`. If they disagree, you have an
integration problem, not a result — `simulate` covers the diagnosis. Shipping the optimizer's
number into `pulse.toml` launders a claim into an artifact, and the artifact is what gets
banked.

## Step 3 — validate + emulate locally (free, offline)

The `pulse.toml` → `pulser.Sequence` translation is a **single shared contract** used by both
the local emulator and the cloud submitter, so validation cannot drift between them. It reads
every limit off the device object at call time — nothing is hardcoded, so a device-spec update
propagates for free.

```bash
python3 translate_and_simulate.py           # validates, builds the Sequence, simulates
```

What it enforces, and what a rejection means:

| Rejection | Meaning |
|---|---|
| `schema_version must be 1` | your emitter and the contract disagree — fix the emitter |
| `dt_ns must be an integer multiple of the channel clock period` | knots are off-grid; pin `Δt_bounds` |
| `amplitude[i] violates bounds … by X rad/us` | a **bad solve**, deliberately not clipped |
| duration below channel minimum / above max sequence duration | re-solve at a feasible $T$ |
| `atoms[i] and atoms[j] are X µm apart` | register violates min atom distance |
| more atoms than `max_atom_num` | register too large for this device |

Bound-riding dust from the optimizer (< 1e-6 rad/µs) is clipped silently; anything larger
**raises**, naming the index and the magnitude. That asymmetry is deliberate — a real
violation must fail loudly rather than be silently squashed to the bound and submitted as if
it were fine.

Expect emulator-vs-optimizer agreement around 1e-6 for a well-parameterized single-channel
pulse. Enabling the device's **output-modulation filter** costs a little more (the hardware
low-passes what you asked for) — check against the filter before believing a hardware number.

## Step 4 — submit

```bash
amico pasqal devices                       # what this connection exposes, each tagged free/non-free
amico pasqal submit --device EMU_FREE --artifact pulse.toml --dry-run   # build + validate, no network
amico pasqal submit --device EMU_FREE --artifact pulse.toml
```

Rules the CLI enforces, so you do not have to remember them:

- **`--device` is mandatory.** Nothing is ever auto-selected, and there is no fallback to a
  paid target when a free one is unavailable.
- **Free target: exactly one** (the free emulator). Everything else — paid emulators, the QPU,
  any device name the tool has never seen — is **non-free by default-deny**.
- **A non-free target refuses to run without `--confirm <digest>`.** Re-run with the digest
  the error prints. The digest binds device + pulse content + project, so it stops being valid
  the moment the pulse changes — you cannot confirm once and then quietly submit something
  else. Ask the user before spending their money; a confirm gate is not a substitute for
  asking.
- **Blocked-connection states** (not connected / expired / no devices / stale device list)
  surface as their own actionable message and a non-zero exit, never a silent failure.

### Credentials — never handle them yourself

Credentials are the Connections panel's job. Concretely, **never** ask the user to paste a
password into a chat, put a secret on a command line, or set one in a script: the token
travels to the connector in the child environment only, minted and stored by the panel. If
the CLI says not connected or expired, the fix is "open the Connections panel and
(re)connect" — not a workaround. A secret on a command line is visible in `ps` and persists
in the session transcript forever.

## Step 5 — bank it

A verified pulse that ran on a device is exactly what the next team should warm-start from:

```bash
amico note write --from-run <run>          # the record, with provenance
amico catalog ingest --from-run <run>      # the pulse, keyed for warm-start retrieval
```

Ingest requires the verification record to agree — which is the point.

## Rules

1. **Parameterize for the device up front.** Retrofitting a solve into device units is where
   sign errors and unit slips live.
2. **Never submit an unverified pulse.** Rolled fidelity, then local emulation, then shots.
3. **Free emulator before anything paid**, every time, including for a pulse you are confident
   about.
4. **The user decides on paid targets**, explicitly, per submission.
5. **Read device limits from the device**, never from memory — including the numbers in this
   skill.

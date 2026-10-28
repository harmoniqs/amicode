---
name: intonatoqick
description: Drive the public IntonatoQICK.jl QICK/RFSoC hardware backend — mock loop, channel map, measurement model, and composing a QickExperiment into Intonato's closed-loop chassis. Use when running or testing quantum optimal control on QICK hardware (or its pure-Julia mock).
agents: [experimenter, engineer]
surface: public
revision: 1
---

# IntonatoQICK — the public QICK hardware backend

> **Status: archived.** `harmoniqs/IntonatoQICK.jl` is archived and was renamed
> Strumento.jl (`QickBackend` → `StrumentoBackend`, `MockQickSoc` → `MockSoc`,
> `PyQickSoc` → `StrumentoSoc`); the closed-loop seam (`StrumentoBackend` /
> `StrumentoExperiment`) now lives in Intonato itself (`src/hardware/`), and
> Intonato 0.5 absorbs the socs too (Strumento.jl retiring). New work targets
> `using Intonato`; the recipe below is kept for pinned IntonatoQICK 0.1.0
> environments. The index caveat applies to both lines.

> **Provenance:** salvaged from `harmoniqs/amico-plugin` PR #42 (repo archived
> 2026-08-26) — ruled SALVAGE in amicode#850, ported in amicode#851.

`IntonatoQICK.jl` bridges an Intonato `PulseTuningProblem` (closed-loop optimal control) to a
[QICK](https://github.com/openquantumhardware/qick) RFSoC board via PythonCall. It is a
registered **public** package (Intonato-only dep). This skill covers the public path: driving
the backend, the pure-Julia mock, and composing the experiment into Intonato's chassis.

**Boundary (why it's this shape):** the hardware interface is deliberately **coarse** — three
verbs `upload_pulse!` / `trigger!` / `readout` (+ `sample_rate`), pulse-in / IQ-out. All
tProc-v2 specifics (multiplexed/dynamic readout, `AveragerProgramV2`, sweeps) live on the
**board (Python) side**, so the firewall is "just a transport." Author to the three verbs; do
not push board specifics into Julia.

**Sibling skills** (reference, don't duplicate here): **hardware-loop** owns the full
closed-loop path — `PulseTuningProblem` → `StrumentoExperiment` → `StrumentoBackend` →
Strumento.jl → the Python `strumento` side — plus MockSoc-first validation and the
unattended-loop safety gates; **strumento** owns the board-side tProc-v2 experiment framework
itself; **intonatissimo** is the entitled tuning-strategy tier (below). This skill stays at
the IntonatoQICK package boundary.

## Core types

| Type | Role |
|---|---|
| `QickBackend <: AbstractHardwareBackend` | implements the Intonato hardware interface over an `AbstractQickSoc` |
| `MockQickSoc` | pure-Julia "board" — rolls the played pulse through a known `QuantumSystem`, emits synthetic IQ. Whole loop runs with **no Python, no hardware** |
| `PyQickSoc` | the real board (lazy `pyimport("qick")` in its ctor — never touched off-board or in CI) |
| `QickChannelMap` (`QickGenChannel`) | device policy: drive → gen-channel / carrier / IQ. A phase-modulated drive = I+Q on ONE channel |
| `QickExperiment(backend; measurement_model)` | → an Intonato `HardwareExperiment` you drop into `PulseTuningProblem` |

The package owns the **mechanism**; the channel map + discriminator (IQ → state) are **your
device policy**, caller-supplied.

## Usage (mock — the default dev/test path)

```julia
using IntonatoQICK, LinearAlgebra
σx = ComplexF64[0 1; 1 0]; σz = ComplexF64[1 0; 0 -1]

# The "board" holds the TRUE dynamics (here with a deliberate model mismatch):
sys_true = QuantumSystem(1.1 * σz, [σx], [1.0])
soc   = MockQickSoc(sys_true, ComplexF64[1, 0], ComplexF64[0, 1]; dac_rate = 80.0)
map   = QickChannelMap([QickGenChannel(0, 5e9; i_drive = 1)]; n_drives = 1)
model = MeasurementModel(:ψ̃, [populations], [N])
qexp  = QickExperiment(QickBackend(soc, map, [N]); measurement_model = model)

ptp = PulseTuningProblem(qcp, qexp, model)
solve!(ptp; max_iter = 10)
```

- `dac_rate` is the mock DAC grid. **Measurement indices are DAC-sample indices on this
  path**, not knot indices: the mock resamples onto `floor(Int, T*dac_rate)+1` points and
  measures at the reconstruction's `knot_times[k]`, so `[N]` means t = (N−1)/`dac_rate`, not
  t = T, unless the knot grid equals the DAC grid. The "readout converges as `dac_rate`
  rises" check therefore converges toward the *initial* state and does not show translation
  is faithful. Pass each knot's sample index (`round(Int, t_k*dac_rate)+1`) or put the
  knots on the DAC grid.
- Swap `MockQickSoc` → `PyQickSoc` for a real board; nothing else in the loop changes.
- **Intonato ≥ v0.4:** the `R_tr` / `Q_meas` constructor kwargs are **removed** — trust-region
  weighting belongs to the strategy (Intonatissimo's subproblem constructors take `R_tr`) and
  task weighting to the whitening `W_task`; the chassis constructor takes neither.

## The tuning strategy is where public stops

`PulseTuningProblem` runs with the **public no-op `IdentityStrategy`** by default — the chassis
composes and the loop *runs* through the seam, but a no-op tuner does not drive convergence.
Intonato also ships one **public** concrete strategy: `LowRankHessianStrategy` — measured-gradient
Newton in the low-rank principal subspace of the model-cost Hessian, where the device model
supplies the directions/curvatures and the gradient is measured on the device by central finite
differences along each direction. **Algorithmic convergence** (matching hardware measurements
iteration-over-iteration) beyond that needs a concrete tuning strategy, which ships as the
**entitlement-gated** `intonatissimo` tier — see
the in-repo `intonatissimo` skill if you hold that entitlement. Without it, the public path is:
drive the backend, roll the mock, validate the seam.

## Verification contract

A script authored on this skill must emit: the backend/experiment constructed, the measurement
model, and — for the mock — evidence the loop ran (per-iteration measurement + a faithfulness
check that compares the mock at the knot's time against a direct `SimulatedExperiment` — not
a readout-vs-`dac_rate` trend at a fixed index). Keep the script self-contained (inline the constants;
no `include` of demo-repo files).

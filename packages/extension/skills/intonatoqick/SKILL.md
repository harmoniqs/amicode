---
name: intonatoqick
description: Drive the public IntonatoQICK.jl QICK/RFSoC hardware backend — mock loop, channel map, measurement model, and composing a QickExperiment into Intonato's closed-loop chassis. Use when running or testing quantum optimal control on QICK hardware (or its pure-Julia mock).
agents: [experimenter, engineer]
surface: public
---

# IntonatoQICK — the public QICK hardware backend

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

ptp = PulseTuningProblem(qcp, qexp, model; R_tr = (u = 0.1,), Q_meas = 10.0)
solve!(ptp; max_iter = 10)
```

- `dac_rate` is the mock DAC grid; readout converges to the continuum as it rises (translation
  is faithful, not lossy) — it is not bit-identical to a coarse-knot direct sim.
- Swap `MockQickSoc` → `PyQickSoc` for a real board; nothing else in the loop changes.

## The tuning strategy is where public stops

`PulseTuningProblem` runs with the **public no-op `IdentityStrategy`** by default — the chassis
composes and the loop *runs* through the seam, but a no-op tuner does not drive convergence.
**Algorithmic convergence** (matching hardware measurements iteration-over-iteration) needs a
concrete tuning strategy, which ships as the **entitlement-gated** `intonatissimo` tier — see
the in-repo `intonatissimo` skill if you hold that entitlement. Without it, the public path is:
drive the backend, roll the mock, validate the seam.

## Verification contract

A script authored on this skill must emit: the backend/experiment constructed, the measurement
model, and — for the mock — evidence the loop ran (per-iteration measurement + a convergence or
faithfulness check as `dac_rate` rises). Keep the script self-contained (inline the constants;
no `include` of demo-repo files).

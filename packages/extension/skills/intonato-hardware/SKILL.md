---
name: intonato-hardware
description: Drive QICK/RFSoC hardware through Intonato's public hardware seam — the board-free MockSoc loop, the QICK channel map, the measurement model, composing StrumentoBackend/StrumentoExperiment into the PulseTuningProblem chassis, and real-board delegation to Python strumento. Use when running or testing closed-loop quantum optimal control on QICK hardware (or its pure-Julia mock).
agents: [experimenter, engineer]
surface: public
revision: 1
---

# Intonato hardware — the public QICK path

> **Provenance:** salvaged from `harmoniqs/amico-plugin` PR #42 (repo archived
> 2026-08-26) — ruled SALVAGE in amicode#850, ported in amicode#851 as `intonatoqick`;
> rewritten for Intonato's own hardware seam in amicode#2024, after the standalone Julia
> QICK backend package was archived.

Intonato bridges a `PulseTuningProblem` (closed-loop optimal control) to a
[QICK](https://github.com/openquantumhardware/qick) RFSoC board. Everything on the public
path comes from **one import, `using Intonato`**: the soc contract, the QICK channel map, the
board-free `MockSoc`, and the hardware seam `StrumentoBackend` / `StrumentoExperiment`. The
real board is reached by **delegating to the Python `strumento` package** (the `StrumentoSoc`
soc, loaded through PythonCall). There is no separate Julia QICK package to install: the
former standalone backend is archived, and the intermediate Strumento.jl is being retired into
Intonato (harmoniqs/Intonato.jl#53). Do not add either to an environment.

The names below are exported by Intonato **0.4** (registered) and **0.5** (the Strumento.jl
retirement) alike. Where the two versions differ, this card says so.

**Boundary (why it's this shape):** the hardware interface is deliberately **coarse** — the
four backend verbs `upload_pulse!` / `trigger!` / `readout` / `sample_rate`, pulse-in /
IQ-out. A soc implements one verb, `execute!`. All tProc-v2 specifics (multiplexed or dynamic
readout, `AveragerProgramV2`, sweeps) live on the **board (Python) side**, so the Julia seam is
"just a transport." Author to the backend verbs; do not push board specifics into Julia.

**Sibling skills** (reference, don't duplicate here): **hardware-loop** owns the full
closed-loop path to a board — MockSoc-first validation, real-board delegation and its gaps,
records, and the unattended-loop safety gates; **strumento** owns the board-side tProc-v2
experiment framework (Python) itself; **intonatissimo** is the entitled tuning-strategy tier
(below). This skill stays at Intonato's hardware seam.

## Core types

| Name | Role |
|---|---|
| `AbstractSoc` | the soc contract: `execute!`, `load_envelope!`, `play_program!`, `acquire`, `dac_rate`, `adc_rate` |
| `MockSoc(system, ψ_init, ψ_goal; measurement_fn = populations, dac_rate = 1.0, adc_rate = 1.0)` | pure-Julia "board": rolls the played pulse through a known `QuantumSystem` and emits synthetic IQ (`measurement_fn(state)` packed as complex, inverted exactly by `real`). The whole loop runs with **no Python and no hardware** |
| `QickGenChannel(gen_ch, carrier_freq; i_drive, q_drive = nothing)` | one generator channel: Piccolo drive `i_drive` (and optional `q_drive`) on gen channel `gen_ch`, up-converted at `carrier_freq` (Hz). A phase-modulated drive is I+Q on **one** channel |
| `QickChannelMap(channels; readout_chs = [0], n_drives)` | validated device policy: drive → gen channel. Drive indices must be in `1:n_drives`, mapped once; gen channels distinct |
| `StrumentoBackend(soc, channel_map, indices; discriminator = b -> real.(b))` | the `AbstractHardwareBackend` over any `AbstractSoc`. `indices` are the measured knot indices; `discriminator` maps one IQ blob to a data vector (the default matches `MockSoc`) |
| `StrumentoExperiment(backend; measurement_model)` | returns an Intonato `HardwareExperiment`, which you drop into `PulseTuningProblem` |
| `StrumentoSoc` | the real board: hands the pulse to Python `strumento` (pulse IR → `AveragerProgramV2` → acquire → averaged IQ). Lives in a PythonCall package extension (below) |

The package owns the **mechanism**. The channel map and the discriminator (IQ → state) are
**your device policy**, caller-supplied. `StrumentoSoc` ignores the channel map (Python
`strumento` routes through its own `Device` wiring), so the map may be a trivial one there.

## Usage (mock — the default dev/test path)

This mirrors Intonato's own seam integration test (`src/hardware/integration_test.jl`) and
runs as written on Intonato 0.4 and 0.5 (amicode#2024 ran it on both; same `J_exp`):

```julia
using Intonato, LinearAlgebra, Random
Random.seed!(42)
σx = ComplexF64[0 1; 1 0]; σz = ComplexF64[1 0; 0 -1]
sys_nom  = QuantumSystem(1.0 * σz, [σx], [1.0])
sys_true = QuantumSystem(1.1 * σz, [σx], [1.0])   # the model mismatch the "hardware" has
N = 11; T = 5.0
times = collect(range(0.0, T, length = N))
ψ0 = ComplexF64[1, 0]; ψg = ComplexF64[0, 1]

# Nominal problem on the nominal model.
qcp = SplinePulseProblem(
    KetTrajectory(sys_nom, LinearSplinePulse(0.1 .* randn(1, N), times), ψ0, ψg), N;
    Q = 100.0, R = 1e-2)
solve!(qcp; max_iter = 200, verbose = false, print_level = 0)

# The "board" holds the TRUE dynamics.
model = MeasurementModel(:ψ̃, [populations], [N])
soc   = MockSoc(sys_true, ψ0, ψg; dac_rate = 80.0)
map   = QickChannelMap([QickGenChannel(0, 5e9; i_drive = 1)]; n_drives = 1)
qexp  = StrumentoExperiment(StrumentoBackend(soc, map, [N]); measurement_model = model)

ptp = PulseTuningProblem(qcp, qexp, model)   # IdentityStrategy by default
solve!(ptp; max_iter = 3, verbose = false,
       ipopt_options = (max_iter = 200, verbose = false, print_level = 0))
ptp.result.history[1].J_exp                  # > 0: the mismatch is measured through the seam
```

- `dac_rate` is the mock DAC grid. Readout converges to the continuum as it rises (the
  translation is faithful, not lossy), but it is not bit-identical to a coarse-knot direct
  simulation. Intonato's test checks 40 → 160 → 320 with successive refinements closing in.
- Swap `MockSoc` for `StrumentoSoc` (below) for a real board; nothing else in the loop
  changes.
- Do not pass `R_tr` / `Q_meas` to `PulseTuningProblem`. They are deprecated and unused (on
  0.4 they only warn): trust-region weighting belongs to the strategy (Intonatissimo's
  subproblem constructors take `R_tr`) and task weighting to the whitening `W_task`.
- `MockSoc` rolls out a ket and ignores dissipators (tracked in harmoniqs/Intonato.jl#51).

## Real board — delegation to Python strumento

`StrumentoSoc` is defined in a **package extension** that loads when PythonCall is loaded.
Extension types never surface on the parent module, so reach the type through the extension
module. On Intonato 0.5:

```julia
using Intonato, PythonCall
ext = Base.get_extension(Intonato, :IntonatoPythonCallExt)
soc = ext.StrumentoSoc("device.yaml"; drive_map = [(1, "qubit", "drive", 4000.0)],
                       dac_rate = 599.04, adc_rate = 599.04,
                       board = qick_soc)   # a qick soc, or strumento's MockQickSocV2
qexp = StrumentoExperiment(StrumentoBackend(soc, map, [N]); measurement_model = model)
```

- Python `strumento` (and `qick`) must be installed in the interpreter PythonCall uses;
  Intonato declares no Python dependencies. To reuse an existing environment, set
  `JULIA_CONDAPKG_BACKEND=Null` and `JULIA_PYTHONCALL_EXE=/path/to/python`. Without
  PythonCall, Intonato loads with no Python at all.
- **Intonato 0.4:** the same soc, with the same constructor, lives in the PythonCall
  extension of the substrate 0.4 still depends on. Reach it as
  `Base.get_extension(Intonato.Strumento, :StrumentoPythonCallExt)` without adding that
  substrate to your own environment (it is being retired); moving to 0.5 removes the detour.
- The example numbers (`599.04` DAC/ADC rate, the `4000.0` drive entry) come from Intonato's
  README and extension test fixture. They are placeholders for your board, not a calibration.

## The tuning strategy is where public stops

`PulseTuningProblem` runs with the **public no-op `IdentityStrategy`** by default — the chassis
composes and the loop *runs* through the seam, but a no-op tuner does not drive convergence.
Intonato also ships one **public** concrete strategy: `LowRankHessianStrategy` — measured-gradient
Newton in the low-rank principal subspace of the model-cost Hessian, where the device model
supplies the directions/curvatures and the gradient is measured on the device by central finite
differences along each direction. **Algorithmic convergence** (matching hardware measurements
iteration-over-iteration) beyond that needs a concrete tuning strategy, which ships as the
**entitlement-gated** `intonatissimo` tier — see the in-repo `intonatissimo` skill if you hold
that entitlement. Without it, the public path is: drive the backend, roll the mock, validate
the seam.

## Verification contract

A script authored on this skill must emit: the backend/experiment constructed, the measurement
model, and — for the mock — evidence the loop ran (per-iteration measurement + a convergence or
faithfulness check as `dac_rate` rises). Keep the script self-contained (inline the constants;
no `include` of demo-repo files).

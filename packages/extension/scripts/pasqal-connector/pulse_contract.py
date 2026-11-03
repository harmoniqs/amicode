"""The Piccolo→Pulser pulse contract.

Single source of truth for how a solved pulse (pulse.toml, written by
solve_x_gate.jl) becomes a validated Pulser Sequence. Both consumers —
translate_and_simulate.py (local sim) and submit_optimized.py (cloud) —
import from here, so the validation story cannot drift between them.

Design rules:
- Device limits are read from the pulser Device object at call time, never
  hardcoded, so a device-spec update propagates automatically.
- Numerical dust (optimizer sitting on a bound, ~1e-9) is clipped silently;
  real constraint violations RAISE. A bad solve must fail loudly here, not
  get silently squashed to the bound and submitted as if it were fine.
- Unknown TOML keys are ignored (additive schema policy, matching the
  amicode scores/run-dir contracts). `schema_version` is checked exactly.
- Optional `atoms = [[x, y], ...]` (µm) sets the register; absent = one atom.
  Optional `layout` ("calibrated", or a calibrated layout's name) places each
  atom on a trap of the device's calibrated RegisterLayout and keeps that
  layout on the built register — AnalogDevice needs it for QPU submission.
  Min-distance checks use Pulser's own 10^-COORD_PRECISION tolerance.
"""

import math
import tomllib
import warnings

import numpy as np
import pulser

try:  # Pulser's own coordinate precision (decimal places); 6 in pulser 1.x
    from pulser.register.traps import COORD_PRECISION
except ImportError:  # pragma: no cover - defensive against a private-module move
    COORD_PRECISION = 6

SCHEMA_VERSION = 1
UNITS = "rad/us"

# Anything beyond this (rad/µs) is a real violation, not optimizer dust.
# Bound-riding dust from Ipopt is ~1e-9 rad/µs; physical violations from a
# bad solve are orders of magnitude larger.
DUST_TOL = 1e-6

# Endpoints are "at idle" when both drives sit at Ω=Δ=0 to within the same
# dust tolerance the bounds checks use.
IDLE_TOL = DUST_TOL

# Pulser validates atom distances with this tolerance (device._validate_atom_
# distance): a pair is too close only if it falls short of min_atom_distance by
# MORE than 10^-COORD_PRECISION. The calibrated layout's own 5 µm triangle
# rounds to 4.9999999836 µm, so a strict `<` rejects what Pulser accepts.
DISTANCE_TOL = 10 ** (-COORD_PRECISION)

# How far (µm) an `atoms` entry may sit from a layout trap and still count as
# that trap. Generous vs. float dust (~1e-8), tiny vs. any real lattice spacing.
TRAP_SNAP_TOL = 1e-3

# `layout = "calibrated"` selects the device's calibrated register layout.
CALIBRATED_LAYOUT = "calibrated"


class ContractError(ValueError):
    """A pulse violates the Piccolo→Pulser contract. Message says how."""


class NonIdleEndpointsWarning(UserWarning):
    """The pulse does not return both drives to idle (Ω=Δ=0) at its endpoints."""


def load_knots(path: str) -> dict:
    """Read pulse.toml and validate its structure (device-independent)."""
    with open(path, "rb") as f:
        data = tomllib.load(f)
    validate_schema(data)
    return data


def validate_schema(data: dict) -> None:
    version = data.get("schema_version")
    if version != SCHEMA_VERSION:
        raise ContractError(
            f"schema_version must be {SCHEMA_VERSION}, got {version!r} "
            "(re-run the solve with a matching solve_x_gate.jl)"
        )
    if data.get("units") != UNITS:
        raise ContractError(f"units must be {UNITS!r}, got {data.get('units')!r}")

    dt = data.get("dt_ns")
    if not isinstance(dt, (int, float)) or not math.isfinite(dt) or dt <= 0:
        raise ContractError(f"dt_ns must be a positive finite number, got {dt!r}")

    n = data.get("n_knots")
    if not isinstance(n, int) or n < 2:
        raise ContractError(f"n_knots must be an integer >= 2, got {n!r}")

    for key in ("amplitude", "detuning"):
        values = data.get(key)
        if not isinstance(values, list) or len(values) != n:
            raise ContractError(
                f"{key} must be a list of length n_knots={n}, "
                f"got length {len(values) if isinstance(values, list) else 'N/A'}"
            )
        if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in values):
            raise ContractError(f"{key} contains non-finite or non-numeric values")

    fid = data.get("fidelity")
    if fid is not None and not (isinstance(fid, (int, float)) and 0.0 <= fid <= 1.0):
        raise ContractError(f"fidelity, if present, must be in [0, 1], got {fid!r}")

    atoms = data.get("atoms")
    if atoms is not None:
        if not isinstance(atoms, list) or len(atoms) < 1:
            raise ContractError(f"atoms, if present, must be a non-empty list of [x, y] pairs")
        for i, pos in enumerate(atoms):
            if (
                not isinstance(pos, list)
                or len(pos) != 2
                or not all(isinstance(c, (int, float)) and math.isfinite(c) for c in pos)
            ):
                raise ContractError(f"atoms[{i}] must be a finite [x, y] pair (µm), got {pos!r}")

    layout = data.get("layout")
    if layout is not None:
        if not isinstance(layout, str) or not layout.strip():
            raise ContractError(
                f"layout, if present, must be a non-empty string naming a calibrated "
                f"register layout (or {CALIBRATED_LAYOUT!r}), got {layout!r}"
            )
        if atoms is None:
            raise ContractError("layout requires atoms: each atom is placed on a layout trap")


def validate_against_device(
    data: dict, device: pulser.devices.Device = pulser.AnalogDevice,
    channel_name: str = "rydberg_global",
) -> None:
    """Check the pulse against the target device's published limits."""
    if channel_name not in device.channels:
        raise ContractError(
            f"device {device.name} has no channel {channel_name!r} "
            f"(has: {list(device.channels)})"
        )
    channel = device.channels[channel_name]

    dt = data["dt_ns"]
    if dt != int(dt) or int(dt) % channel.clock_period != 0:
        raise ContractError(
            f"dt_ns={dt} must be an integer multiple of the channel clock "
            f"period ({channel.clock_period} ns)"
        )

    duration = (data["n_knots"] - 1) * int(dt)
    if duration < channel.min_duration:
        raise ContractError(
            f"pulse duration {duration} ns is below the channel minimum "
            f"({channel.min_duration} ns)"
        )
    max_seq = device.max_sequence_duration
    if max_seq is not None and duration > max_seq:
        raise ContractError(
            f"pulse duration {duration} ns exceeds the device's max sequence "
            f"duration ({max_seq} ns)"
        )

    _check_bounds("amplitude", data["amplitude"], 0.0, channel.max_amp)
    _check_bounds(
        "detuning", data["detuning"],
        -channel.max_abs_detuning, channel.max_abs_detuning,
    )

    atoms = data.get("atoms")
    if atoms is not None:
        max_atoms = device.max_atom_num
        if max_atoms is not None and len(atoms) > max_atoms:
            raise ContractError(
                f"{len(atoms)} atoms exceeds the device's max atom number ({max_atoms})"
            )
        for i in range(len(atoms)):
            for j in range(i + 1, len(atoms)):
                dist = math.dist(atoms[i], atoms[j])
                if _too_close(dist, device.min_atom_distance):
                    raise ContractError(
                        f"atoms[{i}] and atoms[{j}] are {dist:.3g} µm apart — below the "
                        f"device's minimum atom distance ({device.min_atom_distance} µm)"
                    )

        if data.get("layout") is not None:
            resolve_layout(data, device)  # raises ContractError on any mismatch

    warn_non_idle_endpoints(data)


def _too_close(dist: float, min_distance: float) -> bool:
    """Pulser's own too-close test, tolerance included (see DISTANCE_TOL)."""
    return dist - min_distance < -DISTANCE_TOL or dist < DISTANCE_TOL


def resolve_layout(data: dict, device: pulser.devices.Device):
    """`layout` + `atoms` → (calibrated RegisterLayout, trap ids, one per atom).

    The layout must be one of the device's calibrated layouts (AnalogDevice
    requires a calibrated layout for QPU submission). Each atom must sit on a
    distinct trap, to within TRAP_SNAP_TOL µm; the register is then built from
    the traps themselves so Pulser's exact trap-coordinate check holds.
    """
    name = data["layout"]
    calibrated = dict(getattr(device, "calibrated_register_layouts", None) or {})
    if name == CALIBRATED_LAYOUT:
        if len(calibrated) != 1:
            raise ContractError(
                f"layout {CALIBRATED_LAYOUT!r} is ambiguous on {device.name}: it has "
                f"{len(calibrated)} calibrated layouts ({sorted(calibrated)}); name one"
            )
        layout = next(iter(calibrated.values()))
    elif name in calibrated:
        layout = calibrated[name]
    else:
        raise ContractError(
            f"layout {name!r} is not a calibrated layout of {device.name} "
            f"(use {CALIBRATED_LAYOUT!r} or one of: {sorted(calibrated)})"
        )

    traps = np.asarray(layout.coords, dtype=float)
    trap_ids = []
    for i, pos in enumerate(data["atoms"]):
        dists = np.linalg.norm(traps - np.asarray(pos, dtype=float), axis=1)
        trap = int(np.argmin(dists))
        if dists[trap] > TRAP_SNAP_TOL:
            raise ContractError(
                f"atoms[{i}] = {list(pos)} is {dists[trap]:.3g} µm from the nearest trap of "
                f"layout {name!r} (must be within {TRAP_SNAP_TOL:g} µm of a trap)"
            )
        trap_ids.append(trap)
    if len(set(trap_ids)) != len(trap_ids):
        raise ContractError(f"atoms must sit on distinct traps of layout {name!r}")
    return layout, trap_ids


def warn_non_idle_endpoints(data: dict) -> None:
    """Warn (never reject) when the pulse's endpoints are not idle (S-19/S-20,
    campaign pasqal-gate-autoresearch).

    The contract validates duration/amplitude/atoms — this is the missing
    return-to-idle check. A pulse that ends mid-drive is an incomplete
    hardware gate: the channel plays the tail, and the free endpoint can
    absorb phase the device never sees. Measured (H17): pinning endpoints to
    zero cost nothing in the solve and PAID on both legs (ΔF_emu up to
    +1.7e-3, ΔF_mod up to +0.039) — clamping removes the ending transient the
    output-modulation filter is still settling. So: warn loudly, reject
    nothing; existing valid pulses keep validating.
    """
    offenders = []
    for key in ("amplitude", "detuning"):
        values = data.get(key)
        if not isinstance(values, list) or len(values) < 2:
            continue  # structural validation reports malformed arrays itself
        for index in (0, len(values) - 1):
            if abs(values[index]) > IDLE_TOL:
                offenders.append(f"{key}[{index}] = {values[index]:.6g} rad/us")
    if offenders:
        warnings.warn(
            "pulse does not return to idle (Ω=Δ=0) at its endpoints: "
            + "; ".join(offenders)
            + " — the channel plays this tail mid-drive, so the emitted gate is "
            "incomplete. Re-solve with initial_value/final_value pinned to zero "
            "(measured: the clamp costs nothing and improves both legs; "
            "campaign pasqal-gate-autoresearch H17).",
            NonIdleEndpointsWarning,
            stacklevel=2,
        )


def _check_bounds(name: str, values: list, lo: float, hi: float) -> None:
    arr = np.asarray(values, dtype=float)
    worst_low = float((lo - arr).max(initial=0.0))
    worst_high = float((arr - hi).max(initial=0.0))
    worst = max(worst_low, worst_high)
    if worst > DUST_TOL:
        index = int(np.argmax(np.maximum(lo - arr, arr - hi)))
        raise ContractError(
            f"{name}[{index}] = {arr[index]:.6g} violates bounds "
            f"[{lo:.6g}, {hi:.6g}] by {worst:.3g} rad/us — this is a bad "
            f"solve, not numerical dust (tolerance {DUST_TOL:g}); refusing "
            "to clip it silently"
        )


def zero_order_hold(knots: list, dt_ns: float) -> np.ndarray:
    """Expand N knot values (N-1 intervals of dt_ns each) to 1 ns samples."""
    per_knot = int(round(dt_ns))
    return np.repeat(np.asarray(knots[:-1], dtype=float), per_knot)


def build_sequence(
    data: dict, device: pulser.devices.Device = pulser.AnalogDevice,
    channel_name: str = "rydberg_global",
) -> pulser.Sequence:
    """Validated pulse.toml dict → measured single-atom Pulser Sequence.

    Raises ContractError on any real constraint violation; clips only
    sub-DUST_TOL numerical dust. Pulser's own Sequence validation still runs
    underneath as a second, independent line of defense.
    """
    validate_schema(data)
    validate_against_device(data, device, channel_name)
    channel = device.channels[channel_name]

    amp = zero_order_hold(data["amplitude"], data["dt_ns"])
    det = zero_order_hold(data["detuning"], data["dt_ns"])
    amp = np.clip(amp, 0.0, channel.max_amp)          # dust only, per above
    det = np.clip(det, -channel.max_abs_detuning, channel.max_abs_detuning)

    if data.get("layout") is not None:
        # keep the layout: the register is defined from the layout's own traps
        layout, trap_ids = resolve_layout(data, device)
        register = layout.define_register(
            *trap_ids, qubit_ids=[f"q{i}" for i in range(len(trap_ids))]
        )
    else:
        coords = [tuple(pos) for pos in data.get("atoms", [[0, 0]])]
        register = pulser.Register.from_coordinates(coords, prefix="q")
    sequence = pulser.Sequence(register, device)
    sequence.declare_channel(channel_name, channel_name)
    pulse = pulser.Pulse(
        pulser.CustomWaveform(amp),
        pulser.CustomWaveform(det),
        phase=0.0,
    )
    sequence.add(pulse, channel_name)
    sequence.measure()
    return sequence

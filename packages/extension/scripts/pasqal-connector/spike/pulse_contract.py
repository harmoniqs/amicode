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
"""

import math
import tomllib

import numpy as np
import pulser

SCHEMA_VERSION = 1
UNITS = "rad/us"

# Anything beyond this (rad/µs) is a real violation, not optimizer dust.
# Bound-riding dust from Ipopt is ~1e-9 rad/µs; physical violations from a
# bad solve are orders of magnitude larger.
DUST_TOL = 1e-6


class ContractError(ValueError):
    """A pulse violates the Piccolo→Pulser contract. Message says how."""


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
                if dist < device.min_atom_distance:
                    raise ContractError(
                        f"atoms[{i}] and atoms[{j}] are {dist:.3g} µm apart — below the "
                        f"device's minimum atom distance ({device.min_atom_distance} µm)"
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

#!/usr/bin/env python3
"""Milestone 1: prove the physical connection to Pasqal Cloud works.

Builds the simplest possible Pulser sequence (one atom, one constant pulse) and
submits it to Pasqal Cloud's free EMU_FREE emulator. This is a connectivity
test, not a real gate — no Piccolo pulse translation happens here.

Credentials are read from environment variables ONLY (never from argv, never
written to disk): PASQAL_USERNAME, PASQAL_PASSWORD, PASQAL_PROJECT_ID. The
caller (Amico, via bash) is expected to set these for this invocation alone.
"""

import os
import sys

import pulser
from pasqal_cloud import PasqalCloudConnection, RemoteEmuFreeBackend
from pasqal_cloud.authentication import TokenProviderError


def _require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"error: missing required environment variable {name}", file=sys.stderr)
        sys.exit(1)
    return value


def build_test_sequence() -> pulser.Sequence:
    register = pulser.Register.from_coordinates([(0, 0)], prefix="q")
    sequence = pulser.Sequence(register, pulser.AnalogDevice)
    sequence.declare_channel("rydberg_global", "rydberg_global")
    pulse = pulser.Pulse.ConstantPulse(duration=100, amplitude=1.0, detuning=0.0, phase=0.0)
    sequence.add(pulse, "rydberg_global")
    return sequence


def main() -> None:
    username = _require_env("PASQAL_USERNAME")
    password = _require_env("PASQAL_PASSWORD")
    project_id = _require_env("PASQAL_PROJECT_ID")

    sequence = build_test_sequence()
    print("Built test sequence: 1 atom, 100ns constant pulse, rydberg_global channel.")

    try:
        connection = PasqalCloudConnection(username=username, password=password, project_id=project_id)
    except TokenProviderError as exc:
        print(f"error: Pasqal Cloud authentication failed: {exc}", file=sys.stderr)
        sys.exit(1)

    backend = RemoteEmuFreeBackend(sequence, connection=connection)

    print("Submitting to Pasqal Cloud (EMU_FREE)...")
    try:
        results = backend.run(wait=True)
    except Exception as exc:  # noqa: BLE001 - surface any submission failure plainly
        print(f"error: Pasqal Cloud submission failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print("Job finished.")
    print(f"Result type: {type(results).__name__}")
    print(results)


if __name__ == "__main__":
    main()

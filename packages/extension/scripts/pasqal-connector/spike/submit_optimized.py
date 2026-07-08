#!/usr/bin/env python3
"""Submit the optimized X-gate pulse to Pasqal Cloud EMU_FREE.

Loads pulse.toml, rebuilds the validated Pulser Sequence via the shared pulse
contract, and submits it. Credentials come from env vars only
(PASQAL_USERNAME / PASQAL_PASSWORD / PASQAL_PROJECT_ID) — never argv, never
disk.

Usage:
    python3 submit_optimized.py [path/to/pulse.toml] [--dry-run]

--dry-run builds and validates the sequence, then exits 0 without touching
the network (no credentials needed) — the harness uses this to exercise the
submission path hermetically.
"""

import os
import sys

from pasqal_cloud import PasqalCloudConnection, RemoteEmuFreeBackend
from pasqal_cloud.authentication import TokenProviderError

from pulse_contract import ContractError, build_sequence, load_knots


def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--dry-run"]
    dry_run = "--dry-run" in sys.argv[1:]
    path = args[0] if args else "pulse.toml"

    try:
        data = load_knots(path)
        print(f"Loaded {data['n_knots']} knots, dt={data['dt_ns']}ns, "
              f"solve fidelity={data.get('fidelity', float('nan')):.8f}")
        sequence = build_sequence(data)
    except ContractError as exc:
        print(f"error: invalid pulse: {exc}", file=sys.stderr)
        sys.exit(1)
    print(f"Sequence validated against {sequence.device.name} "
          f"(duration {sequence.get_duration()}ns).")

    if dry_run:
        print("DRY RUN: sequence built and validated; skipping submission.")
        sys.exit(0)

    username = os.environ.get("PASQAL_USERNAME", "")
    password = os.environ.get("PASQAL_PASSWORD", "")
    project_id = os.environ.get("PASQAL_PROJECT_ID", "")
    if not all([username, password, project_id]):
        print("error: missing PASQAL_USERNAME / PASQAL_PASSWORD / "
              "PASQAL_PROJECT_ID", file=sys.stderr)
        sys.exit(1)

    try:
        connection = PasqalCloudConnection(
            username=username, password=password, project_id=project_id
        )
    except TokenProviderError as exc:
        print(f"error: Pasqal Cloud authentication failed: {exc}", file=sys.stderr)
        sys.exit(1)

    backend = RemoteEmuFreeBackend(sequence, connection=connection)

    print("Submitting optimized pulse to Pasqal Cloud (EMU_FREE)...")
    try:
        results = backend.run(wait=True)
    except Exception as exc:  # noqa: BLE001 - surface any submission failure plainly
        print(f"error: submission failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print("Job finished.")
    print(f"Result type: {type(results).__name__}")
    print(results)


if __name__ == "__main__":
    main()

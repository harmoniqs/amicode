#!/usr/bin/env python3
"""Submit the optimized X-gate pulse to Pasqal Cloud EMU_FREE."""

import os
import sys

from pasqal_cloud import PasqalCloudConnection, RemoteEmuFreeBackend
from pasqal_cloud.authentication import TokenProviderError

from translate_and_simulate import load_knots, build_sequence


def main() -> None:
    username = os.environ.get("PASQAL_USERNAME", "")
    password = os.environ.get("PASQAL_PASSWORD", "")
    project_id = os.environ.get("PASQAL_PROJECT_ID", "")
    if not all([username, password, project_id]):
        print("error: missing PASQAL_USERNAME / PASQAL_PASSWORD / PASQAL_PROJECT_ID", file=sys.stderr)
        sys.exit(1)

    path = sys.argv[1] if len(sys.argv) > 1 else "pulse.toml"
    data = load_knots(path)
    print(f"Loaded {data['n_knots']} knots, dt={data['dt_ns']}ns, solve fidelity={data['fidelity']:.8f}")

    sequence = build_sequence(data)
    print(f"Sequence validated against {sequence.device.name} (duration {sequence.get_duration()}ns).")

    try:
        connection = PasqalCloudConnection(username=username, password=password, project_id=project_id)
    except TokenProviderError as exc:
        print(f"error: Pasqal Cloud authentication failed: {exc}", file=sys.stderr)
        sys.exit(1)

    backend = RemoteEmuFreeBackend(sequence, connection=connection)

    print("Submitting optimized pulse to Pasqal Cloud (EMU_FREE)...")
    try:
        results = backend.run(wait=True)
    except Exception as exc:
        print(f"error: submission failed: {exc}", file=sys.stderr)
        sys.exit(1)

    print("Job finished.")
    print(f"Result type: {type(results).__name__}")
    print(results)


if __name__ == "__main__":
    main()

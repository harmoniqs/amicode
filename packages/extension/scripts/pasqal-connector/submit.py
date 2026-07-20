#!/usr/bin/env python3
"""Submit an optimized pulse to a Pasqal Cloud device — the #160 device path.

The `amico-pasqal` launcher (#168) invokes this connector with the runtime
credential in ENV ONLY: PASQAL_TOKEN + PASQAL_PROJECT_ID. There is NO
username/password anywhere in this flow (ADR 0001, AC3): the token was minted
at key-entry by the Connections panel and persisted token-only; here we
authenticate through the SDK's token-provider mechanism using that stored
token. The token never rides argv and never reaches an output stream — every
failure message is a fixed string, exception text (which can echo a bearer
token) is never printed.

Usage:
    python3 submit.py <pulse.toml> [--device <id>] [--yes] [--dry-run]

  --device <id>   target Pasqal device (default: EMU_FREE, the free emulator).
                  Selection is per-submission and explicit at the product
                  surface; this default only ever picks the FREE device, never
                  a paid one — there is no auto-fallback to a paid target.
  --yes           acknowledge a NON-FREE (paid emulator / real QPU) submission.
                  Refused without it (AC5, defense in depth); the product's
                  device-path verb adds it only after its digest-confirm gate.
  --dry-run       build + validate the sequence, then exit 0 WITHOUT touching
                  credentials or the network (hermetic path exercise).

Exit codes: 0 success/dry-run · 1 bad pulse / missing token / refused gate /
submission failure.
"""

import os
import sys

from pulse_contract import ContractError, build_sequence, load_knots

# The one free target. Everything else — EMU_TN, EMU_MPS, EMU_SV, FRESNEL
# (QPU), any future name — is treated as NON-FREE (default-deny), so an
# unknown device can never slip past the paid-submission gate.
FREE_DEVICES = frozenset({"EMU_FREE"})

# device id -> (backend attribute on pasqal_cloud, is_free). Real-QPU job
# management is out of scope for #160 (issue Scope: Out); the emulator
# backends are what the free-emulator-first device path submits to.
DEVICE_BACKENDS = {
    "EMU_FREE": ("RemoteEmuFreeBackend", True),
    "EMU_MPS": ("RemoteMPSBackend", False),
    "EMU_TN": ("RemoteSVBackend", False),
    "EMU_SV": ("RemoteSVBackend", False),
}

DEFAULT_DEVICE = "EMU_FREE"

MSG_AUTH_FAILURE = "error: Pasqal Cloud authentication failed"
MSG_NETWORK_FAILURE = "error: Pasqal Cloud is unreachable (network failure)"
MSG_SUBMIT_FAILURE = "error: submission to Pasqal Cloud failed"


def _parse_args(argv):
    device = DEFAULT_DEVICE
    yes = False
    dry_run = False
    positional = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--dry-run":
            dry_run = True
        elif arg == "--yes":
            yes = True
        elif arg == "--device":
            i += 1
            if i >= len(argv):
                print("error: --device requires a device id", file=sys.stderr)
                sys.exit(1)
            device = argv[i]
        elif arg.startswith("--device="):
            device = arg.split("=", 1)[1]
        else:
            positional.append(arg)
        i += 1
    path = positional[0] if positional else "pulse.toml"
    return path, device, yes, dry_run


def is_free_device(device: str) -> bool:
    return device in FREE_DEVICES


def _is_network_error(exc: BaseException) -> bool:
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    name = type(exc).__name__
    return any(hint in name for hint in ("Connection", "Timeout", "Network", "Unreachable"))


def main(argv=None) -> None:
    argv = list(sys.argv[1:] if argv is None else argv)
    path, device, yes, dry_run = _parse_args(argv)

    # 1. Build + validate the pulse (device-independent contract). A bad solve
    #    fails loudly here, before anything touches credentials or the network.
    try:
        data = load_knots(path)
        sequence = build_sequence(data)
    except FileNotFoundError:
        print(f"error: pulse file not found: {path}", file=sys.stderr)
        sys.exit(1)
    except ContractError as exc:
        print(f"error: invalid pulse: {exc}", file=sys.stderr)
        sys.exit(1)

    fidelity = data.get("fidelity")
    fid = f"{fidelity:.8f}" if isinstance(fidelity, (int, float)) else "n/a"
    print(
        f"Loaded {data['n_knots']} knots (dt={data['dt_ns']}ns, solve fidelity={fid}); "
        f"sequence validated against {sequence.device.name} "
        f"(duration {sequence.get_duration()}ns), target device {device}."
    )

    if dry_run:
        print("DRY RUN: sequence built and validated; skipping submission.")
        sys.exit(0)

    # 2. Resolve the target backend.
    entry = DEVICE_BACKENDS.get(device)
    if entry is None:
        print(
            f"error: device {device!r} is not supported by this connector build "
            "(real-QPU job management is out of scope for #160)",
            file=sys.stderr,
        )
        sys.exit(1)
    backend_attr, free = entry

    # 3. The paid-submission gate (AC5, defense in depth) — BEFORE any auth or
    #    network. A non-free target requires an explicit --yes acknowledgment;
    #    there is no auto-fallback to a paid device.
    if not free and not yes:
        print(
            f"error: refusing to submit to non-free device {device!r} without --yes "
            "(paid/hardware submission requires explicit confirmation)",
            file=sys.stderr,
        )
        sys.exit(1)

    # 4. The runtime credential: token ONLY, from the launcher's env injection.
    token = os.environ.get("PASQAL_TOKEN", "")
    project_id = os.environ.get("PASQAL_PROJECT_ID", "")
    if not token:
        print("error: missing PASQAL_TOKEN (reconnect Pasqal in the Connections panel)", file=sys.stderr)
        sys.exit(1)
    if not project_id:
        print("error: missing PASQAL_PROJECT_ID (reconnect Pasqal in the Connections panel)", file=sys.stderr)
        sys.exit(1)

    # Imported lazily so the pulse/gate lanes above stay independent of the SDK
    # and so tests can pre-inject a stub. Missing SDK renders distinctly.
    try:
        import pasqal_cloud
        from pasqal_cloud.authentication import TokenProvider, TokenProviderError
    except ImportError:
        print(f"error: the pasqal-cloud SDK is not installed for {sys.executable}", file=sys.stderr)
        sys.exit(1)

    # Authenticate via the SDK's token-provider mechanism using the STORED
    # token (AC3). No password is ever constructed or passed.
    class _StoredTokenProvider(TokenProvider):
        def __init__(self, bearer: str):
            self._bearer = bearer

        def get_token(self) -> str:
            return self._bearer

    try:
        connection = pasqal_cloud.PasqalCloudConnection(
            project_id=project_id, token_provider=_StoredTokenProvider(token)
        )
    except TokenProviderError:
        print(MSG_AUTH_FAILURE, file=sys.stderr)  # fixed string: never echo exception text
        sys.exit(1)
    except Exception as exc:  # noqa: BLE001 - classified, never echoed
        print(MSG_NETWORK_FAILURE if _is_network_error(exc) else MSG_AUTH_FAILURE, file=sys.stderr)
        sys.exit(1)

    backend_cls = getattr(pasqal_cloud, backend_attr)
    backend = backend_cls(sequence, connection=connection)

    print(f"Submitting optimized pulse to Pasqal Cloud ({device})...")
    try:
        results = backend.run(wait=True)
    except Exception as exc:  # noqa: BLE001 - classified, never echoed
        print(MSG_NETWORK_FAILURE if _is_network_error(exc) else MSG_SUBMIT_FAILURE, file=sys.stderr)
        sys.exit(1)

    print("Job finished.")
    print(f"Result type: {type(results).__name__}")
    sys.exit(0)


if __name__ == "__main__":
    main()

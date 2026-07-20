#!/usr/bin/env python3
"""Auth-only Pasqal Cloud validation: authenticate, mint a token, list devices.

Validates credentials against Pasqal Cloud without building a sequence or
submitting any job. On success prints EXACTLY ONE JSON line to stdout:

    {"ok": true, "project_id": ..., "devices": [...],
     "token": <str|null>, "expires_at": <iso8601|null>}

The bearer token is extracted best-effort through the SDK's token-provider
mechanism; when the installed SDK exposes no way to obtain it, "token" is
null — the consumer's signal to fall back to session-only handling. This
script never persists anything.

Credentials are read from environment variables ONLY (never from argv, never
written to disk): PASQAL_USERNAME, PASQAL_PASSWORD, PASQAL_PROJECT_ID. The
caller (the connections panel's validator route) is expected to set these for
this invocation alone.

Exit codes: 0 success; 1 missing environment variable; 2 authentication
failure; 3 network failure / service unreachable; 4 project-authorization
failure. Failure messages are fixed strings — exception text is never
echoed, so neither passwords nor tokens can leak to an output stream.
"""

import base64
import json
import os
import sys
from datetime import datetime, timezone

EXIT_MISSING_ENV = 1
EXIT_AUTH_FAILURE = 2
EXIT_NETWORK_FAILURE = 3
EXIT_PROJECT_FAILURE = 4

MSG_AUTH_FAILURE = "error: Pasqal Cloud authentication failed (invalid credentials)"
MSG_NETWORK_FAILURE = "error: Pasqal Cloud is unreachable (network failure)"
MSG_PROJECT_FAILURE = (
    "error: Pasqal Cloud project authorization failed (check PASQAL_PROJECT_ID)"
)


def _require_env(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        print(f"error: missing required environment variable {name}", file=sys.stderr)
        sys.exit(EXIT_MISSING_ENV)
    return value


def _is_network_error(exc: BaseException) -> bool:
    # requests' ConnectionError/Timeout subclass OSError; cover renames by name.
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    name = type(exc).__name__
    return any(hint in name for hint in ("Connection", "Timeout", "Network", "Unreachable"))


def _underlying_sdk(connection):
    # pasqal-cloud 0.23: PasqalCloudConnection.cloud_client is the
    # PasqalCloudClient (nee SDK); older spellings kept defensively.
    for attr in ("cloud_client", "_sdk", "_sdk_connection", "sdk"):
        candidate = getattr(connection, attr, None)
        if candidate is not None:
            return candidate
    return connection


def _list_devices(connection) -> list:
    # Prefer the plain specs dict (device name -> serialized specs): it is
    # pure SDK, whereas fetch_available_devices deserializes via pulser.
    sdk = _underlying_sdk(connection)
    specs = getattr(sdk, "get_device_specs_dict", None)
    if callable(specs):
        return sorted(specs())
    fetch = getattr(connection, "fetch_available_devices", None)
    if callable(fetch):
        available = fetch()
        if isinstance(available, dict):
            return sorted(available)
        return sorted(getattr(device, "name", str(device)) for device in available)
    return []


def _find_token_provider(connection):
    """Walk to the SDK's token provider (pasqal-cloud 0.23:
    SDK._client.authenticator.token_provider), defensively enough that an
    SDK-internal rename degrades to None — the session-only fallback —
    instead of a crash."""
    sdk = _underlying_sdk(connection)
    client = getattr(sdk, "_client", None) or getattr(sdk, "client", None) or sdk
    for holder in (client, sdk, connection):
        if holder is None:
            continue
        for attr in ("authenticator", "token_provider", "_token_provider"):
            candidate = getattr(holder, attr, None)
            if candidate is None:
                continue
            nested = getattr(candidate, "token_provider", None)
            if nested is not None and callable(getattr(nested, "get_token", None)):
                return nested
            if callable(getattr(candidate, "get_token", None)):
                return candidate
    return None


def _token_expiry(provider, token: str):
    # pasqal-cloud 0.23: ExpiringTokenProvider caches (expiry, token); the
    # cached expiry is exact even when the token is not a decodable JWT.
    cache = getattr(provider, "_ExpiringTokenProvider__token_cache", None)
    if (
        isinstance(cache, tuple)
        and len(cache) == 2
        and isinstance(cache[0], datetime)
    ):
        return cache[0].astimezone(timezone.utc).isoformat()
    # Auth0 access tokens are JWTs; the exp claim is the expiry.
    try:
        payload_b64 = token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        return datetime.fromtimestamp(float(payload["exp"]), tz=timezone.utc).isoformat()
    except Exception:  # noqa: BLE001 - expiry is best-effort metadata
        return None


def _extract_token(connection):
    """Best-effort (token, expires_at) via the SDK's token-provider mechanism."""
    provider = _find_token_provider(connection)
    if provider is None:
        return None, None
    try:
        token = provider.get_token()
    except Exception:  # noqa: BLE001 - token minting is best-effort by design
        return None, None
    if not isinstance(token, str) or not token:
        return None, None
    return token, _token_expiry(provider, token)


def main() -> None:
    username = _require_env("PASQAL_USERNAME")
    password = _require_env("PASQAL_PASSWORD")
    project_id = _require_env("PASQAL_PROJECT_ID")

    # Imported lazily so the env guard above fails cleanly even where
    # pasqal-cloud is not installed, and so tests can pre-inject a stub.
    # Misconfigured python renders distinctly from unreachable-service.
    try:
        from pasqal_cloud import PasqalCloudConnection
        from pasqal_cloud.authentication import TokenProviderError
    except ImportError:
        print(
            f"error: the pasqal-cloud SDK is not installed for {sys.executable}",
            file=sys.stderr,
        )
        sys.exit(EXIT_MISSING_ENV)

    # Constructing the connection performs the auth handshake. Fixed messages
    # only: exception text may echo credentials and must never be printed.
    try:
        connection = PasqalCloudConnection(
            username=username, password=password, project_id=project_id
        )
    except TokenProviderError:
        print(MSG_AUTH_FAILURE, file=sys.stderr)
        sys.exit(EXIT_AUTH_FAILURE)
    except Exception as exc:  # noqa: BLE001 - classified, never echoed
        if _is_network_error(exc):
            print(MSG_NETWORK_FAILURE, file=sys.stderr)
            sys.exit(EXIT_NETWORK_FAILURE)
        print(MSG_AUTH_FAILURE, file=sys.stderr)
        sys.exit(EXIT_AUTH_FAILURE)

    # Auth succeeded; the device listing is the first project-scoped API call,
    # so a non-network failure here means the project refused us.
    try:
        devices = _list_devices(connection)
    except Exception as exc:  # noqa: BLE001 - classified, never echoed
        if _is_network_error(exc):
            print(MSG_NETWORK_FAILURE, file=sys.stderr)
            sys.exit(EXIT_NETWORK_FAILURE)
        print(MSG_PROJECT_FAILURE, file=sys.stderr)
        sys.exit(EXIT_PROJECT_FAILURE)

    token, expires_at = _extract_token(connection)

    print(
        json.dumps(
            {
                "ok": True,
                "project_id": project_id,
                "devices": devices,
                "token": token,
                "expires_at": expires_at,
            }
        )
    )


if __name__ == "__main__":
    main()

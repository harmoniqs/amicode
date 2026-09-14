#!/usr/bin/env bash
# rebuild_amicode_remotely.sh — thin shim for the familiar filename (#1135).
#
# Delegates to rebuild_amicode.sh with the MAIN mode forced (sync to origin/main
# first, then rebuild). The name is retained for muscle-memory / existing docs;
# the mode vocabulary is ADR 0018's `main`. The forced mode wins over any
# forwarded --mode (OB5). All other args are forwarded unchanged.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env FORCE_MODE=main "$SCRIPT_DIR/rebuild_amicode.sh" --mode main "$@"

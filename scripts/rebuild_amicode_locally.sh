#!/usr/bin/env bash
# rebuild_amicode_locally.sh — thin shim for the familiar filename (#1135).
#
# Delegates to rebuild_amicode.sh with the LOCAL mode forced. The forced mode
# wins over any forwarded --mode (OB5): `rebuild_amicode_locally.sh --mode main`
# still runs local. All other args are forwarded unchanged.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec env FORCE_MODE=local "$SCRIPT_DIR/rebuild_amicode.sh" --mode local "$@"

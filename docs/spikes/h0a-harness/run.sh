#!/usr/bin/env bash
# Run one H0a load level. All arguments are passed to run.ts (see README.md).
#
#   bash docs/spikes/h0a-harness/run.sh --out /tmp/opencode/h0a/L1 --sessions 12 --duration-s 7200 --warmup-s 300 --seed 1
#
# What this wrapper adds: run.ts must be the leader of its OWN process group, because its teardown signals that group.
# `setsid --wait` gives it a fresh session and group (and propagates its exit status). Nothing else is started here.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# A transient systemd unit has a minimal PATH; fall back to the usual install location (or set H0A_BUN).
bun_bin="${H0A_BUN:-$(command -v bun || true)}"
[ -n "$bun_bin" ] || bun_bin="$HOME/.bun/bin/bun"
[ -x "$bun_bin" ] || { echo "run.sh: bun not found (set H0A_BUN=/path/to/bun)" >&2; exit 64; }
command -v setsid >/dev/null || { echo "run.sh: setsid not found" >&2; exit 64; }
# Never inherit an inspector: it opens a debug port and attaches to the host.
unset BUN_INSPECT AMICODE_ENGINE_INSPECT
exec setsid --wait "$bun_bin" "$here/run.ts" "$@"

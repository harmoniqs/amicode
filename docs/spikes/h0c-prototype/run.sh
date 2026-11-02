#!/usr/bin/env bash
# Usage: run.sh <c1|c2a|c2b|c2c|c3> [modes]   e.g. run.sh c2b bare,fronted
# Every process runs inside a throwaway sandbox: temp XDG dirs, a fresh DB, loopback ports 51000-51999 only.
set -euo pipefail
cand="${1:?candidate}"; shift || true
export H0C_UPSTREAM="${H0C_UPSTREAM:-/tmp/opencode/h0c/upstream}"
export H0C_ROOT="/tmp/opencode/h0c/xdg/$cand"
rm -rf "$H0C_ROOT"; mkdir -p "$H0C_ROOT"/{state,data,config,cache,home}
export XDG_STATE_HOME="$H0C_ROOT/state" XDG_DATA_HOME="$H0C_ROOT/data" XDG_CONFIG_HOME="$H0C_ROOT/config" XDG_CACHE_HOME="$H0C_ROOT/cache"
export OPENCODE_TEST_HOME="$H0C_ROOT/home" OPENCODE_DB="$H0C_ROOT/data/h0c-fresh.db"
export OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_CONFIG_PROJECT_DISABLE=1 OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_FILEWATCHER_DISABLE=1
here="$(cd "$(dirname "$0")" && pwd)"
# Resolve @opencode/* and effect through the upstream checkout's installed workspace links.
ln -sfn "$H0C_UPSTREAM/packages/sdk/node_modules" "$here/node_modules"
cd "$here"
entry="src/run.ts"; [ "$cand" = prototype ] && entry="src/check.ts"
exec nice -n 19 env -u BUN_INSPECT -u AMICODE_ENGINE_INSPECT bun "$entry" "$cand" "$@"

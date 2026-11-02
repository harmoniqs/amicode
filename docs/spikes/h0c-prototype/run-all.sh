#!/usr/bin/env bash
# Runs every candidate and the prototype check; raw output goes to ./raw/*.log (filtered of upstream INFO logs).
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; mkdir -p "$here/raw"
filter() { grep -v '^\[[0-9:.]*\]\|^  \|^}' ; }
run() { local out="$1"; shift; "$here/run.sh" "$@" 2>&1 | filter > "$here/raw/$out.log"; }
run c1 c1 bare,fronted,fronted-default-idle
run c2a c2a bare,fronted
run c2b c2b bare,fronted,fronted-default-idle
run c2c c2c bare,fronted
H0C_C2C_LIFECYCLE=1 run c2c-lifecycle c2c bare
run c3 c3 bare,fronted,fronted-body-cancel-only,fronted-no-abort-forward
run prototype prototype
echo done

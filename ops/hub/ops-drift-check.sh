#!/usr/bin/env bash
# ops-drift-check.sh — is what the hub RUNS what the repo says? (amicode#2044)
#
# The hub's deployed scripts were hand-maintained for months and drifted (the
# watchdog regression of Oct 11 was an older file deployed over a newer one;
# lane-roll.sh existed only on the hub). This compares the sha256 of each ops
# script in the repo with its deployed copy and fails on ANY difference or
# missing deployed file. It is read-only and never deploys.
#
#   DEPLOY_ROOT   where the scripts are deployed (default ~/.amico/server)
#   OPS_DEPLOY_ROOT  where ops/install.sh puts hub-restart.sh for the extension
#                 (default ~/.amico/ops). Checked when that directory exists — the
#                 VS Code "Restart Hub Server" command runs THAT copy over ssh, so
#                 it must carry the guard (and find solve-guard.sh, which
#                 install.sh puts beside it).
#
# Exit 0 = every file identical; 1 = a difference or a missing deployed file.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
OPS="$(cd "$HERE/.." && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/.amico/server}"
OPS_DEPLOY_ROOT="${OPS_DEPLOY_ROOT:-$HOME/.amico/ops}"

# name (relative to the deploy root) -> repo path
repo_path() {
  case "$1" in
    hub-restart.sh) echo "$OPS/hub-restart.sh" ;;   # lives one level up: packages/extension reads it there
    *) echo "$HERE/$1" ;;
  esac
}

fail=0
printf '%-34s %-9s %-16s %-16s\n' FILE STATUS REPO DEPLOYED
check() { # <label> <repo file> <deployed file>
  local label=$1 repo=$2 dep=$3 a b status
  a="$(sha256sum "$repo" 2>/dev/null | cut -c1-16)"
  if [ -z "$a" ]; then status=NOREPO; fail=1; b="-"
  elif [ ! -f "$dep" ]; then status=MISSING; fail=1; b="-"
  else
    b="$(sha256sum "$dep" | cut -c1-16)"
    if [ "$a" = "$b" ]; then status=ok; else status=DIFF; fail=1; fi
  fi
  printf '%-34s %-9s %-16s %-16s\n' "$label" "$status" "${a:--}" "$b"
}

for f in amicode-server.sh deploy-gate.sh hub-restart.sh lane-roll.sh solve-guard.sh restart-witness.sh fleet-watchdog/rss-watchdog.sh; do
  check "$f" "$(repo_path "$f")" "$DEPLOY_ROOT/$f"
done
if [ -d "$OPS_DEPLOY_ROOT" ]; then
  check "ops/hub-restart.sh" "$OPS/hub-restart.sh" "$OPS_DEPLOY_ROOT/hub-restart.sh"
  check "ops/solve-guard.sh" "$HERE/solve-guard.sh" "$OPS_DEPLOY_ROOT/solve-guard.sh"
fi
exit $fail

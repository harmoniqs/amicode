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
# The repository root is EXPLICIT and verified (amicode#2050). A copy of this script
# deployed at DEPLOY_ROOT used to treat its own directory as "the repo" and compare
# each deployed file with itself — a green board for a check that checked nothing.
#
#   --repo <dir>  | AMICODE_REPO=<dir>   the repository checkout to compare against
#       (validated: it must hold ops/hub/solve-guard.sh and packages/amico-run or .git).
#       With neither, the script's own checkout is used ONLY if it validates and is not
#       the deploy root; otherwise it refuses.
#
# It also refuses when the repo root IS the deploy root, or any repo file resolves to
# the same real file as its deployed copy (a symlink) — comparing a file with itself is
# an error, never "ok".
#
# Exit 0 = every file identical; 1 = a difference or a missing deployed file;
# 64 = misuse (no/invalid repo root, or a file would be compared with itself).
set -u
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/.amico/server}"
OPS_DEPLOY_ROOT="${OPS_DEPLOY_ROOT:-$HOME/.amico/ops}"

die() { echo "ops-drift-check: $*" >&2; exit 64; }
real() { readlink -f -- "$1" 2>/dev/null || echo "$1"; }
is_repo() { [ -f "$1/ops/hub/solve-guard.sh" ] && { [ -d "$1/packages/amico-run" ] || [ -e "$1/.git" ]; }; }

REPO="${AMICODE_REPO:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) [ $# -ge 2 ] || die "--repo needs a directory"; REPO="$2"; shift 2 ;;
    --repo=*) REPO="${1#--repo=}"; shift ;;
    *) die "unknown argument: $1 (usage: ops-drift-check.sh [--repo <checkout>])" ;;
  esac
done

if [ -n "$REPO" ]; then
  [ -d "$REPO" ] || die "--repo / AMICODE_REPO is not a directory: $REPO"
  REPO="$(cd "$REPO" && pwd -P)"
  is_repo "$REPO" || die "$REPO is not a repository checkout (needs ops/hub/solve-guard.sh and packages/amico-run or .git)"
else
  REPO="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd -P)"
  { [ -n "$REPO" ] && is_repo "$REPO"; } || die "run from a repository checkout or pass --repo"
fi
[ "$REPO" != "$(real "$DEPLOY_ROOT")" ] || die "the repository root and the deploy root are the same directory ($REPO): run from a repository checkout or pass --repo"
HERE="$REPO/ops/hub"
OPS="$REPO/ops"

# name (relative to the deploy root) -> repo path
repo_path() {
  case "$1" in
    hub-restart.sh) echo "$OPS/hub-restart.sh" ;;   # lives one level up: packages/extension reads it there
    *) echo "$HERE/$1" ;;
  esac
}

NAMES="amicode-server.sh deploy-gate.sh hub-restart.sh lane-roll.sh solve-guard.sh restart-witness.sh fleet-watchdog/rss-watchdog.sh"

# A repo file and its deployed copy must be different real files (symlinks would make "ok" meaningless).
same_file() { # <repo file> <deployed file>
  [ -e "$1" ] && [ -e "$2" ] && [ "$(real "$1")" = "$(real "$2")" ] && die "$2 resolves to the repo file $1 — a file compared with itself proves nothing"
  return 0
}
for f in $NAMES; do same_file "$(repo_path "$f")" "$DEPLOY_ROOT/$f"; done
if [ -d "$OPS_DEPLOY_ROOT" ]; then
  same_file "$OPS/hub-restart.sh" "$OPS_DEPLOY_ROOT/hub-restart.sh"
  same_file "$HERE/solve-guard.sh" "$OPS_DEPLOY_ROOT/solve-guard.sh"
fi

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

for f in $NAMES; do
  check "$f" "$(repo_path "$f")" "$DEPLOY_ROOT/$f"
done
if [ -d "$OPS_DEPLOY_ROOT" ]; then
  check "ops/hub-restart.sh" "$OPS/hub-restart.sh" "$OPS_DEPLOY_ROOT/hub-restart.sh"
  check "ops/solve-guard.sh" "$HERE/solve-guard.sh" "$OPS_DEPLOY_ROOT/solve-guard.sh"
fi
exit $fail

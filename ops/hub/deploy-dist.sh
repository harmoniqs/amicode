#!/usr/bin/env bash
# deploy-dist.sh — the scripted app-dist deploy for the hub (amicode #1906,
# spec-20261026-101500-rd-system-v2-1 A13(b)). Replaces the hand procedure
#   AMICODE_DEPLOY_OVERRIDE=… node scripts/build_app_bundle.mjs
#   cp -a dist/app $S/dist-app.new && mv $S/dist-app $S/dist-app.old-$TS && mv $S/dist-app.new $S/dist-app
# whose two-mv swap left a window where the frontdoor's per-request reads of
# $S/dist-app/index.html 503'd, and whose override deploys lived only in memory.
#
# What it does (deploy):
#   1. refuses a dirty worktree, and a HEAD that is not the tip of an
#      origin/lane/* or origin/main branch (after `git fetch origin`) —
#      both waivable ONLY by --override "<reason>", which is recorded;
#   2. builds via packages/extension/scripts/build_app_bundle.mjs with the
#      build guard's baseline pinned to that lane (AMICODE_DEPLOY_BASELINE),
#      so an honest lane deploy needs no override; refuses a build whose
#      deploy.json says dirty, or whose commit is not HEAD;
#   3. stages it as $S/dist-releases/<UTC-ts>-<sha8>/ (deploy.json kept; ts is
#      YYYYmmddTHHMMSS.mmmZ so lexical order is deploy order, even in one second);
#   4. flips $S/dist-app — a RELATIVE symlink — via `ln -s` to a temp name +
#      `mv -T` (one rename(2): a reader sees the old release or the new one,
#      never a missing path). First run: when dist-app is still a real
#      directory, renameat2(RENAME_EXCHANGE) swaps the symlink in atomically
#      and the legacy directory becomes dist-releases/<mtime>-<sha8>-migrated;
#   5. appends a pinned provenance line to $S/dist-deploys.jsonl
#      {ts, built_at, action, lane_branch, head_sha, bundle{name,sha256},
#       release_dir, override_reason, operator, dirty, previous_release}
#      — built_at + override_reason are what census-lite's (#1938) JSONL
#      reader windows and counts (`amico census --deploy-record <jsonl>`);
#   6. prunes releases beyond --keep (never the current or previous one).
# --rollback flips to the previous release ($S/dist-releases.previous) and
# records it; a second --rollback flips back.
#
# USAGE
#   ops/hub/deploy-dist.sh [--worktree <lane worktree>] [--service-dir <dir>]
#                          [--keep N] [--dry-run] [--override "<reason>"]
#   ops/hub/deploy-dist.sh --rollback [--service-dir <dir>] [--dry-run]
# ENV
#   DEPLOY_DIST_BUILD_CMD  build command, run with cwd=<worktree>/packages/extension
#                          (default: node scripts/build_app_bundle.mjs; tests inject a fake)
#   DEPLOY_DIST_OPERATOR   recorded operator (default: $(id -un)@$(hostname))
#   AMICODE_FRONTDOOR_PORT port in the printed served-bundle check (default 4096)
#
# Linux target (GNU coreutils `mv -T`, util-linux `flock`, python3 for JSON and
# renameat2). Test: python3 ops/hub/test_deploy_dist.py (on the hub, from /tmp).
set -euo pipefail

say() { printf '[deploy-dist] %s\n' "$*"; }
die() { printf '[deploy-dist] REFUSED: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '/^# USAGE/,/^# Linux target/p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

WORKTREE=""
SERVICE_DIR="$HOME/.amico/server/service"
KEEP=3
DRY=0
MODE=deploy
HAS_OVERRIDE=0
OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="${2:?--worktree needs a path}"; shift 2 ;;
    --service-dir) SERVICE_DIR="${2:?--service-dir needs a path}"; shift 2 ;;
    --keep) KEEP="${2:?--keep needs a number}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --override) HAS_OVERRIDE=1; OVERRIDE="${2-}"; [ $# -ge 2 ] && shift; shift ;;
    --rollback) MODE=rollback; shift ;;
    -h|--help) usage 0 ;;
    *) printf '[deploy-dist] unknown argument: %s\n' "$1" >&2; usage 2 ;;
  esac
done
case "$KEEP" in ''|*[!0-9]*) die "--keep must be a positive integer (got '$KEEP')" ;; esac
[ "$KEEP" -ge 1 ] || die "--keep must be >= 1"
if [ "$HAS_OVERRIDE" = 1 ]; then
  OVERRIDE="$(printf '%s' "$OVERRIDE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$OVERRIDE" ] || die "--override needs a non-empty reason (it is recorded and counted; silent overrides are what #992 forbids)"
fi

command -v python3 >/dev/null || die "python3 is required (JSON records, first-run renameat2)"
[ -d "$SERVICE_DIR" ] || die "service dir missing: $SERVICE_DIR"
S="$(cd "$SERVICE_DIR" && pwd -P)"
REL="$S/dist-releases"
LINK="$S/dist-app"
PREV="$S/dist-releases.previous"
LOG="$S/dist-deploys.jsonl"
OPERATOR="${DEPLOY_DIST_OPERATOR:-$(id -un)@$(hostname)}"
PORT="${AMICODE_FRONTDOOR_PORT:-4096}"

# One deploy at a time (a concurrent pair would race the previous pointer).
if command -v flock >/dev/null; then
  exec 9>"$S/.deploy-dist.lock"
  flock -n 9 || die "another deploy-dist.sh holds $S/.deploy-dist.lock"
else
  say "WARNING: flock not found — running without the deploy lock"
fi

# --- helpers --------------------------------------------------------------------
# deploy.json → "commit<US>dirty<US>override_reason<US>built_at<US>branch" (US = \x1f:
# a non-whitespace IFS, so an empty field never collapses into its neighbour)
read_manifest() {
  python3 - "$1" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print("ERR\x1f%s" % e); sys.exit(0)
ov = d.get("override_reason")
print("\x1f".join([str(d.get("commit") or ""), "true" if d.get("dirty") is True else "false",
                 ov.strip() if isinstance(ov, str) else "", str(d.get("built_at") or ""), str(d.get("branch") or "")]))
PY
}

# The served bundle: the index-*.js the release's index.html loads.
bundle_name() {
  local n
  n="$(grep -o 'assets/index-[A-Za-z0-9_-]*\.js' "$1/index.html" 2>/dev/null | head -n1 || true)"
  printf '%s' "${n#assets/}"
}

# release name a symlink points at ("" when not a symlink)
link_target() { if [ -L "$1" ]; then basename "$(readlink "$1")"; fi; }

# Atomically point $2 (a symlink path) at dist-releases/$1: temp link + rename(2).
point() {
  local tmp="$2.tmp.$$"
  rm -f "$tmp"
  ln -s "dist-releases/$1" "$tmp"
  mv -T "$tmp" "$2"
}

# First run: dist-app is a real directory. rename(2) cannot replace a
# non-empty directory, so swap a ready symlink in with renameat2's
# RENAME_EXCHANGE (one syscall: no instant without a dist-app), then move the
# exchanged-out legacy directory into dist-releases/. Never falls back to a
# two-step swap silently.
exchange() { # exchange <a> <b>
  python3 - "$1" "$2" <<'PY'
import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
try:
    fn = libc.renameat2
except AttributeError:
    sys.exit("renameat2 unavailable in libc (needs glibc >= 2.28)")
AT_FDCWD, RENAME_EXCHANGE = -100, 2
if fn(AT_FDCWD, os.fsencode(sys.argv[1]), AT_FDCWD, os.fsencode(sys.argv[2]), RENAME_EXCHANGE) != 0:
    e = ctypes.get_errno()
    sys.exit("renameat2(RENAME_EXCHANGE) failed: %s" % os.strerror(e))
PY
}

legacy_release_name() {
  local mts commit
  mts="$(date -u -r "$LINK" +%Y%m%dT%H%M%S.%3NZ)"
  commit="$(read_manifest "$LINK/deploy.json" | cut -d$'\x1f' -f1)"
  case "$commit" in ''|ERR) commit=unknown0 ;; esac
  printf '%s-%s-migrated' "$mts" "${commit:0:8}"
}

# flip_to <release>: make dist-app serve it; prints the release it replaced.
flip_to() {
  local name="$1" old
  if [ -L "$LINK" ]; then
    old="$(link_target "$LINK")"
    point "$name" "$LINK"
  elif [ -d "$LINK" ]; then
    old="$(legacy_release_name)"
    [ ! -e "$REL/$old" ] || die "migration target already exists: $REL/$old"
    local tmp="$LINK.tmp.$$"
    rm -f "$tmp"
    ln -s "dist-releases/$name" "$tmp"
    if ! exchange "$tmp" "$LINK" >&2; then
      rm -f "$tmp"
      die "first-run migration could not swap atomically; dist-app untouched. Remedy: run on Linux >= 3.15 / glibc >= 2.28"
    fi
    mv -T "$tmp" "$REL/$old"   # the legacy directory, now a release
    say "first-run migration: legacy dist-app → dist-releases/$old" >&2
  elif [ -e "$LINK" ]; then
    die "$LINK exists but is neither a symlink nor a directory"
  else
    old=""
    point "$name" "$LINK"
  fi
  if [ -n "$old" ]; then point "$old" "$PREV"; fi
  printf '%s' "$old"
}

record() { # record <action> <release> <previous> <lane> <head> <override|""> <dirty> <built_at>
  local rel="$REL/$2" b sha
  b="$(bundle_name "$rel")"
  sha=""
  [ -n "$b" ] && [ -f "$rel/assets/$b" ] && sha="$(sha256sum "$rel/assets/$b" | cut -d' ' -f1)"
  python3 - "$LOG" "$1" "$rel" "$3" "$4" "$5" "$6" "$7" "$8" "$b" "$sha" "$OPERATOR" <<'PY'
import datetime, json, sys
(log, action, rel, prev, lane, head, ov, dirty, built, bname, bsha, op) = sys.argv[1:]
ts = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
rec = {"ts": ts, "built_at": built or ts, "action": action, "lane_branch": lane or None,
       "head_sha": head or None, "bundle": {"name": bname or None, "sha256": bsha or None},
       "release_dir": rel, "override_reason": ov or None, "operator": op,
       "dirty": dirty == "true", "previous_release": prev or None}
with open(log, "a") as f:
    f.write(json.dumps(rec, sort_keys=True) + "\n")
PY
}

prune() {
  local cur prev n=0 name
  cur="$(link_target "$LINK")"
  prev="$(link_target "$PREV")"
  [ -d "$REL" ] || return 0
  # names lead with a UTC timestamp: reverse lexical order is newest first
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    n=$((n + 1))
    if [ "$n" -le "$KEEP" ] || [ "$name" = "$cur" ] || [ "$name" = "$prev" ]; then continue; fi
    say "prune: dist-releases/$name"
    rm -rf -- "${REL:?}/$name"
  done < <(find "$REL" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z-*' -printf '%f\n' | LC_ALL=C sort -r)
}

hint() {
  local b="$1"
  say "served-bundle check (expect $b):"
  say "  curl -s http://127.0.0.1:$PORT/ | grep -o 'assets/index-[A-Za-z0-9_-]*\\.js'"
  local legacy
  legacy="$(find "$S" -mindepth 1 -maxdepth 1 -name 'dist-app.*' ! -name 'dist-app.tmp.*' 2>/dev/null | wc -l)"
  [ "$legacy" -gt 0 ] && say "note: $legacy legacy hand-swap dirs ($S/dist-app.*) are not managed here; remove them by hand once satisfied"
  return 0
}

# --- rollback ---------------------------------------------------------------------
if [ "$MODE" = rollback ]; then
  [ -L "$LINK" ] || die "$LINK is not a deploy-dist symlink — nothing to roll back to (deploy once first)"
  cur="$(link_target "$LINK")"
  prev="$(link_target "$PREV")"
  if [ -z "$prev" ] || [ ! -f "$REL/$prev/index.html" ]; then
    die "no previous release to roll back to ($PREV → '${prev:-<none>}')"
  fi
  if [ "$DRY" = 1 ]; then say "DRY-RUN: would roll back dist-app: $cur → $prev"; exit 0; fi
  flip_to "$prev" >/dev/null
  IFS=$'\x1f' read -r m_commit _ _ m_built m_branch < <(read_manifest "$REL/$prev/deploy.json")
  if [ "$m_commit" = ERR ]; then m_commit=""; m_built=""; m_branch=""; fi
  record rollback "$prev" "$cur" "$m_branch" "$m_commit" "" false "$m_built"
  say "rolled back: dist-app → dist-releases/$prev (was $cur; a second --rollback flips back)"
  hint "$(bundle_name "$REL/$prev")"
  exit 0
fi

# --- deploy: the source checks ------------------------------------------------------
WT="$(git -C "${WORKTREE:-.}" rev-parse --show-toplevel 2>/dev/null)" || die "not a git worktree: ${WORKTREE:-$PWD}"
[ -d "$WT/packages/extension" ] || die "$WT has no packages/extension — not an amicode worktree"
say "worktree: $WT"
git -C "$WT" fetch --quiet --prune origin || die "git fetch origin failed in $WT"
HEAD_SHA="$(git -C "$WT" rev-parse HEAD)"
DIRTY_LINES="$(git -C "$WT" status --porcelain)"
CUR_BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
UPSTREAM="$(git -C "$WT" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"

# origin branches (lane/* or main) whose tip IS this HEAD; prefer the
# checkout's upstream, then the same-named branch, then any lane, then main.
mapfile -t TIPS < <(git -C "$WT" for-each-ref --points-at HEAD --format='%(refname:strip=3)' \
  refs/remotes/origin/lane refs/remotes/origin/main | grep -E '^(lane/.+|main)$' || true)
LANE_BRANCH=""
for want in "${UPSTREAM#origin/}" "$CUR_BRANCH"; do
  for t in "${TIPS[@]}"; do [ -z "$LANE_BRANCH" ] && [ "$t" = "$want" ] && LANE_BRANCH="$t"; done
done
for t in "${TIPS[@]}"; do [ -z "$LANE_BRANCH" ] && [[ "$t" == lane/* ]] && LANE_BRANCH="$t"; done
for t in "${TIPS[@]}"; do [ -z "$LANE_BRANCH" ] && [ "$t" = main ] && LANE_BRANCH="$t"; done

REASONS=()
if [ -z "$LANE_BRANCH" ]; then
  REASONS+=("HEAD ${HEAD_SHA:0:12} is not the tip of any origin/lane/* or origin/main branch — REMEDY: check out and pull the lane tip (git checkout lane/<x> && git pull --ff-only)")
fi
if [ -n "$DIRTY_LINES" ]; then
  REASONS+=("the worktree is dirty ($(printf '%s\n' "$DIRTY_LINES" | wc -l | tr -d ' ') entries: $(printf '%s\n' "$DIRTY_LINES" | head -n3 | tr '\n' ';')) — REMEDY: commit via a PR or stash")
fi
if [ "${#REASONS[@]}" -gt 0 ]; then
  if [ "$HAS_OVERRIDE" = 1 ]; then
    for r in "${REASONS[@]}"; do say "OVERRIDE: $r"; done
    say "OVERRIDE RECORDED: \"$OVERRIDE\" (counted by census-lite)"
  else
    for r in "${REASONS[@]}"; do printf '[deploy-dist] REFUSED: %s\n' "$r" >&2; done
    die "fix the above, or pass --override \"<reason>\" (recorded and counted)"
  fi
fi
[ -n "$LANE_BRANCH" ] || LANE_BRANCH="$CUR_BRANCH"
say "source: $LANE_BRANCH @ ${HEAD_SHA:0:12}${OVERRIDE:+ (override: $OVERRIDE)}"

NAME="$(date -u +%Y%m%dT%H%M%S.%3NZ)-${HEAD_SHA:0:8}"
[ ! -e "$REL/$NAME" ] || die "release $NAME already exists (same commit deployed this second) — retry"
if [ "$DRY" = 1 ]; then
  if [ -L "$LINK" ]; then now="dist-releases/$(link_target "$LINK")"
  elif [ -d "$LINK" ]; then now="a legacy directory (first-run migration)"
  else now="<missing>"; fi
  say "DRY-RUN: would build $LANE_BRANCH @ ${HEAD_SHA:0:12} → $REL/$NAME and flip $LINK (now: $now); keep $KEEP"
  exit 0
fi

# --- build -------------------------------------------------------------------------
EXT="$WT/packages/extension"
BUILT="$EXT/dist/app"
rm -rf -- "$BUILT"   # a no-op build must never re-deploy a stale dist
BUILD_CMD="${DEPLOY_DIST_BUILD_CMD:-node scripts/build_app_bundle.mjs}"
say "build: $BUILD_CMD (cwd=$EXT)"
if [ "$HAS_OVERRIDE" = 1 ]; then
  (cd "$EXT" && env -u AMICODE_DEPLOY_BASELINE AMICODE_DEPLOY_OVERRIDE="$OVERRIDE" bash -c "$BUILD_CMD") || die "build failed"
else
  (cd "$EXT" && env -u AMICODE_DEPLOY_OVERRIDE AMICODE_DEPLOY_BASELINE="$LANE_BRANCH" bash -c "$BUILD_CMD") || die "build failed"
fi
[ -f "$BUILT/index.html" ] || die "the build produced no $BUILT/index.html"
[ -f "$BUILT/deploy.json" ] || die "the build wrote no deploy.json — the dist would not trace to a commit"
IFS=$'\x1f' read -r m_commit m_dirty m_override m_built _ < <(read_manifest "$BUILT/deploy.json")
[ "$m_commit" != ERR ] || die "unreadable $BUILT/deploy.json"
[ "$m_commit" = "$HEAD_SHA" ] || die "deploy.json commit ${m_commit:0:12} ≠ HEAD ${HEAD_SHA:0:12} — the build did not come from this tree"
[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_SHA" ] || die "HEAD moved during the build"
if [ "$HAS_OVERRIDE" != 1 ] && [ -n "$m_override" ]; then
  die "deploy.json carries override_reason \"$m_override\" but no --override was given — an unrecorded override"
fi
if [ "$m_dirty" = true ] && [ "$HAS_OVERRIDE" != 1 ]; then
  die "the build's deploy.json says dirty: true — a dirty build is never deployed without --override"
fi
BUNDLE="$(bundle_name "$BUILT")"
if [ -z "$BUNDLE" ] || [ ! -f "$BUILT/assets/$BUNDLE" ]; then
  die "index.html loads no assets/index-*.js present in the dist"
fi

# --- stage, flip, record, prune ------------------------------------------------------
mkdir -p "$REL"
STAGE="$REL/.staging-$NAME"
rm -rf -- "$STAGE"
cp -a "$BUILT" "$STAGE"
mv -T "$STAGE" "$REL/$NAME"
say "staged: $REL/$NAME (bundle $BUNDLE)"
OLD="$(flip_to "$NAME")" || exit 1
say "flipped: dist-app → dist-releases/$NAME (previous: ${OLD:-<none>})"
DIRTY_FLAG=false
{ [ -n "$DIRTY_LINES" ] || [ "$m_dirty" = true ]; } && DIRTY_FLAG=true
record deploy "$NAME" "$OLD" "$LANE_BRANCH" "$HEAD_SHA" "${OVERRIDE}" "$DIRTY_FLAG" "$m_built"
say "recorded: $LOG"
prune
hint "$BUNDLE"

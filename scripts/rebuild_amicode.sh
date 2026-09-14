#!/usr/bin/env bash
# rebuild_amicode.sh — fork-free terminal fallback for rebuilding Amicode (#1135).
#
# Reintroduces the deleted rebuild scripts (S9 / #1116) WITHOUT the fork: the
# binary is built from the in-repo overlay via `build:binary`
# (materialize base+overlay -> bun compile), NOT downloaded from a fork release
# and NOT built from a sibling fork checkout. Mirrors the in-app Developer Tools
# "Rebuild" recipe (packages/extension/src/chat_bridge.ts dev-tools-rebuild +
# src/rebuild/{dependency_resolver,atomic_adoption,coordinator}.ts).
#
# USAGE
#   scripts/rebuild_amicode.sh --mode local|main [--yes] [--allow-bun-install]
#
#   --mode local   build the working tree exactly as it sits (NO git mutation).
#   --mode main    git fetch origin && git checkout main && git pull --ff-only
#                  first; refuses on a dirty/divergent tree. Then build plain.
#   --yes          non-interactive: provision pnpm via corepack without asking.
#                  Does NOT consent to the bun network install (see below).
#   --allow-bun-install   the ONLY thing that permits the `curl | bash` bun
#                  installer; --yes never implies it (fail-closed, OB9).
#
# Two thin shims wrap this: rebuild_amicode_locally.sh -> --mode local,
# rebuild_amicode_remotely.sh -> --mode main. The shim-injected mode wins over
# any forwarded --mode (OB5).
#
# The rebuild recipe (both modes, matching the in-app handler order):
#   [main only] git fetch/checkout/ff-pull  -> pnpm install -> pnpm -r build
#   -> build:binary (overlay) -> build:app -> atomic-swap deploy + binary copy.
#
# No settings.json writes — the extension discovers its paths at runtime (#1022).
set -euo pipefail

# ── Repo root: the tree THIS script lives in (overridable) ──────────────────
# Building from the script's own repo is what makes local mode "build the
# working tree exactly as it sits" (OB2). AMICODE_ROOT overrides for tests.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMICODE_ROOT="${AMICODE_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
EXT_PKG="$AMICODE_ROOT/packages/extension"

# ── Argument parsing ────────────────────────────────────────────────────────
# A pre-injected mode (the shims export FORCE_MODE) always wins; a forwarded
# --mode is then ignored for the value but still consumed. Without a forced
# mode, exactly one of local|main must be given.
MODE="${FORCE_MODE:-}"
YES=0
ALLOW_BUN_INSTALL=0
DRY_RUN=0
CHECK_GIT_ONLY=0
CHECK_DEPS_ONLY=0
SELF_TEST_DEPLOY=0

usage() {
  cat >&2 <<EOF
Usage: rebuild_amicode.sh --mode local|main [--yes] [--allow-bun-install]
  --mode local          rebuild the working tree as it sits (no git mutation)
  --mode main           sync to origin/main first, then rebuild (refuses if dirty)
  --yes                 non-interactive (pnpm via corepack; NOT the bun installer)
  --allow-bun-install   permit the 'curl | bash' bun install (never implied by --yes)
EOF
}

die() { echo "ERROR: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      shift; [ $# -gt 0 ] || { usage; die "--mode needs a value"; }
      if [ -n "${FORCE_MODE:-}" ]; then
        # Shim precedence (OB5): forced mode wins; ignore the forwarded value.
        :
      else
        MODE="$1"
      fi
      ;;
    --mode=*)
      val="${1#--mode=}"
      if [ -z "${FORCE_MODE:-}" ]; then MODE="$val"; fi
      ;;
    --yes|-y) YES=1 ;;
    --allow-bun-install) ALLOW_BUN_INSTALL=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --check-git-only) CHECK_GIT_ONLY=1 ;;
    --check-deps-only) CHECK_DEPS_ONLY=1 ;;
    --self-test-deploy) SELF_TEST_DEPLOY=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown argument: $1" ;;
  esac
  shift
done

# ── Platform key — the SAME derivation build_binary.mjs uses (OB11) ─────────
# node process.platform-process.arch, NOT a uname variant, so the vendor path
# matches what build:binary writes and what the runtime resolver reads.
platform_key() {
  node -e 'process.stdout.write(process.platform + "-" + process.arch)'
}

# ── Dependency preflight (mirrors dependency_resolver.ts policy) ────────────
# node>=20 + git: detect and guide, NEVER auto-install. pnpm: corepack enable.
# bun: offered via the official installer, gated behind --allow-bun-install;
# --yes alone never triggers the network install (OB9, fail-closed).
resolve_bun() {
  # Same ladder as build_binary.mjs resolveBun(): AMICODE_BUN, PATH, ~/.bun.
  if [ -n "${AMICODE_BUN:-}" ]; then
    command -v "$AMICODE_BUN" >/dev/null 2>&1 && { echo "$AMICODE_BUN"; return 0; }
    [ -x "$AMICODE_BUN" ] && { echo "$AMICODE_BUN"; return 0; }
    return 1
  fi
  if command -v bun >/dev/null 2>&1; then command -v bun; return 0; fi
  [ -x "$HOME/.bun/bin/bun" ] && { echo "$HOME/.bun/bin/bun"; return 0; }
  return 1
}

preflight_deps() {
  # ── node >= 20 (detect + guide) ──
  command -v node >/dev/null 2>&1 || die "node not found. Install Node >= 20 (nodejs.org, nvm, fnm)."
  local node_major
  node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  [ "$node_major" -ge 20 ] || die "Node >= 20 required (found $(node --version)). Install a newer Node; this script never auto-installs it."

  # ── git (detect + guide) ──
  command -v git >/dev/null 2>&1 || die "git not found. Install git (https://git-scm.com); this script never auto-installs it."

  # ── pnpm via corepack ──
  if ! command -v pnpm >/dev/null 2>&1; then
    if command -v corepack >/dev/null 2>&1; then
      echo "==> pnpm missing — enabling via corepack..."
      corepack enable || die "corepack enable failed (may need sudo). Enable pnpm manually: corepack enable && corepack prepare pnpm --activate"
      corepack prepare pnpm --activate || true
      command -v pnpm >/dev/null 2>&1 || die "pnpm still not available after corepack enable."
    else
      die "pnpm not found and corepack unavailable. Enable corepack (ships with Node >= 16.9) or install pnpm."
    fi
  fi

  # ── bun (build:binary needs it) — OB9 fail-closed ──
  if ! resolve_bun >/dev/null 2>&1; then
    local installer="curl -fsSL https://bun.sh/install | bash"
    if [ "$ALLOW_BUN_INSTALL" -eq 1 ]; then
      echo "==> bun missing — installing (explicit --allow-bun-install): $installer"
      curl -fsSL https://bun.sh/install | bash || die "bun install failed."
      resolve_bun >/dev/null 2>&1 || die "bun still not found after install. Add ~/.bun/bin to PATH or set AMICODE_BUN."
    elif [ "$YES" -eq 1 ]; then
      # --yes MUST NOT auto-run the network installer (OB9). Fail closed.
      die "bun not found. --yes does NOT auto-run the bun network installer ('$installer'). Re-run with --allow-bun-install to permit it, or install bun yourself."
    else
      # Interactive: explicit y/N; default No.
      printf '%s\n' "bun is required to build the binary and is not installed." >&2
      read -r -p "Install bun now via '$installer'? [y/N] " ans
      case "$ans" in
        y|Y|yes|YES)
          curl -fsSL https://bun.sh/install | bash || die "bun install failed." ;;
        *) die "bun is required. Install it (or re-run with --allow-bun-install), then retry." ;;
      esac
      resolve_bun >/dev/null 2>&1 || die "bun still not found after install. Add ~/.bun/bin to PATH or set AMICODE_BUN."
    fi
  fi
}

if [ "$CHECK_DEPS_ONLY" -eq 1 ]; then
  preflight_deps
  echo "==> dependency preflight OK"
  exit 0
fi

# ── main-mode git guard (OB8): refuse on a dirty/divergent tree ─────────────
# Preflight git status BEFORE any checkout; if dirty, REFUSE (never auto-stash,
# never silent-carry). Record the starting branch so we can offer to restore.
main_mode_git_sync() {
  command -v git >/dev/null 2>&1 || die "git not found."
  local start_branch dirty
  start_branch="$(git -C "$AMICODE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached)')"
  dirty="$(git -C "$AMICODE_ROOT" status --porcelain 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    {
      echo "REFUSED: --mode main requires a clean working tree, but $AMICODE_ROOT is dirty:"
      printf '%s\n' "$dirty" | head -10 | sed 's/^/    /'
      echo "This mode never auto-stashes or silently carries local changes."
      echo "Commit via a PR or stash, then retry. Your starting branch was: $start_branch"
    } >&2
    return 1
  fi
  # Clean — safe to sync. Abort leaves the caller on start_branch.
  echo "==> [main] git fetch origin"
  git -C "$AMICODE_ROOT" fetch origin || die "git fetch failed (starting branch: $start_branch)."
  echo "==> [main] git checkout main"
  git -C "$AMICODE_ROOT" checkout main || die "git checkout main failed (restore with: git checkout $start_branch)."
  echo "==> [main] git pull --ff-only origin main"
  if ! git -C "$AMICODE_ROOT" pull --ff-only origin main; then
    die "git pull --ff-only failed (diverged from origin/main). Reconcile manually; restore your branch with: git checkout $start_branch"
  fi
}

if [ "$CHECK_GIT_ONLY" -eq 1 ]; then
  if [ "$MODE" = "main" ]; then main_mode_git_sync; else echo "==> [local] no git mutation"; fi
  echo "==> git step OK"
  exit 0
fi

# ── Session DB backup (OB6, OB10) ───────────────────────────────────────────
# One "zeroed" predicate shared by backup+restore: a live .db is considered
# zeroed if it is smaller than the 16-byte SQLite header OR fails an integrity
# open. -wal/-shm travel as an atomic set. Backups live in a script-owned dir
# with an embedded sortable timestamp; pruning selects by that timestamp (not
# mtime) and hard-fails rather than deleting on an unexpected glob (OB10).
DBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
BACKUP_ROOT="$DBDIR/.rebuild-db-backups"
BACKUP_PREFIX="ramicode-"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP=""

db_is_zeroed() {
  # $1 = path to a .db file. Zeroed == missing, empty, below header size, or
  # not a valid SQLite file.
  local f="$1"
  [ -s "$f" ] || return 0
  local size
  size="$(wc -c < "$f" | tr -d ' ')"
  [ "$size" -ge 16 ] || return 0
  # Header check: first 16 bytes are "SQLite format 3\000".
  local hdr
  hdr="$(dd if="$f" bs=1 count=15 2>/dev/null || true)"
  [ "$hdr" = "SQLite format 3" ] || return 0
  return 1
}

backup_session_dbs() {
  ls "$DBDIR"/opencode*.db >/dev/null 2>&1 || { echo "==> No session DBs to back up (first install?)"; return 0; }
  mkdir -p "$BACKUP_ROOT"
  BACKUP="$BACKUP_ROOT/${BACKUP_PREFIX}${TS}"
  mkdir -p "$BACKUP"
  local f
  for f in "$DBDIR"/opencode*.db; do
    [ -f "$f" ] || continue
    # Checkpoint WAL into the main db if sqlite3 is present (server assumed stopped).
    if command -v sqlite3 >/dev/null 2>&1; then
      sqlite3 "$f" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1 || true
    fi
    cp -p "$f" "$BACKUP/" 2>/dev/null || true
    # -wal/-shm as an atomic set
    [ -f "$f-wal" ] && cp -p "$f-wal" "$BACKUP/" 2>/dev/null || true
    [ -f "$f-shm" ] && cp -p "$f-shm" "$BACKUP/" 2>/dev/null || true
  done
  echo "==> Session DBs backed up to $BACKUP"
  prune_backups
}

prune_backups() {
  # Keep the 3 most recent, selected by the embedded timestamp in the name.
  local keep=3 entries=()
  # List only our script-owned prefix; sort by the sortable name suffix.
  # (while-read, not `mapfile`: macOS ships bash 3.2, which has no mapfile.)
  local _line
  while IFS= read -r _line; do entries+=("$_line"); done \
    < <(find "$BACKUP_ROOT" -maxdepth 1 -type d -name "${BACKUP_PREFIX}*" -exec basename {} \; 2>/dev/null | sort)
  local count=${#entries[@]}
  [ "$count" -le "$keep" ] && return 0
  local drop=$((count - keep)) i
  for ((i = 0; i < drop; i++)); do
    local victim="$BACKUP_ROOT/${entries[$i]}"
    case "$victim" in
      "$BACKUP_ROOT/${BACKUP_PREFIX}"*) rm -rf "$victim" && echo "==> Pruned old backup: ${entries[$i]}" ;;
      *) die "prune refused: '$victim' does not match the owned backup prefix" ;;
    esac
  done
}

restore_session_dbs() {
  [ -n "$BACKUP" ] && [ -d "$BACKUP" ] || return 0
  local restored=0 f base target
  for f in "$BACKUP"/opencode*.db; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    target="$DBDIR/$base"
    # Restore only when the live DB is zeroed by the build AND the backup is good.
    if db_is_zeroed "$target" && ! db_is_zeroed "$f"; then
      cp -p "$f" "$target"
      [ -f "$f-wal" ] && cp -p "$f-wal" "$target-wal" || true
      [ -f "$f-shm" ] && cp -p "$f-shm" "$target-shm" || true
      restored=$((restored + 1))
    fi
  done
  [ "$restored" -gt 0 ] && echo "==> Restored $restored session DB(s) from backup (they were zeroed by the build)."
  return 0
}

# ── Build recipe (shared) — mirrors the in-app handler order ────────────────
build_amicode() {
  echo ""
  echo "==> Installing amicode dependencies (pnpm install)..."
  (cd "$AMICODE_ROOT" && pnpm install)

  echo ""
  echo "==> Building amicode extension (pnpm -r build)..."
  (cd "$AMICODE_ROOT" && pnpm -r build)

  echo ""
  echo "==> Building binary from the local overlay (build:binary)..."
  # build:binary materializes base+overlay and bun-compiles — no fork, no release.
  local bun; bun="$(resolve_bun)"
  (cd "$AMICODE_ROOT" && AMICODE_BUN="$bun" pnpm --filter amicode run build:binary)

  echo ""
  echo "==> Building app bundle from the local overlay (build:app)..."
  if [ "$MODE" = "local" ]; then
    # local: record an honest override reason AND pass --direct-worktree so the
    # #992 deploy guard permits a dirty/divergent branch (invariant line 22).
    local branch; branch="$(git -C "$AMICODE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(unknown)')"
    (cd "$AMICODE_ROOT" && AMICODE_DEPLOY_OVERRIDE="local rebuild: $branch working tree" \
        pnpm --filter amicode run build:app -- --direct-worktree)
  else
    # main: clean == origin/main, so build plain (no override).
    (cd "$AMICODE_ROOT" && pnpm --filter amicode run build:app)
  fi
}

# ── Installed-extension discovery ───────────────────────────────────────────
find_installed_ext() {
  local found=""
  found="$(find "${VSCODE_EXT_DIR:-$HOME/.vscode/extensions}" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d 2>/dev/null | sort -V | tail -1)"
  if [ -z "$found" ]; then
    local candidate
    for candidate in "$HOME/.vscode-server/extensions" "$HOME/.vscode-insiders/extensions"; do
      found="$(find "$candidate" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d 2>/dev/null | sort -V | tail -1)"
      [ -n "$found" ] && break
    done
  fi
  echo "$found"
}

# ── Running-server interlock (OB12) ─────────────────────────────────────────
# Refuse the destructive phase if an opencode server / Extension Dev Host is
# holding the DB open. Best-effort: pgrep for a live opencode process.
check_no_live_server() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -f 'opencode.*serve' >/dev/null 2>&1; then
      die "A live opencode server appears to be running — close the Extension Dev Host / opencode server before rebuilding (it holds the session DB open)."
    fi
  fi
}

# ── Atomic-swap deploy + binary copy (OB4, OB7) ─────────────────────────────
# The core crash-safe primitive, factored so the self-test can drive it. Swaps
# <ext>/dist and copies the freshly built binary into <ext>/vendor/opencode/
# <key>/opencode. Both revert TOGETHER on any failure; a marker + unique
# rename-out name lets the next run recover a stranded dist.
#
#   deploy_dist_and_binary <ext_dir> <built_dist> <built_binary> <platform_key>
# Returns 0 on success, non-zero (and reverts) on failure.
deploy_dist_and_binary() {
  local ext="$1" built_dist="$2" built_bin="$3" key="$4"
  local marker_dir="$HOME/.amico/rebuild-backups"
  local marker="$marker_dir/pending.json"
  mkdir -p "$marker_dir"

  # Recover any stranded dist from a prior crash BEFORE touching anything.
  recover_stranded_dist "$ext"

  local uniq; uniq="$$-$(date +%s)"
  local dist_old="$ext/dist.pre-swap-$uniq"
  local vendor_dir="$ext/vendor/opencode/$key"
  local bin_dest="$vendor_dir/opencode"
  local bin_old="$vendor_dir/.opencode.pre-swap-$uniq"
  local bin_tmp="$vendor_dir/.opencode.new-$uniq"

  # Write the pending marker so a crash mid-swap is recoverable.
  cat > "$marker" <<EOF
{"target_path":"$ext","dist_old":"$dist_old","swap_state":"pending","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF

  # 1. Rename current dist out of the way (atomic on same fs).
  if [ -d "$ext/dist" ]; then
    mv "$ext/dist" "$dist_old" || { echo "deploy: could not move current dist aside" >&2; rm -f "$marker"; return 1; }
  fi

  # 2. Copy new dist into place.
  if ! cp -R "$built_dist" "$ext/dist"; then
    # Revert dist.
    [ -d "$dist_old" ] && { rm -rf "$ext/dist"; mv "$dist_old" "$ext/dist"; }
    echo "deploy: dist copy failed — rolled back" >&2; rm -f "$marker"; return 1
  fi

  # 3. Binary copy (temp + mv, same fs), folded into the SAME rollback.
  if [ -n "$built_bin" ] && [ -f "$built_bin" ]; then
    mkdir -p "$vendor_dir"
    [ -f "$bin_dest" ] && cp -p "$bin_dest" "$bin_old" 2>/dev/null || true
    if ! cp "$built_bin" "$bin_tmp" || ! chmod 755 "$bin_tmp" || ! mv "$bin_tmp" "$bin_dest"; then
      # Revert BOTH the binary and the dist — no version skew.
      rm -f "$bin_tmp"
      [ -f "$bin_old" ] && mv "$bin_old" "$bin_dest"
      rm -rf "$ext/dist"; [ -d "$dist_old" ] && mv "$dist_old" "$ext/dist"
      echo "deploy: binary copy failed — dist AND binary rolled back together" >&2
      rm -f "$marker"; return 1
    fi
    # Also carry the sidecars for provenance parity.
    [ -f "$(dirname "$built_bin")/.source" ] && cp -f "$(dirname "$built_bin")/.source" "$vendor_dir/.source" 2>/dev/null || true
    [ -f "$(dirname "$built_bin")/.sha256" ] && cp -f "$(dirname "$built_bin")/.sha256" "$vendor_dir/.sha256" 2>/dev/null || true
  fi

  # 4. Commit: drop the stale copies and the marker.
  rm -rf "$dist_old"
  rm -f "$bin_old"
  rm -f "$marker"
  return 0
}

# Recover a dist stranded by a mid-swap crash: if a dist.pre-swap-* exists and
# the live dist is missing/empty, restore it. Idempotent.
recover_stranded_dist() {
  local ext="$1" stranded
  stranded="$(find "$ext" -maxdepth 1 -type d -name 'dist.pre-swap-*' 2>/dev/null | sort | tail -1)"
  [ -n "$stranded" ] || return 0
  if [ ! -d "$ext/dist" ] || [ -z "$(ls -A "$ext/dist" 2>/dev/null)" ]; then
    rm -rf "$ext/dist"
    mv "$stranded" "$ext/dist"
    echo "==> Recovered a dist stranded by a prior interrupted rebuild."
  else
    # Live dist looks intact — the stranded copy is stale leftovers; drop it.
    rm -rf "$stranded"
  fi
  # Sweep any other older stranded copies.
  local other
  while IFS= read -r other; do
    [ -n "$other" ] && rm -rf "$other"
  done < <(find "$ext" -maxdepth 1 -type d -name 'dist.pre-swap-*' 2>/dev/null)
}

# ── Self-test for the deploy primitive (OB7 falsifiable check) ──────────────
self_test_deploy() {
  local sandbox; sandbox="$(mktemp -d)"
  trap 'rm -rf "$sandbox"' RETURN
  local ext="$sandbox/ext" key="test-plat"
  mkdir -p "$ext/dist"; echo "ORIGINAL_DIST" > "$ext/dist/marker.txt"
  mkdir -p "$ext/vendor/opencode/$key"; echo "ORIGINAL_BIN" > "$ext/vendor/opencode/$key/opencode"
  # Built artifacts to deploy.
  local built="$sandbox/built"; mkdir -p "$built/dist"; echo "NEW_DIST" > "$built/dist/marker.txt"
  mkdir -p "$built/bin"; echo "NEW_BIN" > "$built/bin/opencode"; echo "overlay abc123" > "$built/bin/.source"

  # (a) Happy path: both dist and binary update together.
  HOME="$sandbox/home" deploy_dist_and_binary "$ext" "$built/dist" "$built/bin/opencode" "$key" || {
    echo "SELFTEST: happy-path deploy failed" >&2; return 1; }
  [ "$(cat "$ext/dist/marker.txt")" = "NEW_DIST" ] || { echo "SELFTEST: dist not updated" >&2; return 1; }
  [ "$(cat "$ext/vendor/opencode/$key/opencode")" = "NEW_BIN" ] || { echo "SELFTEST: binary not updated" >&2; return 1; }

  # (b) Failure path: a non-existent built dist must revert to original — no
  # half-applied state. Reset first.
  rm -rf "$ext"; mkdir -p "$ext/dist"; echo "ORIGINAL_DIST" > "$ext/dist/marker.txt"
  mkdir -p "$ext/vendor/opencode/$key"; echo "ORIGINAL_BIN" > "$ext/vendor/opencode/$key/opencode"
  if HOME="$sandbox/home" deploy_dist_and_binary "$ext" "$sandbox/nonexistent-dist" "$built/bin/opencode" "$key" 2>/dev/null; then
    echo "SELFTEST: deploy from a nonexistent dist should have failed" >&2; return 1
  fi
  [ "$(cat "$ext/dist/marker.txt")" = "ORIGINAL_DIST" ] || { echo "SELFTEST: dist not reverted after failure" >&2; return 1; }
  [ "$(cat "$ext/vendor/opencode/$key/opencode")" = "ORIGINAL_BIN" ] || { echo "SELFTEST: binary changed despite dist failure (version skew!)" >&2; return 1; }

  # (c) Crash recovery: simulate a stranded dist and prove rerun recovers it.
  rm -rf "$ext"; mkdir -p "$ext"
  mkdir -p "$ext/dist.pre-swap-999-999"; echo "STRANDED_ORIGINAL" > "$ext/dist.pre-swap-999-999/marker.txt"
  # live dist missing -> recovery restores the stranded one
  recover_stranded_dist "$ext"
  [ -d "$ext/dist" ] && [ "$(cat "$ext/dist/marker.txt" 2>/dev/null)" = "STRANDED_ORIGINAL" ] || {
    echo "SELFTEST: stranded dist not recovered" >&2; return 1; }
  [ -z "$(find "$ext" -maxdepth 1 -name 'dist.pre-swap-*' 2>/dev/null)" ] || {
    echo "SELFTEST: stranded copies not swept after recovery" >&2; return 1; }

  echo "SELFTEST_DEPLOY_OK"
  return 0
}

# ── Deploy driver (production path) ─────────────────────────────────────────
deploy_into_installed_ext() {
  local ext key built_dist built_bin
  ext="$(find_installed_ext)"
  if [ -z "$ext" ] || [ ! -d "$ext/dist" ]; then
    echo "==> WARNING: could not find an installed amicode extension to deploy into (built artifacts remain in $EXT_PKG)."
    return 0
  fi
  key="$(platform_key)"
  built_dist="$EXT_PKG/dist"
  built_bin="$EXT_PKG/vendor/opencode/$key/opencode"

  # Backup the installed extension (keep 3) before the swap.
  local parent backup_ext
  parent="$(dirname "$ext")"
  backup_ext="$parent/.amicode-backup-$TS"
  cp -R "$ext" "$backup_ext" && echo "==> Backed up installed extension to $backup_ext"
  # Prune extension backups (keep 3), by name.
  # (while-read, not `mapfile`: macOS ships bash 3.2, which has no mapfile.)
  local ext_backups=() _eb
  while IFS= read -r _eb; do ext_backups+=("$_eb"); done \
    < <(find "$parent" -maxdepth 1 -type d -name '.amicode-backup-*' -exec basename {} \; 2>/dev/null | sort)
  if [ "${#ext_backups[@]}" -gt 3 ]; then
    local drop=$(( ${#ext_backups[@]} - 3 )) i
    for ((i = 0; i < drop; i++)); do
      local victim="${ext_backups[$i]}"
      case "$victim" in
        .amicode-backup-*) rm -rf "${parent:?}/$victim" ;;
        *) die "ext-backup prune refused: '$victim' does not match the owned prefix" ;;
      esac
    done
  fi

  if ! deploy_dist_and_binary "$ext" "$built_dist" "$built_bin" "$key"; then
    die "Deploy failed — the previous dist and binary were rolled back together."
  fi
  echo "==> Deployed new dist + binary to $ext"

  # Sync content dirs + package.json (non-atomic; partial update tolerable).
  local dir f
  for dir in skills scores templates exemplars opencode-plugin julia tools; do
    [ -d "$EXT_PKG/$dir" ] && cp -R "$EXT_PKG/$dir" "$ext/" 2>/dev/null || true
  done
  for f in AGENTS.md DISTILLER.md CONTRACT.md package.json; do
    [ -f "$EXT_PKG/$f" ] && cp -f "$EXT_PKG/$f" "$ext/$f" 2>/dev/null || true
  done
  echo "==> Synced content dirs + package.json to installed extension"
}

# ── Main flow ───────────────────────────────────────────────────────────────
main() {
  [ -d "$AMICODE_ROOT/packages/extension" ] || die "not an amicode repo: $AMICODE_ROOT has no packages/extension (set AMICODE_ROOT)."

  echo "==> Rebuild mode: $MODE (root: $AMICODE_ROOT)"
  preflight_deps

  # Interlock BEFORE any destructive step.
  check_no_live_server

  # DB backup before the build.
  backup_session_dbs

  # Git step — the ONE place the modes diverge.
  if [ "$MODE" = "main" ]; then
    main_mode_git_sync || die "main-mode git sync refused (see above)."
  else
    echo "==> [local] building the working tree exactly as it sits (no git mutation)"
  fi

  # Build.
  build_amicode

  # Deploy into the installed extension.
  deploy_into_installed_ext

  # Restore DBs if the build zeroed them.
  restore_session_dbs

  # Deploy transparency (OB13): surface what overwrote the install.
  local head_sha branch dirty_count
  head_sha="$(git -C "$AMICODE_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  branch="$(git -C "$AMICODE_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  dirty_count="$(git -C "$AMICODE_ROOT" status --porcelain 2>/dev/null | grep -c . || echo 0)"
  echo ""
  echo "Done — deployed: branch=$branch HEAD=$head_sha dirty-files=$dirty_count (mode=$MODE)."
  echo "Reload the VS Code window (Cmd/Ctrl+Shift+P → Developer: Reload Window) to pick up changes."
}

# ── Dispatch (after every function is defined) ──────────────────────────────

# Deploy self-test (OB7, hidden; used by the acceptance harness). Needs no mode.
if [ "$SELF_TEST_DEPLOY" -eq 1 ]; then
  self_test_deploy
  exit $?
fi

# Mode validation: exactly two modes.
case "$MODE" in
  local|main) : ;;
  "") usage; die "no --mode given (expected local or main)" ;;
  *) usage; die "unknown mode '$MODE' (expected local or main)" ;;
esac

if [ "$DRY_RUN" -eq 1 ]; then
  echo "mode=$MODE (dry-run: argument parse OK, no work performed)"
  exit 0
fi

# --check-git-only / --check-deps-only are handled inside their guard sections,
# which run within main() below.
main

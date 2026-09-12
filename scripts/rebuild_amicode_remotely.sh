#!/usr/bin/env bash
set -euo pipefail

# Rebuild amicode from main — the terminal fallback for the "Rebuild from Main"
# button. Use this when the extension UI is broken.
#
# What this does (matching the button's behavior since #1016):
# 1. Pull amicode main (--ff-only, not --rebase)
# 2. Download the fork binary from the GitHub Release pinned in opencode.lock.json
#    (NO fork clone, NO bun — the binary comes from the release)
# 3. pnpm install + build the amicode extension
# 4. Build the app bundle from the committed overlay (no fork worktree needed)
# 5. Back up the installed extension, then atomic-swap the new build in
#
# No settings.json writes — the extension discovers its paths at runtime (#1022).

AMICODE_ROOT="${AMICODE_ROOT:-$HOME/harmoniqs/amicode}"
EXT_PKG="$AMICODE_ROOT/packages/extension"

# ── Pre-flight ─────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node >= 20."; exit 1; }
NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NODE_MAJOR" -ge 20 ] || { echo "ERROR: Node >= 20 required (found v$(node --version))."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git not found."; exit 1; }

# ── Session DB backup ──────────────────────────────────────────────────────────
DBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
BACKUP="$DBDIR/.backup-$(date +%Y%m%d-%H%M%S)"

if ls "$DBDIR"/opencode*.db 1>/dev/null 2>&1; then
  mkdir -p "$BACKUP"
  for f in "$DBDIR"/opencode*.db "$DBDIR"/opencode*.db-wal "$DBDIR"/opencode*.db-shm; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/"
  done
  echo "==> Session DBs backed up to $BACKUP"
  # Prune old backups — keep only the 3 most recent
  MAX_BACKUPS=3
  BACKUP_COUNT=$(find "$DBDIR" -maxdepth 1 -name '.backup-*' -type d | wc -l | tr -d ' ')
  if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
    find "$DBDIR" -maxdepth 1 -name '.backup-*' -type d -print0 \
      | xargs -0 ls -dt \
      | tail -n +"$((MAX_BACKUPS + 1))" \
      | while read -r old; do
          rm -rf "$old"
          echo "==> Pruned old backup: $(basename "$old")"
        done
  fi
else
  echo "==> No session DBs found to back up (first install?)"
fi

# ── Pull amicode main (--ff-only) ─────────────────────────────────────────────
echo ""
echo "==> Pulling amicode (main)..."
cd "$AMICODE_ROOT"
git fetch origin
git checkout main
git pull --ff-only origin main

# ── Download fork binary from the pinned release ──────────────────────────────
echo ""
echo "==> Downloading fork binary from pinned release..."
cd "$EXT_PKG"
node scripts/fetch_opencode.mjs --release
echo "==> Binary downloaded and verified."

# ── Install amicode dependencies ──────────────────────────────────────────────
echo ""
echo "==> Installing amicode dependencies..."
cd "$AMICODE_ROOT"
pnpm install

# ── Build amicode extension ───────────────────────────────────────────────────
echo ""
echo "==> Building amicode extension..."
cd "$AMICODE_ROOT"
pnpm -r build

# ── Build app bundle (materializes from overlay — no fork checkout needed) ────
echo ""
echo "==> Building app bundle from overlay..."
cd "$AMICODE_ROOT"
pnpm --filter amicode run build:app

# ── Deploy into installed extension (backup + atomic swap) ────────────────────
INSTALLED_EXT="$(find "${VSCODE_EXT_DIR:-$HOME/.vscode/extensions}" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d | sort -V | tail -1)"
if [ -z "$INSTALLED_EXT" ]; then
  # Try vscode-server (WSL/Remote-SSH) and Insiders
  for candidate in "$HOME/.vscode-server/extensions" "$HOME/.vscode-insiders/extensions"; do
    found="$(find "$candidate" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d 2>/dev/null | sort -V | tail -1)"
    [ -n "$found" ] && { INSTALLED_EXT="$found"; break; }
  done
fi

if [ -n "$INSTALLED_EXT" ] && [ -d "$INSTALLED_EXT/dist" ]; then
  BUILT_DIST="$EXT_PKG/dist"
  PARENT_DIR="$(dirname "$INSTALLED_EXT")"
  BACKUP_EXT="$PARENT_DIR/.amicode-backup-$(date +%Y%m%d-%H%M%S)"

  # Back up the installed extension
  cp -R "$INSTALLED_EXT" "$BACKUP_EXT"
  echo "==> Backed up installed extension to $BACKUP_EXT"

  # Prune excess extension backups (keep 3)
  find "$PARENT_DIR" -maxdepth 1 -name '.amicode-backup-*' -type d -print0 \
    | xargs -0 ls -dt 2>/dev/null \
    | tail -n +4 \
    | while read -r old; do rm -rf "$old"; done

  # Atomic swap: rename old dist out, rename new dist in
  OLD_DIST="$INSTALLED_EXT/dist.pre-swap"
  mv "$INSTALLED_EXT/dist" "$OLD_DIST"
  if cp -R "$BUILT_DIST" "$INSTALLED_EXT/dist"; then
    rm -rf "$OLD_DIST"
    echo "==> Deployed new dist to $INSTALLED_EXT/dist/"
  else
    # Rollback
    mv "$OLD_DIST" "$INSTALLED_EXT/dist"
    echo "==> ERROR: Deploy failed — rolled back to previous dist."
    exit 1
  fi

  # Sync content directories + markdown + package.json
  for dir in skills scores templates exemplars opencode-plugin julia tools; do
    [ -d "$EXT_PKG/$dir" ] && cp -R "$EXT_PKG/$dir" "$INSTALLED_EXT/$dir"
  done
  for f in AGENTS.md DISTILLER.md CONTRACT.md package.json; do
    [ -f "$EXT_PKG/$f" ] && cp -f "$EXT_PKG/$f" "$INSTALLED_EXT/$f"
  done
  echo "==> Synced content dirs + package.json to installed extension"
else
  echo "==> WARNING: could not find installed amicode extension to deploy into"
fi

# ── Restore session DBs if they were zeroed ────────────────────────────────────
if [ -d "$BACKUP" ]; then
  restored=0
  for f in "$BACKUP"/opencode*.db; do
    [ -f "$f" ] || continue
    basename="$(basename "$f")"
    target="$DBDIR/$basename"
    if [ ! -s "$target" ] && [ -s "$f" ]; then
      cp -p "$f" "$target"
      [ -f "$f-wal" ] && cp -p "$f-wal" "$target-wal"
      [ -f "$f-shm" ] && cp -p "$f-shm" "$target-shm"
      restored=$((restored + 1))
    fi
  done
  if [ $restored -gt 0 ]; then
    echo ""
    echo "==> Restored $restored session DB(s) from backup (they were zeroed by the build)."
  fi
fi

echo ""
echo "Done. Reload the VS Code window (Cmd+Shift+P → Developer: Reload Window) to pick up changes."

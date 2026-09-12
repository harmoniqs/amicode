#!/usr/bin/env bash
set -euo pipefail

# Rebuild amicode from local sources (no git pull) — the terminal fallback for
# the "Rebuild Locally" button. Use this when the extension UI is broken.
#
# What this does (matching the button's behavior):
# 1. Build the opencode binary from the local fork checkout (bun)
# 2. pnpm install + build the amicode extension
# 3. Build the app bundle from the fork worktree
# 4. Back up the installed extension, then atomic-swap the new build in
#
# No settings.json writes — the extension discovers its paths at runtime (#1022).

OPENCODE_ROOT="${OPENCODE_ROOT:-$HOME/harmoniqs/opencode}"
AMICODE_ROOT="${AMICODE_ROOT:-$HOME/harmoniqs/amicode}"
EXT_PKG="$AMICODE_ROOT/packages/extension"

# ── Pre-flight ─────────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Install Node >= 20."; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git not found."; exit 1; }
command -v bun >/dev/null 2>&1 || BUN="$HOME/.bun/bin/bun"
BUN="${BUN:-bun}"
command -v "$BUN" >/dev/null 2>&1 || { echo "ERROR: bun not found. Install: curl -fsSL https://bun.sh/install | bash"; exit 1; }
[ -d "$OPENCODE_ROOT/.git" ] || { echo "ERROR: opencode fork not found at $OPENCODE_ROOT"; exit 1; }

# ── Session DB backup ──────────────────────────────────────────────────────────
DBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
BACKUP="$DBDIR/.backup-$(date +%Y%m%d-%H%M%S)"

if ls "$DBDIR"/opencode*.db 1>/dev/null 2>&1; then
  mkdir -p "$BACKUP"
  for f in "$DBDIR"/opencode*.db "$DBDIR"/opencode*.db-wal "$DBDIR"/opencode*.db-shm; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/"
  done
  echo "==> Session DBs backed up to $BACKUP"
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

# ── Build opencode binary ──────────────────────────────────────────────────────
echo ""
echo "==> Building opencode binary from local tree..."
cd "$OPENCODE_ROOT"
"$BUN" install
cd "$OPENCODE_ROOT/packages/opencode"
OPENCODE_CHANNEL=dev "$BUN" run script/build.ts --single --skip-install

# ── Codesign the built binary (macOS, best-effort) ─────────────────────────────
PLATFORM_KEY="$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
BUILT="$OPENCODE_ROOT/packages/opencode/dist/opencode-$PLATFORM_KEY/bin/opencode"
if [ -f "$BUILT" ]; then
  codesign --sign - --force "$BUILT" 2>/dev/null || true
  xattr -d com.apple.quarantine "$BUILT" 2>/dev/null || true
  echo "==> Binary: $BUILT"
else
  echo "==> WARNING: built binary not found at $BUILT"
fi

# ── Build amicode extension ────────────────────────────────────────────────────
echo ""
echo "==> Building amicode extension from local tree..."
cd "$AMICODE_ROOT"
pnpm install
"$BUN" run build

# ── Build app bundle from the fork tree ────────────────────────────────────────
echo ""
echo "==> Building app bundle from fork tree..."
cd "$AMICODE_ROOT"
pnpm --filter amicode run build:app -- --work "$OPENCODE_ROOT" --direct-worktree

# ── Deploy into installed extension (backup + atomic swap) ────────────────────
INSTALLED_EXT="$(find "${VSCODE_EXT_DIR:-$HOME/.vscode/extensions}" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d | sort -V | tail -1)"
if [ -z "$INSTALLED_EXT" ]; then
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

  # Copy the vendored binary into the installed extension's vendor dir
  if [ -f "$BUILT" ]; then
    VENDOR_DIR="$INSTALLED_EXT/vendor/opencode/$PLATFORM_KEY"
    mkdir -p "$VENDOR_DIR"
    cp -f "$BUILT" "$VENDOR_DIR/opencode"
    chmod 755 "$VENDOR_DIR/opencode"
    echo "==> Copied binary to $VENDOR_DIR/opencode"
  fi

  echo "==> Synced content dirs + binary + package.json to installed extension"
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

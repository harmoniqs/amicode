#!/usr/bin/env bash
set -euo pipefail

# Rebuild both opencode and amicode after pulling latest from remote.
# Use this when the extension isn't running or you want a terminal-based rebuild.
# The in-app "Rebuild Remotely" button does the same thing via the extension bridge.

OPENCODE_ROOT="${OPENCODE_ROOT:-$HOME/harmoniqs/opencode}"
AMICODE_ROOT="${AMICODE_ROOT:-$HOME/harmoniqs/amicode}"

# ── Session DB backup ──────────────────────────────────────────────────────────
DBDIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"
BACKUP="$DBDIR/.backup-$(date +%Y%m%d-%H%M%S)"

if ls "$DBDIR"/opencode*.db 1>/dev/null 2>&1; then
  mkdir -p "$BACKUP"
  for f in "$DBDIR"/opencode*.db "$DBDIR"/opencode*.db-wal "$DBDIR"/opencode*.db-shm; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/"
  done
  echo "==> Session DBs backed up to $BACKUP"
else
  echo "==> No session DBs found to back up (first install?)"
fi

# ── Pull sources ───────────────────────────────────────────────────────────────
echo ""
echo "==> Pulling opencode (local/amicode)..."
cd "$OPENCODE_ROOT"
git fetch origin
git checkout local/amicode
git pull --rebase origin local/amicode

echo ""
echo "==> Pulling amicode (main)..."
cd "$AMICODE_ROOT"
git fetch origin
git checkout main
git pull --rebase origin main

# ── Build opencode binary ──────────────────────────────────────────────────────
echo ""
echo "==> Building opencode binary..."
cd "$OPENCODE_ROOT/packages/opencode"
bun run script/build.ts --single --skip-install

# ── Build amicode extension ────────────────────────────────────────────────────
echo ""
echo "==> Building amicode extension..."
cd "$AMICODE_ROOT"
bun run build

# ── Codesign the built binary (macOS) ──────────────────────────────────────────
BUILT="$OPENCODE_ROOT/packages/opencode/dist/opencode-darwin-arm64/bin/opencode"
if [ -f "$BUILT" ]; then
  codesign --sign - --force "$BUILT" 2>/dev/null || true
  echo "==> Codesigned: $BUILT"
  echo "    ($("$BUILT" --version 2>/dev/null || echo 'version unknown'))"
else
  echo "==> WARNING: built binary not found at $BUILT"
fi

# ── Copy built extension into the installed extension dir ──────────────────────
INSTALLED_EXT="$(find "$HOME/.vscode/extensions" -maxdepth 1 -name 'harmoniqs.amicode-*' -type d | sort -V | tail -1)"
if [ -n "$INSTALLED_EXT" ] && [ -d "$INSTALLED_EXT/dist" ]; then
  BUILT_DIST="$AMICODE_ROOT/packages/extension/dist"
  BACKUP_DIST="$INSTALLED_EXT/dist.marketplace-backup"
  if [ ! -d "$BACKUP_DIST" ]; then
    cp -R "$INSTALLED_EXT/dist" "$BACKUP_DIST"
    echo "==> Backed up marketplace extension dist to $BACKUP_DIST"
  fi
  copied=0
  for f in "$BUILT_DIST"/*.js "$BUILT_DIST"/*.js.map; do
    [ -f "$f" ] || continue
    cp -f "$f" "$INSTALLED_EXT/dist/"
    copied=$((copied + 1))
  done
  echo "==> Copied $copied file(s) to installed extension at $INSTALLED_EXT/dist/"
else
  echo "==> WARNING: could not find installed amicode extension to copy into"
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

# ── Re-apply VS Code settings to point at the dev build ────────────────────────
VSCODE_SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
if [ -f "$VSCODE_SETTINGS" ] && command -v python3 &>/dev/null; then
  python3 -c "
import json, sys
path = sys.argv[1]
with open(path) as f:
    settings = json.load(f)
settings['amicode.opencodeBinary'] = sys.argv[2]
settings['amicode.devAssetRoot'] = sys.argv[3]
with open(path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
" "$VSCODE_SETTINGS" "$BUILT" "$AMICODE_ROOT/packages/extension"
  echo "==> VS Code settings updated: amicode.opencodeBinary + amicode.devAssetRoot"
else
  echo "==> WARNING: could not update VS Code settings automatically."
  echo "   Set amicode.opencodeBinary to: $BUILT"
  echo "   Set amicode.devAssetRoot to: $AMICODE_ROOT/packages/extension"
fi

echo ""
echo "Done. Reload the VS Code window (Cmd+Shift+P → Developer: Reload Window) to pick up changes."
echo ""
echo "Tip: The in-app Developer Tools settings can do this for you — flip the toggle and click 'Rebuild Remotely'."

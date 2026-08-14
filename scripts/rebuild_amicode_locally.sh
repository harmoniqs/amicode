#!/usr/bin/env bash
set -euo pipefail

# Rebuild both opencode and amicode from local sources (no git pull).
# Use this when the extension isn't running or you want a terminal-based rebuild.
# The in-app "Rebuild Locally" button does the same thing via the extension bridge.

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

# ── Build opencode binary ──────────────────────────────────────────────────────
echo ""
echo "==> Building opencode binary from local tree..."
cd "$OPENCODE_ROOT/packages/opencode"
bun run script/build.ts --single --skip-install

# ── Build amicode extension ────────────────────────────────────────────────────
echo ""
echo "==> Building amicode extension from local tree..."
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
echo ""
echo "Tip: The in-app Developer Tools settings can do this for you — flip the toggle and click 'Rebuild Locally'."

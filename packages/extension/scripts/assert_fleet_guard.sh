#!/usr/bin/env bash
# CI gate — fleet guard + tunnel template must be sane.
# Fails if the guard would not prevent the silent-fork on a fleet client.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$ROOT/tools/fleet/amico-opencode-fleet-guard"
PLIST="$ROOT/tools/fleet/co.harmoniqs.amico-tunnel.plist"
INSTALL="$ROOT/tools/fleet/install.sh"

fail() { echo "[fleet-gate] FAIL $*" >&2; exit 1; }
ok() { echo "[fleet-gate] ok $*"; }

[[ -f "$GUARD" ]] || fail "guard missing at $GUARD (fleet hardening not merged?)"
[[ -x "$GUARD" ]] || fail "guard not executable — chmod +x $GUARD"
grep -q 'Aarons-Mac-mini' "$GUARD" || fail "guard does not mention canonical host Aarons-Mac-mini"
grep -q 'exit 1' "$GUARD" || fail "guard missing client exit 1 (would not prevent fork)"
grep -q 'FROZEN.*\.amico/server/bin/opencode' "$GUARD" || fail "guard missing frozen binary path"
ok "guard $GUARD"

[[ -f "$INSTALL" ]] || fail "installer missing at $INSTALL"
[[ -x "$INSTALL" ]] || fail "installer not executable — chmod +x $INSTALL"
ok "installer $INSTALL"

[[ -f "$PLIST" ]] || fail "tunnel plist template missing at $PLIST"
grep -q "ServerAliveInterval=15" "$PLIST" || fail "plist ServerAliveInterval 15 missing"
grep -q "ServerAliveCountMax=2" "$PLIST" || fail "plist ServerAliveCountMax 2 missing"
grep -q "TCPKeepAlive=yes" "$PLIST" || fail "plist TCPKeepAlive yes missing"
grep -q "127.0.0.1:4096:127.0.0.1:4096" "$PLIST" || fail "plist LocalForward 4096 missing"
ok "tunnel plist $PLIST"

# Guard + tunnel template are the source of truth for the installer; ensure the
# installer itself is consistent (it references both).
grep -q "FLEET_GUARD_REL" "$ROOT/packages/extension/src/fleet_health.ts" || fail "fleet_health.ts missing FLEET_GUARD_REL"
grep -q "FLEET_PORT.*4096" "$ROOT/packages/extension/src/fleet_health.ts" || fail "fleet_health.ts missing FLEET_PORT 4096"

# Packaged copy must stay in sync with repo root (the VSIX ships the packaged copy).
PKG_GUARD="$ROOT/packages/extension/tools/fleet/amico-opencode-fleet-guard"
PKG_PLIST="$ROOT/packages/extension/tools/fleet/co.harmoniqs.amico-tunnel.plist"
PKG_INSTALL="$ROOT/packages/extension/tools/fleet/install.sh"
for f in "$PKG_GUARD" "$PKG_PLIST" "$PKG_INSTALL"; do
  [[ -f "$f" ]] || fail "packaged fleet file missing at $f (run: cp tools/fleet/* packages/extension/tools/fleet/)"
done
cmp -s "$GUARD" "$PKG_GUARD" || fail "packaged guard drift — cp tools/fleet/amico-opencode-fleet-guard packages/extension/tools/fleet/"
cmp -s "$PLIST" "$PKG_PLIST" || fail "packaged plist drift — cp tools/fleet/co.harmoniqs.amico-tunnel.plist packages/extension/tools/fleet/"
cmp -s "$INSTALL" "$PKG_INSTALL" || fail "packaged installer drift — cp tools/fleet/install.sh packages/extension/tools/fleet/"

echo "[fleet-gate] all fleet gates passed"

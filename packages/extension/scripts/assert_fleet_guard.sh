#!/usr/bin/env bash
# CI gate — fleet guard + installer + tunnel template must be sane.
# Fails if the guard would not prevent the silent-fork on a fleet client, and
# (amicode#1106, fleet rearchitect P3b-2) if any bash consumer still parses the
# raw machine-local fleet config: the guard + installer read the PROJECTION
# (the verb-refreshed cache / the verb's machine-parseable output) — the ONE
# parser is amicissimo's, behind the `amico fleet` CLI.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
GUARD="$ROOT/tools/fleet/amico-opencode-fleet-guard"
PLIST="$ROOT/tools/fleet/co.harmoniqs.amico-tunnel.plist"
INSTALL="$ROOT/tools/fleet/install.sh"

fail() { echo "[fleet-gate] FAIL $*" >&2; exit 1; }
ok() { echo "[fleet-gate] ok $*"; }

[[ -f "$GUARD" ]] || fail "guard missing at $GUARD (fleet hardening not merged?)"
[[ -x "$GUARD" ]] || fail "guard not executable — chmod +x $GUARD"
grep -q 'projection.json' "$GUARD" || fail "guard does not reference the projection cache (the #1106 read path)"
grep -q 'fleet status --projection' "$GUARD" || fail "guard does not shell the fleet-authority verb (the CLI is the only door)"
grep -q 'contract_version' "$GUARD" || fail "guard missing the contract-version pin (must not trust an artifact it cannot speak)"
grep -q 'exit 1' "$GUARD" || fail "guard missing client exit 1 (would not prevent fork)"
grep -q 'FROZEN.*\.amico/server/bin/opencode' "$GUARD" || fail "guard missing frozen binary path"
grep -q 'PROJECTION' "$GUARD" || fail "guard missing PROJECTION variable"
if grep -qE '"role"[[:space:]]*:.*fleet\.json|fleet\.json.*"role"' "$GUARD" 2>/dev/null; then
  fail "guard parses the raw fleet config for its role (the #1106 anti-goal — the projection cache is the only read)"
fi
ok "guard $GUARD (projection cache + verb door + contract pin)"

[[ -f "$INSTALL" ]] || fail "installer missing at $INSTALL"
[[ -x "$INSTALL" ]] || fail "installer not executable — chmod +x $INSTALL"
grep -q 'fleet status --projection' "$INSTALL" || fail "installer does not shell the fleet-authority verb (#1106 — machine-parseable output, never a raw grep)"
if grep -qE 'grep.*"role".*FLEET_CONFIG|FLEET_CONFIG.*grep' "$INSTALL" 2>/dev/null; then
  fail "installer greps the raw fleet config for its role (the #1106 anti-goal)"
fi
if grep -q 'FLEET_CONFIG=' "$INSTALL" 2>/dev/null; then
  fail "installer still names a FLEET_CONFIG raw path (the #1106 anti-goal — the verb is the only door)"
fi
ok "installer $INSTALL (verb output + bootstrap exception branches)"

[[ -f "$PLIST" ]] || fail "tunnel plist template missing at $PLIST"
grep -q "ServerAliveInterval=15" "$PLIST" || fail "plist ServerAliveInterval 15 missing"
grep -q "ServerAliveCountMax=2" "$PLIST" || fail "plist ServerAliveCountMax 2 missing"
grep -q "TCPKeepAlive=yes" "$PLIST" || fail "plist TCPKeepAlive yes missing"
grep -q "127.0.0.1:4096:127.0.0.1:4096" "$PLIST" || fail "plist LocalForward 4096 missing"
ok "tunnel plist $PLIST"

# #1775: the per-peer forward template carries the SAME standard options.
PEER_PLIST="$ROOT/tools/fleet/co.harmoniqs.amico-peer-forward.plist"
[[ -f "$PEER_PLIST" ]] || fail "peer-forward plist template missing at $PEER_PLIST"
grep -q "ServerAliveInterval=15" "$PEER_PLIST" || fail "peer-forward plist ServerAliveInterval 15 missing"
grep -q "ServerAliveCountMax=2" "$PEER_PLIST" || fail "peer-forward plist ServerAliveCountMax 2 missing"
grep -q "TCPKeepAlive=yes" "$PEER_PLIST" || fail "peer-forward plist TCPKeepAlive yes missing"
grep -q "ExitOnForwardFailure=yes" "$PEER_PLIST" || fail "peer-forward plist ExitOnForwardFailure yes missing"
grep -q "co.harmoniqs.amico-peer-PEER_MACHINE_ID-forward" "$PEER_PLIST" || fail "peer-forward plist label is not the co.harmoniqs.amico-peer-<machine_id>-forward convention"
ok "peer-forward plist $PEER_PLIST"

# The extension's health checks consume the projection topology state
# (fleet_topology.ts) — the consumer import must be present (#1106).
grep -q "fleet_topology" "$ROOT/packages/extension/src/fleet_health.ts" || fail "fleet_health.ts missing the fleet_topology consumer import (#1106)"

# Packaged copy must stay in sync with repo root (the VSIX ships the packaged copy).
PKG_GUARD="$ROOT/packages/extension/tools/fleet/amico-opencode-fleet-guard"
PKG_PLIST="$ROOT/packages/extension/tools/fleet/co.harmoniqs.amico-tunnel.plist"
PKG_INSTALL="$ROOT/packages/extension/tools/fleet/install.sh"
PKG_PEER_PLIST="$ROOT/packages/extension/tools/fleet/co.harmoniqs.amico-peer-forward.plist"
for f in "$PKG_GUARD" "$PKG_PLIST" "$PKG_INSTALL" "$PKG_PEER_PLIST"; do
  [[ -f "$f" ]] || fail "packaged fleet file missing at $f (run: cp tools/fleet/* packages/extension/tools/fleet/)"
done
cmp -s "$GUARD" "$PKG_GUARD" || fail "packaged guard drift — cp tools/fleet/amico-opencode-fleet-guard packages/extension/tools/fleet/"
cmp -s "$PLIST" "$PKG_PLIST" || fail "packaged plist drift — cp tools/fleet/co.harmoniqs.amico-tunnel.plist packages/extension/tools/fleet/"
cmp -s "$PEER_PLIST" "$PKG_PEER_PLIST" || fail "packaged peer-forward plist drift — cp tools/fleet/co.harmoniqs.amico-peer-forward.plist packages/extension/tools/fleet/"
cmp -s "$INSTALL" "$PKG_INSTALL" || fail "packaged installer drift — cp tools/fleet/install.sh packages/extension/tools/fleet/"

echo "[fleet-gate] all fleet gates passed"

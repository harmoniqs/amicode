#!/usr/bin/env bash
# Fleet installer — idempotent, safe to re-run.
# Reads fleet topology from ~/.amico/ops/fleet/fleet.json (no file = standalone, skip).
# Installs/updates the fleet guard + tunnel on this host and fixes machine-scoped settings.
# Usage:
#   bash tools/fleet/install.sh          # install/repair (writes files, reloads launchd)
#   bash tools/fleet/install.sh --check   # check only (no writes), exit 1 on drift
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD_SRC="$REPO_ROOT/tools/fleet/amico-opencode-fleet-guard"
GUARD_DST="$HOME/.local/bin/amico-opencode-fleet-guard"
PLIST_SRC="$REPO_ROOT/tools/fleet/co.harmoniqs.amico-tunnel.plist"
PLIST_DST="$HOME/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist"
SETTINGS="$HOME/Library/Application Support/Code/User/settings.json"
FLEET_CONFIG="$HOME/.amico/ops/fleet/fleet.json"
CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; fi

die() { echo "[fleet] $*" >&2; exit 1; }
say() { echo "[fleet] $*"; }

# --- read fleet config ---
ROLE="standalone"
FLEET_PORT=4096
if [[ -f "$FLEET_CONFIG" ]]; then
  ROLE="$(grep -o '"role"[[:space:]]*:[[:space:]]*"[^"]*"' "$FLEET_CONFIG" 2>/dev/null | head -1 | sed 's/.*"role"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' || echo standalone)"
  PORT_PARSED="$(grep -o '"port"[[:space:]]*:[[:space:]]*[0-9]*' "$FLEET_CONFIG" 2>/dev/null | head -1 | sed 's/.*:[[:space:]]*//' || echo 4096)"
  if [[ -n "$PORT_PARSED" ]]; then FLEET_PORT="$PORT_PARSED"; fi
fi

# Standalone: nothing to install — the guard/tunnel are irrelevant.
if [[ "$ROLE" == "standalone" ]]; then
  if [[ $CHECK -eq 1 ]]; then
    say "standalone (no fleet.json or role=standalone) — fleet checks skipped"
  else
    say "standalone mode — nothing to install (use 'Amicode: Fleet — Enroll' to join a fleet)"
  fi
  exit 0
fi

say "fleet role: $ROLE (port: $FLEET_PORT)"

# --- guard ---
if [[ ! -f "$GUARD_SRC" ]]; then die "repo guard missing at $GUARD_SRC (git pull?)"; fi
if [[ $CHECK -eq 1 ]]; then
  # On non-darwin (CI linux) the installed guard is irrelevant — the fleet is darwin fleet.
  if [[ "$(uname -s)" != "Darwin" ]]; then
    say "ok guard repo exists (host check skipped on $(uname -s))"
  else
    if [[ ! -f "$GUARD_DST" ]]; then echo "[fleet] FAIL guard not installed at $GUARD_DST"; exit 1; fi
    if ! cmp -s "$GUARD_SRC" "$GUARD_DST"; then echo "[fleet] FAIL guard stale (differs from repo)"; diff -u "$GUARD_DST" "$GUARD_SRC" | head -n 20; exit 1; fi
    if [[ ! -x "$GUARD_DST" ]]; then echo "[fleet] FAIL guard not executable"; exit 1; fi
    say "ok guard $GUARD_DST in sync"
  fi
else
  mkdir -p "$(dirname "$GUARD_DST")"
  cp "$GUARD_SRC" "$GUARD_DST"
  chmod +x "$GUARD_DST"
  say "installed guard $GUARD_DST"
fi

# --- machine-scoped settings (only on darwin; harmless elsewhere) ---
# NOTE: we set amicode.opencodeBinary (to the fleet guard) but NEVER touch
# amicode.opencodePort. In fleet-client mode the extension reads the tunnel port
# from fleet.json (canonical.port), not from the VS Code setting. The port setting
# is the user's standalone preference and must survive fleet enrollment unchanged
# so the local session isn't killed mid-transition.
if [[ "$(uname -s)" == "Darwin" ]]; then
  want_binary="$GUARD_DST"
  if [[ $CHECK -eq 1 ]]; then
    # check via node (json with comments not strict)
    node -e "
      const fs=require('fs');
      const p=process.argv[1];
      let j={}; try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){let t=fs.readFileSync(p,'utf8'); j=JSON.parse(t.replace(/\/\/.*|\/\*[\s\S]*?\*\//g,''))} 
      const b=j['amicode.opencodeBinary']||'';
      let fail=0;
      if(b!==process.argv[2]){console.error('[fleet] FAIL amicode.opencodeBinary is '+(b||'(empty)')+', want '+process.argv[2]); fail=1}
      process.exit(fail);
    " "$SETTINGS" "$want_binary" || exit 1
    say "ok settings $SETTINGS (binary = guard)"
  else
    if [[ -f "$SETTINGS" ]]; then
      # merge via node — preserve other settings, set binary to guard only
      node -e "
        const fs=require('fs'), p=process.argv[1], b=process.argv[2];
        let j={}; try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){ j={} }
        // tolerate jsonc: strip // and /* */
        try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(_){
          try{ const t=fs.readFileSync(p,'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g,''); j=JSON.parse(t)}catch(__){ j={} }
        }
        j['amicode.opencodeBinary']=b;
        fs.mkdirSync(require('path').dirname(p),{recursive:true});
        fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
        console.log('[fleet] wrote settings '+p);
      " "$SETTINGS" "$want_binary"
    else
      mkdir -p "$(dirname "$SETTINGS")"
      printf '{\n  "amicode.opencodeBinary": "%s"\n}\n' "$want_binary" > "$SETTINGS"
      say "wrote new settings $SETTINGS"
    fi
  fi
fi

# --- tunnel plist (darwin only; repo ships hardened 15/2 + TCPKeepAlive) ---
if [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ ! -f "$PLIST_SRC" ]]; then
    say "note: no plist template at $PLIST_SRC — skipping tunnel install (guard-only fleet)"
  else
    if [[ $CHECK -eq 1 ]]; then
      if [[ ! -f "$PLIST_DST" ]]; then echo "[fleet] FAIL tunnel plist missing at $PLIST_DST"; exit 1; fi
      if ! grep -q "ServerAliveInterval=15" "$PLIST_DST"; then echo "[fleet] FAIL tunnel ServerAliveInterval 15 missing"; exit 1; fi
      if ! grep -q "ServerAliveCountMax=2" "$PLIST_DST"; then echo "[fleet] FAIL tunnel ServerAliveCountMax 2 missing"; exit 1; fi
      if ! grep -q "TCPKeepAlive=yes" "$PLIST_DST"; then echo "[fleet] FAIL tunnel TCPKeepAlive yes missing"; exit 1; fi
      if ! grep -q "127.0.0.1:${FLEET_PORT}:127.0.0.1:${FLEET_PORT}" "$PLIST_DST"; then echo "[fleet] FAIL tunnel LocalForward ${FLEET_PORT} missing"; exit 1; fi
      say "ok tunnel $PLIST_DST (15/2 + TCPKeepAlive, port $FLEET_PORT)"
    else
      mkdir -p "$(dirname "$PLIST_DST")"
      cp "$PLIST_SRC" "$PLIST_DST"
      # reload
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      launchctl load "$PLIST_DST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
      say "installed tunnel $PLIST_DST and (re)loaded"
    fi
  fi
fi

if [[ $CHECK -eq 1 ]]; then
  say "fleet check: all ok"
fi

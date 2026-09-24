#!/usr/bin/env bash
# Fleet installer — idempotent, safe to re-run.
# Reads fleet topology through the ONE parser (#1106, fleet rearchitect
# P3b-2): it shells the fleet-authority verb (`amico fleet status
# --projection` — machine-parseable JSON output; the run also refreshes the
# projection cache at ~/.amico/ops/fleet/projection.json that the extension
# and the guard consume) and NEVER greps the raw machine-local fleet config —
# amicissimo's parser, behind the CLI, is its only reader.
# Exit 75 from the verb = the bootstrap exception → the honest base-standalone
# branch (stated + the grant pointer), IDENTICAL to a CLI-absent machine;
# other non-zero exits die honestly — never a silent raw-file fallthrough.
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
CHECK=0
if [[ "${1:-}" == "--check" ]]; then CHECK=1; fi

die() { echo "[fleet] $*" >&2; exit 1; }
say() { echo "[fleet] $*"; }

# --- read fleet topology through the ONE parser: shell the verb (#1106) ---
# CLI resolution: PATH first, then the repo's own launchers (the dev checkout
# runs this script before anything is on PATH).
AMICO_CLI=""
if command -v amico >/dev/null 2>&1; then
  AMICO_CLI="amico"
elif [[ -x "$REPO_ROOT/packages/extension/bin/launcher/amico" ]]; then
  AMICO_CLI="$REPO_ROOT/packages/extension/bin/launcher/amico"
elif [[ -x "$REPO_ROOT/packages/amico-run/launcher/amico" ]]; then
  AMICO_CLI="$REPO_ROOT/packages/amico-run/launcher/amico"
fi

bootstrap_base_standalone() {
  # The bootstrap exception — base-standalone STATED with the pointer (the
  # mode field is untouched: a floor report, never a mode write). Identical for
  # the CLI-absent and exit-75 branches; exit 0 (the base product is whole).
  if [[ $CHECK -eq 1 ]]; then
    say "base-standalone (bootstrap exception — $1): fleet checks skipped (the base product is whole standalone)"
  else
    say "base-standalone (bootstrap exception — $1): nothing to install"
  fi
  say "  grant path: repo access to harmoniqs/amicissimo + the \`amicissimo\` code in ~/.amico/amicode/entitlements.toml"
  say "  then: 'Amicode: Fleet — Enroll' (re-run this installer to light the fleet surfaces)"
}

ROLE="standalone"
FLEET_PORT=4096
SSH_ALIAS=""
if [[ -z "$AMICO_CLI" ]]; then
  bootstrap_base_standalone "the amico CLI is absent, so the fleet-authority verb cannot run"
  exit 0
fi

VERB_CODE=0
VERB_OUT="$("$AMICO_CLI" fleet status --projection 2>/dev/null)" || VERB_CODE=$?
if [[ "$VERB_CODE" -eq 75 ]]; then
  bootstrap_base_standalone "the fleet-authority verb exited 75 (no fleet grant)"
  exit 0
fi
if [[ "$VERB_CODE" -ne 0 ]]; then
  die "the fleet-authority verb failed (exit $VERB_CODE) — run \`$AMICO_CLI fleet status --projection\` for the detail; refusing to guess the topology (never a silent raw-file read)"
fi

# The verb's machine-parseable output: the additive `role` + `canonical` fields
# (contract v1). Unparseable stdout is a broken contract — die honestly.
VERB_FILE="$(mktemp)"
trap 'rm -f "$VERB_FILE"' EXIT
printf '%s' "$VERB_OUT" > "$VERB_FILE"
PARSED="$(node -e '
  const fs = require("fs");
  let j = {};
  try { j = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch (e) { process.exit(64); }
  if (j.ok !== true) process.exit(64);
  const role = typeof j.role === "string" ? j.role : "standalone";
  const port = j.canonical && Number.isFinite(j.canonical.port) ? j.canonical.port : 4096;
  const alias = j.canonical && typeof j.canonical.sshAlias === "string" ? j.canonical.sshAlias : "";
  process.stdout.write(role + "\n" + port + "\n" + alias);
' "$VERB_FILE")" || die "the fleet-authority verb's output is not machine-parseable JSON (\`$AMICO_CLI fleet status --projection\` should print one JSON line with ok/role/canonical) — refusing to guess the topology"
ROLE="$(printf '%s\n' "$PARSED" | sed -n 1p)"
PORT_PARSED="$(printf '%s\n' "$PARSED" | sed -n 2p)"
SSH_ALIAS="$(printf '%s\n' "$PARSED" | sed -n 3p)"
if [[ "$PORT_PARSED" =~ ^[0-9]+$ ]]; then FLEET_PORT="$PORT_PARSED"; fi

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
  # #1261 (AC4): the guard backstop is cross-platform — a client spawns no
  # engine on mac, linux, OR WSL alike, so the installed guard is checked on
  # EVERY OS (no non-darwin host-check skip). Only the launchd TUNNEL below
  # stays darwin-specific (the linux tunnel is #1260).
  if [[ ! -f "$GUARD_DST" ]]; then echo "[fleet] FAIL guard not installed at $GUARD_DST"; exit 1; fi
  if ! cmp -s "$GUARD_SRC" "$GUARD_DST"; then echo "[fleet] FAIL guard stale (differs from repo)"; diff -u "$GUARD_DST" "$GUARD_SRC" | head -n 20; exit 1; fi
  if [[ ! -x "$GUARD_DST" ]]; then echo "[fleet] FAIL guard not executable"; exit 1; fi
  say "ok guard $GUARD_DST in sync"
else
  mkdir -p "$(dirname "$GUARD_DST")"
  cp "$GUARD_SRC" "$GUARD_DST"
  chmod +x "$GUARD_DST"
  say "installed guard $GUARD_DST"
fi

# --- machine-scoped settings (cross-platform — #1261 AC4) ---
# Enrollment writes the platform-correct VS Code User settings so a client's
# amicode.opencodeBinary/opencodePort point at the guard: macOS uses
# Application Support; linux/WSL uses ~/.config/Code/User, plus the Remote-WSL /
# Remote-SSH server-side Machine settings when a VS Code server is present.
SETTINGS_PATHS=()
case "$(uname -s)" in
  Darwin) SETTINGS_PATHS+=("$HOME/Library/Application Support/Code/User/settings.json") ;;
  *)
    SETTINGS_PATHS+=("$HOME/.config/Code/User/settings.json")
    # Remote-WSL / Remote-SSH server-side machine settings, when present.
    if [[ -d "$HOME/.vscode-server" ]]; then
      SETTINGS_PATHS+=("$HOME/.vscode-server/data/Machine/settings.json")
    fi
    ;;
esac
if [[ "$ROLE" == "server" ]]; then
  # #1354: server runs a real engine — no guard, port offset by -2 so the
  # extension's app shelf (configuredPort + 1) gets FLEET_PORT - 1 and the
  # hub service keeps FLEET_PORT for the fleet API (roster, health, enroll).
  want_binary=""
  want_port=$((FLEET_PORT - 2))
else
  want_binary="$GUARD_DST"
  want_port="$FLEET_PORT"
fi
settings_fail=0
for SETTINGS in "${SETTINGS_PATHS[@]}"; do
  if [[ $CHECK -eq 1 ]]; then
    if [[ ! -f "$SETTINGS" ]]; then
      echo "[fleet] FAIL settings $SETTINGS missing (amicode.opencodeBinary/opencodePort not set)"
      settings_fail=1
      continue
    fi
    if node -e "
      const fs=require('fs');
      const p=process.argv[1];
      let j={}; try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){let t=fs.readFileSync(p,'utf8'); j=JSON.parse(t.replace(/\/\/.*|\/\*[\s\S]*?\*\//g,''))}
      const b=j['amicode.opencodeBinary']||''; const port=j['amicode.opencodePort'];
      const wantPort=Number(process.argv[3]);
      let fail=0;
      if(process.argv[2]!=='' && b!==process.argv[2]){console.error('[fleet] FAIL amicode.opencodeBinary is '+(b||'(empty)')+', want '+process.argv[2]); fail=1}
      if(port!==wantPort){console.error('[fleet] FAIL amicode.opencodePort is '+port+', want '+wantPort); fail=1}
      process.exit(fail);
    " "$SETTINGS" "$want_binary" "$want_port"; then
      say "ok settings $SETTINGS (binary + port $want_port)"
    else
      settings_fail=1
    fi
  else
    if [[ -f "$SETTINGS" ]]; then
      # merge via node — preserve other settings, force fleet keys (machine scope)
      node -e "
        const fs=require('fs'), p=process.argv[1], b=process.argv[2], port=Number(process.argv[3]);
        let j={};
        // tolerate jsonc: strip // and /* */
        try{j=JSON.parse(fs.readFileSync(p,'utf8'))}catch(_){
          try{ const t=fs.readFileSync(p,'utf8').replace(/\/\/.*|\/\*[\s\S]*?\*\//g,''); j=JSON.parse(t)}catch(__){ j={} }
        }
        if (b !== '') j['amicode.opencodeBinary']=b; else delete j['amicode.opencodeBinary']; j['amicode.opencodePort']=port;
        fs.mkdirSync(require('path').dirname(p),{recursive:true});
        fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
        console.log('[fleet] wrote settings '+p);
      " "$SETTINGS" "$want_binary" "$want_port"
    else
      mkdir -p "$(dirname "$SETTINGS")"
      if [[ -n "$want_binary" ]]; then
        printf '{\n  "amicode.opencodeBinary": "%s",\n  "amicode.opencodePort": %d\n}\n' "$want_binary" "$want_port" > "$SETTINGS"
      else
        printf '{\n  "amicode.opencodePort": %d\n}\n' "$want_port" > "$SETTINGS"
      fi
      say "wrote new settings $SETTINGS"
    fi
  fi
done
if [[ $CHECK -eq 1 && $settings_fail -eq 1 ]]; then exit 1; fi

# --- tunnel plist (CLIENT role only — a server IS the tunnel's destination,
# not its client, so it needs no self-tunnel; darwin only) ---
if [[ "$ROLE" != "client" ]]; then
  # server (or any non-client enrolled role): guard + settings above are the
  # whole install; the managed tunnel is a client-only concern.
  if [[ $CHECK -eq 1 ]]; then
    say "ok role $ROLE — no managed tunnel (only a client tunnels to the canonical hub)"
  else
    say "role $ROLE — no managed tunnel to install (only a client tunnels to the canonical hub)"
    # A stale tunnel from a previous client enrollment must not linger on a
    # server: unload + remove it if present (idempotent, best-effort).
    if [[ "$(uname -s)" == "Darwin" && -f "$PLIST_DST" ]]; then
      launchctl unload "$PLIST_DST" 2>/dev/null || true
      rm -f "$PLIST_DST"
      say "removed stale tunnel plist $PLIST_DST (role is $ROLE, not client)"
    fi
  fi
elif [[ "$(uname -s)" == "Darwin" ]]; then
  if [[ ! -f "$PLIST_SRC" ]]; then
    say "note: no plist template at $PLIST_SRC — skipping tunnel install (guard-only fleet)"
  else
    if [[ $CHECK -eq 1 ]]; then
      if [[ ! -f "$PLIST_DST" ]]; then echo "[fleet] FAIL tunnel plist missing at $PLIST_DST"; exit 1; fi
      if grep -q "FLEET_SSH_ALIAS" "$PLIST_DST"; then echo "[fleet] FAIL tunnel plist still carries the FLEET_SSH_ALIAS placeholder (alias was never substituted — ssh loops on an unresolvable hostname)"; exit 1; fi
      if ! grep -q "ServerAliveInterval=15" "$PLIST_DST"; then echo "[fleet] FAIL tunnel ServerAliveInterval 15 missing"; exit 1; fi
      if ! grep -q "ServerAliveCountMax=2" "$PLIST_DST"; then echo "[fleet] FAIL tunnel ServerAliveCountMax 2 missing"; exit 1; fi
      if ! grep -q "TCPKeepAlive=yes" "$PLIST_DST"; then echo "[fleet] FAIL tunnel TCPKeepAlive yes missing"; exit 1; fi
      if ! grep -q "127.0.0.1:${FLEET_PORT}:127.0.0.1:${FLEET_PORT}" "$PLIST_DST"; then echo "[fleet] FAIL tunnel LocalForward ${FLEET_PORT} missing"; exit 1; fi
      if [[ -n "$SSH_ALIAS" ]] && ! grep -q "<string>${SSH_ALIAS}</string>" "$PLIST_DST"; then echo "[fleet] FAIL tunnel alias is not ${SSH_ALIAS}"; exit 1; fi
      say "ok tunnel $PLIST_DST (15/2 + TCPKeepAlive, port $FLEET_PORT, alias ${SSH_ALIAS:-unspecified})"
    else
      if [[ -z "$SSH_ALIAS" ]]; then
        die "no sshAlias in the fleet topology (the projection carries no canonical.sshAlias) — refusing to install a tunnel that cannot resolve its host (add canonical.sshAlias and re-enroll)"
      fi
      mkdir -p "$(dirname "$PLIST_DST")"
      _plist_tmp="$(mktemp)"
      sed -e "s/FLEET_SSH_ALIAS/${SSH_ALIAS}/g" -e "s/127\.0\.0\.1:4096:127\.0\.0\.1:4096/127.0.0.1:${FLEET_PORT}:127.0.0.1:${FLEET_PORT}/g" "$PLIST_SRC" > "$_plist_tmp"
      if [[ -f "$PLIST_DST" ]] && cmp -s "$_plist_tmp" "$PLIST_DST"; then
        say "tunnel plist unchanged — skipping reload"
      else
        cp "$_plist_tmp" "$PLIST_DST"
        # reload
        launchctl unload "$PLIST_DST" 2>/dev/null || true
        launchctl load "$PLIST_DST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
        say "installed tunnel $PLIST_DST and (re)loaded (alias ${SSH_ALIAS}, port ${FLEET_PORT})"
      fi
      rm -f "$_plist_tmp"
    fi
  fi
fi

# --- canonical hub service (SERVER role only — reboot-survival, #1258) ---
# The canonical hub must survive a REBOOT with NO editor ever opened. Today the
# hub is the extension-spawned detached server (ADR 0020): survives a window
# close, DIES ON REBOOT. This provisions the EXISTING #955 headless runner
# (amicode_service_runner_cli.ts, bundled to bin/dist/amicode-service-runner.mjs)
# under launchd (macOS) / systemd-user (Linux) with RunAtLoad + KeepAlive — NOT a
# bespoke `opencode serve` wrapper (the WITHDRAWN design: reclaim-killed by the
# editor's adoptOrSpawn, and two writers on one SQLite DB). One canonical DB /
# ONE writer (ADR 0005): the unit runs the SAME runner the editor adopts, pinned
# to the canonical OPENCODE_DB. A CLIENT never gets it (never-fork) — the role
# gate rides the ONE topology reader (ADR 0023: the SAME parsed $ROLE above).
# Distinct from the #1260 tunnel unit (which runs `ssh -L`, a different service).
if [[ "$ROLE" == "server" ]]; then
  HUB_LABEL="co.harmoniqs.amico-hub"
  HUB_LOG="/tmp/amico-hub.log"
  HUB_DB="$HOME/.amico/server/session.db"   # the canonical ONE-writer store (ADR 0005)
  # Resolve the extension root carrying the bundled #955 runner + built app dist.
  # Two layouts, one script (the byte-identical copies differ in REPO_ROOT):
  #   VSIX      → REPO_ROOT IS the extension root        (bin/dist, dist/app)
  #   monorepo  → REPO_ROOT/packages/extension is it     (…/bin/dist, …/dist/app)
  HUB_EXT_ROOT=""
  for cand in "$REPO_ROOT" "$REPO_ROOT/packages/extension"; do
    if [[ -f "$cand/bin/dist/amicode-service-runner.mjs" ]]; then HUB_EXT_ROOT="$cand"; break; fi
  done
  HUB_RUNNER="$HUB_EXT_ROOT/bin/dist/amicode-service-runner.mjs"
  HUB_APP_DIST="$HUB_EXT_ROOT/dist/app"   # AMICODE_APP_DIST — the built app shelf the runner serves
  HUB_NODE="$(command -v node || true)"
  HUB_PLIST_DST="$HOME/Library/LaunchAgents/${HUB_LABEL}.plist"
  HUB_UNIT_DST="$HOME/.config/systemd/user/amico-hub.service"

  if [[ $CHECK -eq 1 ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
      if [[ ! -f "$HUB_PLIST_DST" ]]; then echo "[fleet] FAIL hub service launchd unit missing at $HUB_PLIST_DST (the canonical hub will NOT survive a reboot — run: bash tools/fleet/install.sh)"; exit 1; fi
      if ! grep -q "amicode-service-runner.mjs" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit does not run the #955 runner (must not be a bespoke server)"; exit 1; fi
      if grep -q "opencode serve" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit runs a bespoke 'opencode serve' (two writers on one DB — must run the #955 runner)"; exit 1; fi
      if ! grep -q "<key>RunAtLoad</key>" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit missing RunAtLoad (won't start on reboot)"; exit 1; fi
      if ! grep -q "<key>KeepAlive</key>" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit missing KeepAlive (won't restart on crash)"; exit 1; fi
      if ! grep -q "OPENCODE_DB" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit does not pin OPENCODE_DB (one-writer, ADR 0005)"; exit 1; fi
      if ! grep -q "AMICODE_SERVICE_AUTH" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit missing AMICODE_SERVICE_AUTH=open (#1354 — the SSH tunnel is the auth boundary)"; exit 1; fi
      if ! grep -q "AMICODE_ENGINE_PORT" "$HUB_PLIST_DST"; then echo "[fleet] FAIL hub service unit missing AMICODE_ENGINE_PORT (#1354 — hub engine must not collide with extension engine)"; exit 1; fi
      say "ok hub service $HUB_PLIST_DST (RunAtLoad+KeepAlive, runs the #955 runner)"
    else
      if [[ ! -f "$HUB_UNIT_DST" ]]; then echo "[fleet] FAIL hub service systemd unit missing at $HUB_UNIT_DST (the canonical hub will NOT survive a reboot — run: bash tools/fleet/install.sh)"; exit 1; fi
      if ! grep -q "amicode-service-runner.mjs" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit does not run the #955 runner (must not be a bespoke server)"; exit 1; fi
      if grep -q "opencode serve" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit runs a bespoke 'opencode serve' (two writers on one DB — must run the #955 runner)"; exit 1; fi
      if ! grep -q "Restart=always" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit missing Restart=always (won't restart on crash)"; exit 1; fi
      if ! grep -q "WantedBy=" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit missing WantedBy (won't start on boot)"; exit 1; fi
      if ! grep -q "OPENCODE_DB" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit does not pin OPENCODE_DB (one-writer, ADR 0005)"; exit 1; fi
      if ! grep -q "AMICODE_SERVICE_AUTH" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit missing AMICODE_SERVICE_AUTH=open (#1354 — the SSH tunnel is the auth boundary)"; exit 1; fi
      if ! grep -q "AMICODE_ENGINE_PORT" "$HUB_UNIT_DST"; then echo "[fleet] FAIL hub service unit missing AMICODE_ENGINE_PORT (#1354 — hub engine must not collide with extension engine)"; exit 1; fi
      say "ok hub service $HUB_UNIT_DST (WantedBy+Restart=always, runs the #955 runner)"
    fi
  else
    if [[ -z "$HUB_EXT_ROOT" ]]; then
      say "note: no service runner bundle at <ext>/bin/dist/amicode-service-runner.mjs — skipping hub service install (run \`pnpm --filter amicode build\`)"
    elif [[ -z "$HUB_NODE" ]]; then
      say "note: no \`node\` on PATH — skipping hub service install (the launchd/systemd unit needs an absolute node)"
    elif [[ "$(uname -s)" == "Darwin" ]]; then
      mkdir -p "$(dirname "$HUB_PLIST_DST")" "$(dirname "$HUB_DB")"
      cat > "$HUB_PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${HUB_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${HUB_NODE}</string>
		<string>${HUB_RUNNER}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>AMICODE_APP_DIST</key>
		<string>${HUB_APP_DIST}</string>
		<key>AMICODE_ENGINE_PORT</key>
		<string>$((FLEET_PORT - 3))</string>
		<key>AMICODE_ENGINE_UNARMED</key>
		<string>1</string>
		<key>AMICODE_SERVICE_AUTH</key>
		<string>open</string>
		<key>AMICODE_SERVICE_PORT</key>
		<string>${FLEET_PORT}</string>
		<key>OPENCODE_DB</key>
		<string>${HUB_DB}</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>StandardOutPath</key>
	<string>${HUB_LOG}</string>
	<key>StandardErrorPath</key>
	<string>${HUB_LOG}</string>
	<key>ThrottleInterval</key>
	<integer>10</integer>
</dict>
</plist>
PLIST
      launchctl unload "$HUB_PLIST_DST" 2>/dev/null || true
      launchctl load "$HUB_PLIST_DST" 2>/dev/null || launchctl bootstrap "gui/$(id -u)" "$HUB_PLIST_DST" 2>/dev/null || true
      say "installed hub service $HUB_PLIST_DST and (re)loaded (RunAtLoad+KeepAlive, port ${FLEET_PORT}, runs the #955 runner)"
    else
      mkdir -p "$(dirname "$HUB_UNIT_DST")" "$(dirname "$HUB_DB")"
      cat > "$HUB_UNIT_DST" <<UNIT
[Unit]
Description=Amico canonical hub service (headless amicode_service runner — reboot-survival, #1258)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=AMICODE_APP_DIST=${HUB_APP_DIST}
Environment=AMICODE_ENGINE_PORT=$((FLEET_PORT - 3))
Environment=AMICODE_ENGINE_UNARMED=1
Environment=AMICODE_SERVICE_AUTH=open
Environment=AMICODE_SERVICE_PORT=${FLEET_PORT}
Environment=OPENCODE_DB=${HUB_DB}
ExecStart=${HUB_NODE} ${HUB_RUNNER}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable --now amico-hub.service 2>/dev/null || true
      say "installed hub service $HUB_UNIT_DST and enabled (WantedBy+Restart=always, port ${FLEET_PORT}, runs the #955 runner)"
    fi
  fi
fi

if [[ $CHECK -eq 1 ]]; then
  say "fleet check: all ok"
fi

#!/bin/bash
# amicode-server.sh (erlich hub) — canonical Amicode opencode server on Linux.
# Adapted from the mini's launchd wrapper for systemd --user + erlich paths.
# Serves ~/.local/share/opencode/opencode.db (OPENCODE_DB pinned) on 127.0.0.1:4096.
set -euo pipefail

AMICO_SERVER_DIR="$HOME/.amico/server"

# --- shard derivation (amicode #1717 phase 1) ---------------------------------
# A shard is one instance of co.harmoniqs.amicode-server@<i>; the index derives
# the service/engine/inspect ports (table in ops/hub/README.md). Explicit env
# still wins. No index = legacy single-server behavior, unchanged.
# --print-shard-env: print the derived ports and exit (used by
# ops/hub/test-shard-config.sh — never starts anything).
if [ -n "${AMICODE_SHARD_INDEX:-}" ]; then
  case "$AMICODE_SHARD_INDEX" in
    *[!0-9]*)
      echo "amicode-server: bad AMICODE_SHARD_INDEX='$AMICODE_SHARD_INDEX' (want a number >= 2)" >&2
      exit 1 ;;
  esac
  if [ "$AMICODE_SHARD_INDEX" -lt 2 ]; then
    echo "amicode-server: shard index 1 is the legacy unit (co.harmoniqs.amicode-server.service) — the template must not be instantiated for it (port collision)" >&2
    exit 1
  fi
  OFF=$((100 * (AMICODE_SHARD_INDEX - 1)))
  AMICODE_SERVER_PORT="${AMICODE_SERVER_PORT:-$((4095 + OFF))}"
  AMICODE_ENGINE_PORT="${AMICODE_ENGINE_PORT:-$((4094 + OFF))}"
  # MUST be distinct per shard: two engines with one BUN_INSPECT port fail at
  # boot with EADDRINUSE (the wedge postmortem's cdp-stack hook depends on it).
  AMICODE_ENGINE_INSPECT="${AMICODE_ENGINE_INSPECT:-127.0.0.1:$((9229 + AMICODE_SHARD_INDEX - 1))}"
  export AMICODE_SERVER_PORT AMICODE_ENGINE_PORT AMICODE_ENGINE_INSPECT
fi
if [ "${1:-}" = "--print-shard-env" ]; then
  echo "shard_index=${AMICODE_SHARD_INDEX:-none}"
  echo "service_port=${AMICODE_SERVER_PORT:-4096-default}"
  echo "engine_port=${AMICODE_ENGINE_PORT:-4094-runner-default}"
  echo "inspect=${AMICODE_ENGINE_INSPECT:-127.0.0.1:9229-default}"
  exit 0
fi
PORT="${AMICODE_SERVER_PORT:-4096}"

# --- resolve the opencode binary: the FROZEN server copy first ---------------
FROZEN_BIN="$AMICO_SERVER_DIR/bin/opencode"
VSIX_BIN="$(ls -dt "$HOME"/.vscode-server/extensions/harmoniqs.amicode-*/vendor/opencode/linux-x64/opencode 2>/dev/null | head -1 || true)"
if [ -x "$FROZEN_BIN" ]; then
  BIN="$FROZEN_BIN"
elif [ -n "$VSIX_BIN" ] && [ -x "$VSIX_BIN" ]; then
  echo "amicode-server: WARNING frozen binary missing ($FROZEN_BIN) — falling back to the VSIX binary" >&2
  BIN="$VSIX_BIN"
else
  echo "amicode-server: no opencode binary found (frozen or VSIX)" >&2
  exit 1
fi

# --- extension dir: the amicode repo checkout (carries plugin/templates/scores)
EXT_DIR="$AMICO_SERVER_DIR/service/extension"
[ -d "$EXT_DIR/skills" ] || EXT_DIR="$HOME/harmoniqs/amicode/packages/extension"
[ -d "$EXT_DIR/opencode-plugin" ] || EXT_DIR="$(ls -d "$HOME"/.vscode-server/extensions/harmoniqs.amicode-* 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$EXT_DIR" ] || EXT_DIR="$HOME/.amico/server/service/extension"

# --- workspace staging dir (no VS Code here — the staged copy is canonical) ---
WS_DIR="$AMICO_SERVER_DIR/opencode-project-staging"

# --- re-stage public skills from the repo extension into staging (no delete) --
if [ -d "$EXT_DIR/skills" ] && [ -d "$WS_DIR/opencode-project/skills" ]; then
  rsync -a "$EXT_DIR/skills/" "$WS_DIR/opencode-project/skills/"
fi

# --- stage agent mode cards (autodev, autoresearch) into the global config dir
# The extension stages these client-side on every activation (mode_cards.ts);
# the hub runs without the extension, so the wrapper mirrors the same
# always-copy here — otherwise hub-spawned sessions never see the modes.
AGENTS_DIR="$HOME/.config/opencode/agents"
if [ -d "$EXT_DIR/agents" ]; then
  mkdir -p "$AGENTS_DIR"
  # MIRROR semantics (not additive): renames (autodev→develop, #862) must
  # remove the staged ghost cards — 2026-09-10: the additive rsync left
  # autodev.md/autoresearch.md staging beside develop/research and the
  # picker showed both generations. The source is the deployed extension
  # copy (canonical); --delete is safe here for exactly that reason.
  rsync -a --delete --include='*.md' --exclude='*' "$EXT_DIR/agents/" "$AGENTS_DIR/"
fi

# --- re-stage internal workflow skills from the armonissima vault -------------
"$AMICO_SERVER_DIR/bin/stage-internal-skills.sh" \
  || echo "amicode-server: internal-skill staging skipped (script failed — continuing)" >&2

# --- config content with this machine's real paths spliced in ---------------
CONFIG_CONTENT="$(sed -e "s|__EXT__|$EXT_DIR|g" -e "s|__WS__|$WS_DIR|g" "$AMICO_SERVER_DIR/opencode-config-content.json")"

# --- env: PATH carries node22 + amico launchers + bun -------------------------
AMICO_BIN="$EXT_DIR/bin/launcher"
export PATH="$AMICO_BIN:$HOME/.local/bin:$HOME/opt/node22/bin:$HOME/.bun/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/sbin:/bin"
[ -f "$HOME/.amico/amicode/venvs/pasqal-connector/bin/python" ] && \
  export AMICO_PYTHON="$HOME/.amico/amicode/venvs/pasqal-connector/bin/python"
export OPENCODE_CONFIG_CONTENT="$CONFIG_CONTENT"
# 2026-10-04 #775 wedge hunt: bun's JS inspector on loopback ONLY (same posture
# as every hub surface). The wedge is a spinning main thread at LLM-stream start
# with ~2.5GB heap; native gdb frames read ?? on the JIT binary, but the
# inspector can PAUSE a spinning loop and report the exact wedging JS frame.
# The watchdog's wedge capture connects here (fleet-watchdog/cdp-stack.mjs).
export BUN_INSPECT="${AMICODE_ENGINE_INSPECT:-127.0.0.1:9229}"
# NOTE: OPENCODE_SERVER_PASSWORD deliberately unset — localhost + tailnet posture.

# --- pin the canonical chat DB (channel-flip guard, 2026-08-08 incident) ------
export OPENCODE_DB=opencode.db

cd "$WS_DIR/opencode-project"

# --- the M3 cutover (#955, 2026-09-10): the amicode service fronts the engine
# The runner spawns the engine (UNARMED — the hub's anonymous boundary posture,
# byte-for-byte the fork's) and serves the app + /amicode/* from the service
# origin; the frontdoor (4096 -> $PORT) frames the service. Rollback: this
# script's .bak-20260910-pre-cutover + the fork binary (opencode.bak-*).
SERVICE_DIR="$AMICO_SERVER_DIR/service"
RUNNER="$SERVICE_DIR/amicode-service-runner.mjs"
[ -f "$RUNNER" ] || { echo "amicode-server: service runner missing ($RUNNER)" >&2; exit 1; }
[ -d "$SERVICE_DIR/dist-app" ] || { echo "amicode-server: app dist missing ($SERVICE_DIR/dist-app)" >&2; exit 1; }
export AMICODE_ENGINE_BIN="$BIN"
export AMICODE_APP_DIST="$SERVICE_DIR/dist-app"
export AMICODE_SERVICE_PORT="$PORT"
export AMICODE_SERVICE_AUTH=open
export AMICODE_ENGINE_UNARMED=1
# ABSOLUTE: the runner's engine cwd is a scratch dir — the fork's relative
# pin relied on cwd=$WS_DIR/opencode-project; the file is the same one.
export OPENCODE_DB="$HOME/.local/share/opencode/opencode.db"
BIN_SUM="$(sha256sum "$AMICODE_ENGINE_BIN" 2>/dev/null | awk '{print $1}')"
echo "amicode-server: service-runner port=$PORT engine=$AMICODE_ENGINE_BIN sha256=${BIN_SUM:-unknown} db=$OPENCODE_DB (the M3 cutover, #955)"
exec node "$RUNNER"

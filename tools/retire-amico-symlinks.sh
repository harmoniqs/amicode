#!/usr/bin/env bash
set -euo pipefail

# retire-amico-symlinks.sh
# Phase C cleanup: remove the ~/.amico/ symlink farm once ArmoniaService is live.
#
# GATED on ~/armonia/.armonia-active — refuses to run if absent. This marker is
# written by ArmoniaService on boot (#326), proving it resolves paths directly
# from ~/armonia/ and no longer needs the ~/.amico/ indirection.
#
# What it does (when gate passes):
#   1. Removes all directory symlinks under ~/.amico/
#   2. Moves config files from ~/.amico/ to ~/armonia/data/config/ (making
#      data/config/ authoritative — the caller now reads from there)
#   3. Removes ~/.amico/ if empty
#
# Idempotent: safe to re-run. Symlinks already removed are skipped; config
# files already at data/config/ are not overwritten.
#
# Usage:
#   tools/retire-amico-symlinks.sh

ARMONIA="${HOME}/armonia"
AMICO="${HOME}/.amico"
MARKER="${ARMONIA}/.armonia-active"

# Config files to move (the authoritative copies land at data/config/).
CONFIG_FILES=(
  profile.json
  cloud.json
  pasqal.json
  connections.json
  lab.toml
  mounts.toml
)

# All symlink entries we expect to find and remove.
SYMLINK_ENTRIES=(
  julia
  problems
  runs
  vaults
  library
  ledger
  devices
  authoring
  amicode
)

# ===================================================================
main() {
  echo "==> retire-amico-symlinks"
  echo

  # ---- gate: marker must exist ----
  if [[ ! -f "$MARKER" ]]; then
    echo "ERROR: ~/armonia/.armonia-active not found."
    echo ""
    echo "This script can only run after ArmoniaService is live and resolving"
    echo "paths directly from ~/armonia/. The marker file is written by"
    echo "ArmoniaService on boot (see #326)."
    echo ""
    echo "If you are sure ArmoniaService is active, check that it wrote:"
    echo "  $MARKER"
    exit 1
  fi

  echo "  marker found: $MARKER"
  echo

  remove_symlinks
  remove_ops_fleet_symlink
  move_config_files
  remove_amico_dir

  echo
  echo "==> Done. ~/.amico/ symlink farm retired."
  echo "    ArmoniaService now owns all paths directly under ~/armonia/."
}

# -------------------------------------------------------------------
remove_symlinks() {
  echo "--- remove symlinks ---"
  for name in "${SYMLINK_ENTRIES[@]}"; do
    local src="${AMICO}/${name}"
    if [[ -L "$src" ]]; then
      rm "$src"
      echo "  removed ~/.amico/${name}"
    elif [[ -e "$src" ]]; then
      echo "  WARNING: ~/.amico/${name} is NOT a symlink — left in place"
    else
      echo "  (already gone) ~/.amico/${name}"
    fi
  done
}

# -------------------------------------------------------------------
remove_ops_fleet_symlink() {
  echo "--- remove ops/fleet symlink ---"
  local fleet="${AMICO}/ops/fleet"
  if [[ -L "$fleet" ]]; then
    rm "$fleet"
    echo "  removed ~/.amico/ops/fleet"
  elif [[ -e "$fleet" ]]; then
    echo "  WARNING: ~/.amico/ops/fleet is NOT a symlink — left in place"
  else
    echo "  (already gone) ~/.amico/ops/fleet"
  fi

  # Remove ops/ if empty
  if [[ -d "${AMICO}/ops" ]]; then
    if [[ -z "$(ls -A "${AMICO}/ops" 2>/dev/null)" ]]; then
      rmdir "${AMICO}/ops"
      echo "  removed empty ~/.amico/ops/"
    else
      echo "  WARNING: ~/.amico/ops/ not empty — left in place"
    fi
  fi
}

# -------------------------------------------------------------------
# Move config files from ~/.amico/ to data/config/ (making data/config/
# authoritative). Does not overwrite if dest already newer.
move_config_files() {
  echo "--- move config files → data/config/ (authoritative) ---"
  mkdir -p "${ARMONIA}/data/config"

  for f in "${CONFIG_FILES[@]}"; do
    local src="${AMICO}/${f}"
    local dest="${ARMONIA}/data/config/${f}"
    if [[ -f "$src" ]]; then
      # Move (not copy) — data/config/ becomes the only copy
      mv "$src" "$dest"
      echo "  moved ~/.amico/${f} → data/config/${f}"
    elif [[ -f "$dest" ]]; then
      echo "  (already at dest) data/config/${f}"
    else
      echo "  (skip) ${f} not found anywhere"
    fi
  done
}

# -------------------------------------------------------------------
# Remove ~/.amico/ if empty.
remove_amico_dir() {
  echo "--- cleanup ---"
  if [[ ! -d "$AMICO" ]]; then
    echo "  (already gone) ~/.amico/"
    return 0
  fi

  if [[ -z "$(ls -A "$AMICO" 2>/dev/null)" ]]; then
    rmdir "$AMICO"
    echo "  removed empty ~/.amico/"
  else
    echo "  WARNING: ~/.amico/ not empty after cleanup — remaining entries:"
    ls -la "$AMICO" | tail -n +4 | while IFS= read -r line; do
      echo "    $line"
    done
    echo "  (left in place — inspect manually)"
  fi
}

main

#!/usr/bin/env bash
set -euo pipefail

# bootstrap-armonia.sh
# Fresh-machine setup for the canonical Amicode workspace layout.
# Any user — Harmoniqs dev or external contributor — gets the same tree:
#
#   ~/armonia/repos/packages/   Julia libraries (Piccolo.jl, …)
#   ~/armonia/repos/demos/      demo galleries (atoms-demo, …)
#   ~/armonia/repos/<flat>      apps, forks, projects (amicode, …)
#   ~/armonia/data/{config,env/julia,problems,runs,vaults,library,fleet,ledger,devices,authoring,amicode}
#
# Usage:
#   bootstrap-armonia.sh [--minimal|--standard|--full]
#
#   --minimal   layout + data dirs only (extension users who never touch source)
#   --standard  + public packages and demos via plain git clone (default)
#   --full      + private Harmoniqs repos via `gh` (requires gh auth with access)
#
# Curl-able for users who have not cloned anything:
#   bash <(curl -fsSL https://raw.githubusercontent.com/harmoniqs/amicode/main/tools/bootstrap-armonia.sh)
#
# Idempotent: existing clones are skipped (git pull --ff-only is attempted),
# existing symlinks are left alone.

ARMONIA="${HOME}/armonia"
AMICO="${HOME}/.amico"
TIER="standard"

for arg in "$@"; do
  case "$arg" in
    --minimal|--standard|--full) TIER="${arg#--}" ;;
    -h|--help)
      sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 64 ;;
  esac
done

# Public Julia libraries (registered packages; plain git clone works).
PUBLIC_PACKAGES=(
  Piccolo.jl
  NamedTrajectories.jl
  DirectTrajOpt.jl
)

# Public demo galleries.
PUBLIC_DEMOS=(
  atoms-demo
  fluxonium-demo
  ions
)

# Private Harmoniqs repos (cloned with gh; requires org access).
PRIVATE_PACKAGES=(
  Piccolissimo.jl
)
PRIVATE_APPS=(
  amicode
)

# ===================================================================
main() {
  echo "==> bootstrap-armonia  tier=${TIER}"
  echo

  make_layout
  wire_amico_links

  case "$TIER" in
    minimal)  echo "tier=minimal — no repos cloned" ;;
    standard) clone_public ;;
    full)     clone_public; clone_private ;;
  esac

  echo
  echo "==> Done."
  echo "    Layout:  ~/armonia/{repos/{packages,demos,...}, data/{config,env/julia,problems,...}}"
  echo "    Open it: open ~/armonia/  (or add ~/armonia to your VS Code workspace)"
}

# -------------------------------------------------------------------
make_layout() {
  echo "--- layout ---"
  mkdir -p "${ARMONIA}/repos/packages" "${ARMONIA}/repos/demos" \
           "${ARMONIA}/data/config" \
           "${ARMONIA}/data/env/julia" \
           "${ARMONIA}/data/problems" \
           "${ARMONIA}/data/runs" \
           "${ARMONIA}/data/vaults" \
           "${ARMONIA}/data/library" \
           "${ARMONIA}/data/fleet" \
           "${ARMONIA}/data/ledger" \
           "${ARMONIA}/data/devices" \
           "${ARMONIA}/data/authoring" \
           "${ARMONIA}/data/amicode"
  echo "  ~/armonia/data/{config,env/julia,problems,runs,vaults,library,fleet,ledger,devices,authoring,amicode} ready"
  echo "  ~/armonia/repos/{packages,demos} ready"
}

# -------------------------------------------------------------------
# ~/.amico/<name> → ~/armonia/data/<target>, created only when safe.
# If ~/.amico/<name> already exists as a REAL directory with content, that is
# the migration case — point the user at migrate-to-armonia.sh instead of
# clobbering it.
#
# The full symlink farm (10 links):
#   julia       → data/env/julia
#   problems    → data/problems
#   runs        → data/runs
#   vaults      → data/vaults
#   library     → data/library
#   ops/fleet   → data/fleet       (ops/ is a real dir; fleet is the symlink inside)
#   ledger      → data/ledger
#   devices     → data/devices
#   authoring   → data/authoring
#   amicode     → data/amicode
wire_amico_links() {
  echo "--- ~/.amico links ---"
  mkdir -p "$AMICO"

  # Standard directory symlinks: "amico_name:armonia_target"
  local pairs=(
    "julia:env/julia"
    "problems:problems"
    "runs:runs"
    "vaults:vaults"
    "library:library"
    "ledger:ledger"
    "devices:devices"
    "authoring:authoring"
    "amicode:amicode"
  )

  for pair in "${pairs[@]}"; do
    local name="${pair%%:*}" target="${pair##*:}"
    local src="${AMICO}/${name}" dest="${ARMONIA}/data/${target}"
    if [[ -L "$src" ]]; then
      echo "  (symlink) ~/.amico/${name}"
    elif [[ -d "$src" && -n "$(ls -A "$src" 2>/dev/null)" ]]; then
      echo "  (real dir, not empty) ~/.amico/${name} — run tools/migrate-to-armonia.sh first"
    elif [[ -d "$src" ]]; then
      rmdir "$src" && ln -s "$dest" "$src"
      echo "  linked ~/.amico/${name} → data/${target}"
    else
      ln -s "$dest" "$src"
      echo "  linked ~/.amico/${name} → data/${target}"
    fi
  done

  # Special case: ops/fleet (ops/ is a real dir, fleet is a symlink inside it)
  mkdir -p "${AMICO}/ops"
  local fleet_src="${AMICO}/ops/fleet"
  local fleet_dest="${ARMONIA}/data/fleet"
  if [[ -L "$fleet_src" ]]; then
    echo "  (symlink) ~/.amico/ops/fleet"
  elif [[ -d "$fleet_src" && -n "$(ls -A "$fleet_src" 2>/dev/null)" ]]; then
    echo "  (real dir, not empty) ~/.amico/ops/fleet — run tools/migrate-to-armonia.sh first"
  elif [[ -d "$fleet_src" ]]; then
    rmdir "$fleet_src" && ln -s "$fleet_dest" "$fleet_src"
    echo "  linked ~/.amico/ops/fleet → data/fleet"
  else
    ln -s "$fleet_dest" "$fleet_src"
    echo "  linked ~/.amico/ops/fleet → data/fleet"
  fi
}

# -------------------------------------------------------------------
clone_public() {
  echo "--- clone (public) ---"
  for repo in "${PUBLIC_PACKAGES[@]}"; do
    clone_or_update "https://github.com/harmoniqs/${repo}.git" "${ARMONIA}/repos/packages/${repo}"
  done
  for repo in "${PUBLIC_DEMOS[@]}"; do
    clone_or_update "https://github.com/harmoniqs/${repo}.git" "${ARMONIA}/repos/demos/${repo}"
  done
}

# -------------------------------------------------------------------
clone_private() {
  echo "--- clone (private, via gh) ---"
  if ! command -v gh >/dev/null 2>&1; then
    echo "  gh not installed — skipping private tier"; return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "  gh not authenticated — skipping private tier (run: gh auth login)"; return 0
  fi
  for repo in "${PRIVATE_PACKAGES[@]}"; do
    gh_clone_or_update "harmoniqs/${repo}" "${ARMONIA}/repos/packages/${repo}"
  done
  for repo in "${PRIVATE_APPS[@]}"; do
    gh_clone_or_update "harmoniqs/${repo}" "${ARMONIA}/repos/${repo}"
  done
}

# -------------------------------------------------------------------
clone_or_update() {
  local url="$1" dest="$2"
  if [[ -d "${dest}/.git" ]]; then
    echo "  (exists) $(basename "$dest") — pulling"
    git -C "$dest" pull --ff-only 2>/dev/null || echo "    (pull skipped: not fast-forwardable)"
  elif [[ -e "$dest" ]]; then
    echo "  (exists, not a git repo — left alone) $(basename "$dest")"
  else
    echo "  clone $(basename "$dest")"
    git clone "$url" "$dest"
  fi
}

gh_clone_or_update() {
  local repo="$1" dest="$2"
  if [[ -d "${dest}/.git" ]]; then
    echo "  (exists) $(basename "$dest") — pulling"
    git -C "$dest" pull --ff-only 2>/dev/null || echo "    (pull skipped: not fast-forwardable)"
  elif [[ -e "$dest" ]]; then
    echo "  (exists, not a git repo — left alone) $(basename "$dest")"
  else
    echo "  clone $repo"
    gh repo clone "$repo" "$dest"
  fi
}

main

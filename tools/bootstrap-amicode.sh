#!/usr/bin/env bash
set -euo pipefail

# bootstrap-amicode.sh
# Fresh-machine setup for the canonical Amicode layout:
#
#   ~/.amicode/              App state (dotdir, product-named)
#     config/                profile.json, cloud.json, pasqal.json, connections.json, lab.toml, mounts.toml
#     env/julia/             Provisioned Julia project
#     problems/              Problem workspaces
#     runs/                  Solve outputs
#     ledger/                runs.jsonl, claims.jsonl
#     devices/               Device state
#     library/               Uploaded papers
#     authoring/             authoring.json
#     ops/                   Entitlements, solver-mode, onboarding state
#     fleet/                 Fleet topology
#
#   ~/armonia/               Workspace layer (visible, not hidden)
#     repos/packages/        Julia libraries (Piccolo.jl, ...)
#     repos/demos/           Demo galleries (atoms-demo, ...)
#     repos/<flat>           Apps, forks, projects (amicode, ...)
#     vaults/                Obsidian vaults (armonia-jj-lee, armonissima, ...)
#
# Usage:
#   bootstrap-amicode.sh [--minimal|--standard|--full]
#
#   --minimal   layout dirs only (extension users who never touch source)
#   --standard  + public packages and demos via plain git clone (default)
#   --full      + private Harmoniqs repos via `gh` (requires gh auth with access)
#
# Curl-able:
#   bash <(curl -fsSL https://raw.githubusercontent.com/harmoniqs/amicode/main/tools/bootstrap-amicode.sh)
#
# Idempotent: existing dirs/clones are skipped.

AMICODE="${HOME}/.amicode"
ARMONIA="${HOME}/armonia"
TIER="standard"

for arg in "$@"; do
  case "$arg" in
    --minimal|--standard|--full) TIER="${arg#--}" ;;
    -h|--help)
      sed -n '2,36p' "$0"; exit 0 ;;
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
  echo "==> bootstrap-amicode  tier=${TIER}"
  echo

  # Check if user needs migration instead of bootstrap
  if [[ -d "${HOME}/.amico" && ! -L "${HOME}/.amico" ]]; then
    echo "  NOTE: existing ~/.amico/ detected."
    echo "        Run tools/migrate-to-amicode.sh to migrate your state."
    echo "        (bootstrap creates the skeleton alongside it — safe to proceed)"
    echo
  fi
  if [[ -d "${ARMONIA}/data" ]]; then
    echo "  NOTE: existing ~/armonia/data/ detected (old layout)."
    echo "        Run tools/migrate-to-amicode.sh to consolidate."
    echo
  fi

  make_layout

  case "$TIER" in
    minimal)  echo "tier=minimal — no repos cloned" ;;
    standard) clone_public ;;
    full)     clone_public; clone_private ;;
  esac

  echo
  echo "==> Done."
  echo "    App state:  ~/.amicode/{config,env/julia,problems,runs,ledger,...}"
  echo "    Workspace:  ~/armonia/{repos/{packages,demos,...}, vaults/}"
}

# -------------------------------------------------------------------
make_layout() {
  echo "--- layout ---"

  # App state
  mkdir -p "${AMICODE}/config" \
           "${AMICODE}/env/julia" \
           "${AMICODE}/problems" \
           "${AMICODE}/runs" \
           "${AMICODE}/ledger" \
           "${AMICODE}/devices" \
           "${AMICODE}/library" \
           "${AMICODE}/authoring" \
           "${AMICODE}/ops" \
           "${AMICODE}/fleet"
  echo "  ~/.amicode/{config,env/julia,problems,runs,ledger,devices,library,authoring,ops,fleet} ready"

  # Workspace
  mkdir -p "${ARMONIA}/repos/packages" \
           "${ARMONIA}/repos/demos" \
           "${ARMONIA}/vaults"
  echo "  ~/armonia/{repos/{packages,demos}, vaults/} ready"
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

#!/usr/bin/env bash
set -euo pipefail

# bootstrap-armonia.sh
# Fresh-machine setup for the canonical Amicode workspace layout.
# Any user — Harmoniqs dev or external contributor — gets the same tree:
#
#   ~/armonia/repos/packages/   Julia libraries (Piccolo.jl, …)
#   ~/armonia/repos/demos/      demo galleries (atoms-demo, …)
#   ~/armonia/repos/<flat>      apps, forks, projects (amicode, …)
#   ~/armonia/data/{env,problems,runs,vaults}
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
      sed -n '2,22p' "$0"; exit 0 ;;
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
  ensure_vault_ecosystem

  case "$TIER" in
    minimal)  echo "tier=minimal — no repos cloned" ;;
    standard) clone_public ;;
    full)     clone_public; clone_private ;;
  esac

  echo
  echo "==> Done."
  echo "    Layout:  ~/armonia/{repos/{packages,demos,...}, data/{env,problems,runs,vaults}}"
  echo "    Open it: open ~/armonia/  (or add ~/armonia to your VS Code workspace)"
}

# -------------------------------------------------------------------
make_layout() {
  echo "--- layout ---"
  mkdir -p "${ARMONIA}/repos/packages" "${ARMONIA}/repos/demos" \
           "${ARMONIA}/data/env" "${ARMONIA}/data/problems" \
           "${ARMONIA}/data/runs" "${ARMONIA}/data/vaults"
  echo "  ~/armonia/{repos/{packages,demos}, data/{env,problems,runs,vaults}} ready"
}

# -------------------------------------------------------------------
# ~/.amico/<name> → ~/armonia/data/<target>, created only when safe.
# If ~/.amico/<name> already exists as a REAL directory with content, that is
# the migration case — point the user at migrate-to-armonia.sh instead of
# clobbering it.
wire_amico_links() {
  echo "--- ~/.amico links ---"
  local pairs=("julia:env" "problems:problems" "runs:runs" "vaults:vaults")
  for pair in "${pairs[@]}"; do
    local name="${pair%%:*}" target="${pair##*:}"
    local src="${AMICO}/${name}" dest="${ARMONIA}/data/${target}"
    mkdir -p "$AMICO"
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
}

# -------------------------------------------------------------------
# Vault ecosystem — mirrors extension's ensureVaultEcosystem (idempotent,
# offline-tolerant, never throws). Either order (CLI first or extension first)
# is safe — second run is a no-op.
ensure_vault_ecosystem() {
  echo "--- vaults ---"
  local vaults_root="${AMICO}/vaults"
  # Resolve symlink if present (~/armonia/data/vaults)
  if [ -L "$vaults_root" ]; then vaults_root=$(readlink "$vaults_root"); fi
  # Fallback if symlink broken or relative
  if [[ "$vaults_root" != /* ]]; then vaults_root="${AMICO}/vaults"; fi
  # Canonical: ~/armonia/data/vaults if symlink else ~/.amico/vaults
  if [ -L "${AMICO}/vaults" ]; then
    vaults_root=$(readlink "${AMICO}/vaults")
    [[ "$vaults_root" != /* ]] && vaults_root="${AMICO}/vaults"
  else
    vaults_root="${AMICO}/vaults"
  fi
  # Ensure data/vaults exists (make_layout already did)
  mkdir -p "$vaults_root" 2>/dev/null || true

  # Personal — create if none with kind=personal exists.
  local has_personal=0
  for d in "$vaults_root"/*/.amico-vault.toml 2>/dev/null; do
    [ -f "$d" ] && grep -q 'kind = "personal"' "$d" 2>/dev/null && has_personal=1 && break
  done
  if [ $has_personal -eq 0 ]; then
    local raw="${USER:-personal}"
    local name=$(echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^[-.]+|[-.]+$//g')
    [ -z "$name" ] && name="personal"
    local dir="$vaults_root/$name"
    if [ ! -e "$dir" ]; then
      echo "  create personal vault: $name"
      mkdir -p "$dir"
      printf 'kind = "personal"\nname = "%s"\n' "$name" > "$dir/.amico-vault.toml"
      git -C "$dir" init -q 2>/dev/null || true
    else
      echo "  (exists) personal vault: $name"
    fi
  else
    echo "  (exists) personal vault"
  fi

  # Public — shallow clone vault-public if absent, else placeholder if offline.
  local pub_dir="$vaults_root/vault-public"
  local pub_marker="$pub_dir/.amico-vault.toml"
  if [ -f "$pub_marker" ]; then
    echo "  (exists) public vault: vault-public"
  elif [ -d "$pub_dir" ]; then
    echo "  (exists dir without marker) vault-public — seeding marker"
    printf 'kind = "public"\nname = "vault-public"\n' > "$pub_marker" 2>/dev/null || true
  else
    echo "  clone public vault: vault-public"
    if git clone --depth 1 --single-branch https://github.com/harmoniqs/vault-public.git "$pub_dir" 2>/dev/null; then
      # Ensure marker is public
      if ! grep -q 'kind = "public"' "$pub_marker" 2>/dev/null; then
        printf 'kind = "public"\nname = "vault-public"\n' > "$pub_marker" 2>/dev/null || true
      fi
      echo "    cloned vault-public"
    else
      echo "    (offline or no git) placeholder for vault-public"
      mkdir -p "$pub_dir"
      printf 'kind = "public"\nname = "vault-public"\n' > "$pub_marker" 2>/dev/null || true
      printf '# vault-public (offline placeholder)\n\nCloned on next online run.\n' > "$pub_dir/README.md" 2>/dev/null || true
    fi
  fi

  # mounts.toml — absent-only.
  local mounts_toml="${AMICO}/mounts.toml"
  if [ -f "$mounts_toml" ]; then
    echo "  (exists) mounts.toml"
  else
    local personal_id=""
    for d in "$vaults_root"/*/.amico-vault.toml 2>/dev/null; do
      [ -f "$d" ] && grep -q 'kind = "personal"' "$d" 2>/dev/null && personal_id=$(grep -E '^name = ' "$d" 2>/dev/null | sed -E 's/.*"(.*)".*/\1/' | head -1) && [ -n "$personal_id" ] && break
    done
    # Fallback to dir basename if marker name parse failed
    if [ -z "$personal_id" ]; then
      for d in "$vaults_root"/*/; do
        [ -f "$d/.amico-vault.toml" ] && grep -q 'kind = "personal"' "$d/.amico-vault.toml" 2>/dev/null && personal_id=$(basename "$d") && break
      done
    fi
    {
      if [ -n "$personal_id" ]; then
        printf '[[mount]]\nid = "%s"\nkind = "personal"\nwritable = true\n\n' "$personal_id"
      fi
      if [ -f "$pub_marker" ]; then
        printf '[[mount]]\nid = "vault-public"\nkind = "public"\nwritable = false\n\n'
      fi
    } > "$mounts_toml" 2>/dev/null && echo "  wrote mounts.toml" || echo "  (skip) mounts.toml not written"
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

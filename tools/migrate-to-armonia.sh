#!/usr/bin/env bash
set -euo pipefail

# migrate-to-armonia.sh
# Idempotent migration: consolidate repos + Amico data into ~/armonia/.
# Safe to run multiple times — skips what is already in place, and converges
# the repos/ buckets on re-run (flat .jl packages → packages/, demo dirs → demos/).
#
# Canonical layout:
#   ~/armonia/repos/packages/   Julia libraries (Piccolo.jl, …)
#   ~/armonia/repos/demos/      demo galleries (atoms-demo, …)
#   ~/armonia/repos/<flat>      apps, forks, research projects (amicode, passaggio, …)
#   ~/armonia/data/{env,problems,runs,vaults}

ARMONIA="${HOME}/armonia"
AMICO="${HOME}/.amico"

# ---- discover source repos ----
# Directories that might hold git checkouts to move.
REPO_SOURCES=(
  "${HOME}/_dev/harmoniqs"
  "${HOME}/harmoniqs"
  "${HOME}/AmicodeProjects"
  "${HOME}/_dev"
)

# ---- discover data dirs to migrate ----
# Each entry: "amico_dir  armonia_target"
DATA_DIRS=(
  "julia     env"
  "problems  problems"
  "runs      runs"
  "vaults    vaults"
)

# Known demo repo names → routed to repos/demos/. A source dir literally named
# "demos" is moved as-is (its contents are already grouped).
is_demo() { [[ "$1" == *demo* || "$1" == "atoms" || "$1" == "fluxonium" || "$1" == "ions" ]]; }

# Julia packages route to repos/packages/ by the .jl suffix convention.
is_package() { [[ "$1" == *.jl || "$1" == *.jl-* ]]; }

# ===================================================================
main() {
  echo "==> migrate-to-armonia  (idempotent)"
  echo

  mkdir -p "${ARMONIA}/repos/packages" "${ARMONIA}/repos/demos" \
           "${ARMONIA}/data/env" "${ARMONIA}/data/problems" \
           "${ARMONIA}/data/runs" "${ARMONIA}/data/vaults"

  converge_buckets
  migrate_repos
  migrate_data
  cleanup_empty_parents

  echo
  echo "==> Done."
  echo "    Run:  open ~/armonia/"
}

# -------------------------------------------------------------------
# Re-run convergence: repos/ that already migrated flat get bucketed.
converge_buckets() {
  local moved=0
  for child in "${ARMONIA}/repos"/*/; do
    [[ -d "$child" ]] || continue
    local name; name=$(basename "$child")
    case "$name" in packages|demos) continue ;; esac
    if is_package "$name"; then
      echo "  bucket: repos/$name → repos/packages/$name"
      mv "$child" "${ARMONIA}/repos/packages/$name"
      moved=1
    elif is_demo "$name"; then
      echo "  bucket: repos/$name → repos/demos/$name"
      mv "$child" "${ARMONIA}/repos/demos/$name"
      moved=1
    fi
  done
  # A shared Julia dev env (Project.toml/Manifest.toml) stranded at repos/
  # belongs with the packages it references.
  for f in Project.toml Manifest.toml; do
    if [[ -f "${ARMONIA}/repos/$f" && ! -f "${ARMONIA}/repos/packages/$f" ]]; then
      echo "  bucket: repos/$f → repos/packages/$f"
      mv "${ARMONIA}/repos/$f" "${ARMONIA}/repos/packages/$f"
    fi
  done
  [[ $moved -eq 1 ]] && echo
  return 0
}

# -------------------------------------------------------------------
migrate_repos() {
  echo "--- repos ---"

  for src_dir in "${REPO_SOURCES[@]}"; do
    if [[ ! -d "$src_dir" ]]; then
      echo "  (skip) not found: $src_dir"
      continue
    fi
    local src_children
    src_children=$(find "$src_dir" -mindepth 1 -maxdepth 1 ! -name 'node_modules' 2>/dev/null || true)
    if [[ -z "$src_children" ]]; then
      echo "  (skip) empty: $src_dir"
      continue
    fi
    echo "  source: $src_dir"
    while IFS= read -r child; do
      [[ -z "$child" ]] && continue
      local name
      name=$(basename "$child")

      # Shell scripts and loose files stay; only directories move. A root-level
      # Project.toml/Manifest.toml accompanies the packages.
      if [[ ! -d "$child" ]]; then
        case "$name" in
          Project.toml|Manifest.toml)
            if [[ ! -f "${ARMONIA}/repos/packages/$name" ]]; then
              echo "    mv  $name → packages/"
              mv "$child" "${ARMONIA}/repos/packages/$name"
            fi
            ;;
          *) echo "    (skip file) $name" ;;
        esac
        continue
      fi

      # Route to the right bucket.
      local bucket="${ARMONIA}/repos"
      if is_package "$name"; then
        bucket="${ARMONIA}/repos/packages"
      elif is_demo "$name" || [[ "$name" == "demos" ]]; then
        bucket="${ARMONIA}/repos/demos"
      fi
      # A "demos" source dir lands AS repos/demos (contents grouped inside);
      # merging into it rather than nesting demos/demos.
      local dest
      if [[ "$name" == "demos" ]]; then
        dest="$bucket"
      else
        dest="${bucket}/${name}"
      fi

      if [[ -e "$dest" && "$name" != "demos" ]]; then
        echo "    (exists) $name"
        continue
      fi
      if [[ "$name" == "demos" && -d "$dest" ]]; then
        # merge contents into the existing demos bucket
        local demo_children
        demo_children=$(find "$child" -mindepth 1 -maxdepth 1 2>/dev/null || true)
        while IFS= read -r d; do
          [[ -z "$d" ]] && continue
          local dname; dname=$(basename "$d")
          if [[ -e "${dest}/${dname}" ]]; then
            echo "    (exists) demos/$dname"
          else
            echo "    mv  demos/$dname"
            mv "$d" "${dest}/${dname}"
          fi
        done <<< "$demo_children"
        continue
      fi

      echo "    mv  $name → ${bucket#"$ARMONIA"/}"
      mv "$child" "$dest"
    done <<< "$src_children"
  done
}

# -------------------------------------------------------------------
migrate_data() {
  echo "--- data ---"

  for entry in "${DATA_DIRS[@]}"; do
    read -r amico_name armonia_name <<< "$entry"
    local src="${AMICO}/${amico_name}"
    local dest="${ARMONIA}/data/${armonia_name}"

    # already a symlink → done
    if [[ -L "$src" ]]; then
      echo "  (symlink) ~/.amico/${amico_name}"
      continue
    fi

    # dest already populated → assume already migrated
    if [[ -d "$dest" && -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
      # source still a real dir → just symlink it
      if [[ -d "$src" && ! -L "$src" ]]; then
        echo "  (dest exists) ~/.amico/${amico_name} → symlink"
        rm -rf "$src"
        ln -s "$dest" "$src"
      else
        echo "  (ok) ~/.amico/${amico_name}"
      fi
      continue
    fi

    # source is a real dir, dest does not exist → move + symlink
    if [[ -d "$src" && ! -L "$src" ]]; then
      echo "  mv  ~/.amico/${amico_name} → data/${armonia_name}"
      mv "$src" "$dest"
      ln -s "$dest" "$src"
    else
      echo "  (skip) ~/.amico/${amico_name} does not exist"
    fi
  done
}

# -------------------------------------------------------------------
cleanup_empty_parents() {
  echo "--- cleanup ---"
  for src_dir in "${REPO_SOURCES[@]}"; do
    # never remove HOME or root-level dirs
    case "$src_dir" in
      "$HOME"|"$HOME/Desktop"|"$HOME/Documents"|"$HOME/Downloads") continue ;;
    esac
    if [[ -d "$src_dir" ]]; then
      local remaining
      remaining=$(find "$src_dir" -mindepth 1 -maxdepth 1 2>/dev/null || true)
      if [[ -z "$remaining" ]]; then
        echo "  rmdir $src_dir"
        rmdir "$src_dir"
        # try to remove the parent if it is now empty
        local parent
        parent=$(dirname "$src_dir")
        local parent_remaining
        parent_remaining=$(find "$parent" -mindepth 1 -maxdepth 1 2>/dev/null || true)
        if [[ -z "$parent_remaining" && "$parent" != "$HOME" ]]; then
          rmdir "$parent" 2>/dev/null || true
        fi
      fi
    fi
  done
}

main

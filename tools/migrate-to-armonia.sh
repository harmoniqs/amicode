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
#   ~/armonia/data/{config,env/julia,problems,runs,vaults,library,fleet,ledger,devices,authoring,amicode}
#
# Also:
#   - Copies config files to data/config/ (profile.json, cloud.json, pasqal.json,
#     connections.json, lab.toml, mounts.toml) WITHOUT removing originals from ~/.amico/
#   - Scans VS Code global settings.json for stale paths, prompts before rewriting
#   - Final diagnostic warns about non-symlink entries under ~/.amico/ not in the known set

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
  "julia     env/julia"
  "problems  problems"
  "runs      runs"
  "vaults    vaults"
  "library   library"
  "ledger    ledger"
  "devices   devices"
  "authoring authoring"
  "amicode   amicode"
)

# Special: ops/fleet → data/fleet (ops/ is a real dir, fleet is the symlink inside)
# Handled separately in migrate_data_special.

# Config files that stay as real files at ~/.amico/ but are COPIED to data/config/.
CONFIG_FILES=(
  profile.json
  cloud.json
  pasqal.json
  connections.json
  lab.toml
  mounts.toml
)

# Known entries under ~/.amico/ that are expected after migration (symlinks + config + ops/).
KNOWN_ENTRIES=(
  julia problems runs vaults library ledger devices authoring amicode ops
  profile.json cloud.json pasqal.json connections.json lab.toml mounts.toml
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

  converge_buckets
  migrate_repos
  migrate_data
  migrate_data_special
  copy_config_files
  scan_vscode_settings
  diagnostic_pass
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

    # source is a real dir, dest does not exist or is empty → move + symlink
    if [[ -d "$src" && ! -L "$src" ]]; then
      echo "  mv  ~/.amico/${amico_name} → data/${armonia_name}"
      # Move contents rather than dir (dest already exists from mkdir -p)
      if [[ -n "$(ls -A "$src" 2>/dev/null)" ]]; then
        cp -a "$src"/. "$dest"/
      fi
      rm -rf "$src"
      ln -s "$dest" "$src"
    else
      # source doesn't exist → create the symlink anyway
      echo "  linked ~/.amico/${amico_name} → data/${armonia_name}"
      ln -s "$dest" "$src"
    fi
  done
}

# -------------------------------------------------------------------
# Special case: ~/.amico/ops/fleet → ~/armonia/data/fleet
# ops/ is a real directory; fleet is a symlink inside it.
migrate_data_special() {
  echo "--- data (special: ops/fleet) ---"
  mkdir -p "${AMICO}/ops"
  local fleet_src="${AMICO}/ops/fleet"
  local fleet_dest="${ARMONIA}/data/fleet"

  if [[ -L "$fleet_src" ]]; then
    echo "  (symlink) ~/.amico/ops/fleet"
  elif [[ -d "$fleet_src" && -n "$(ls -A "$fleet_src" 2>/dev/null)" ]]; then
    echo "  mv  ~/.amico/ops/fleet → data/fleet"
    cp -a "$fleet_src"/. "$fleet_dest"/
    rm -rf "$fleet_src"
    ln -s "$fleet_dest" "$fleet_src"
  elif [[ -d "$fleet_src" ]]; then
    rmdir "$fleet_src"
    ln -s "$fleet_dest" "$fleet_src"
    echo "  linked ~/.amico/ops/fleet → data/fleet"
  else
    ln -s "$fleet_dest" "$fleet_src"
    echo "  linked ~/.amico/ops/fleet → data/fleet"
  fi
}

# -------------------------------------------------------------------
# Copy config files to data/config/ WITHOUT removing originals.
# Config files stay as real files at ~/.amico/ (atomic write pattern).
copy_config_files() {
  echo "--- config files → data/config/ ---"
  for f in "${CONFIG_FILES[@]}"; do
    local src="${AMICO}/${f}"
    local dest="${ARMONIA}/data/config/${f}"
    if [[ -f "$src" ]]; then
      cp -p "$src" "$dest"
      echo "  copied ~/.amico/${f} → data/config/${f}"
    else
      echo "  (skip) ~/.amico/${f} does not exist"
    fi
  done
}

# -------------------------------------------------------------------
# Scan VS Code global settings.json for paths pointing at moved directories.
# Print the stale→new mapping and prompt for confirmation before rewriting.
scan_vscode_settings() {
  echo "--- VS Code settings scan ---"

  # Platform-dependent settings location
  local settings_file
  case "$(uname)" in
    Darwin) settings_file="${HOME}/Library/Application Support/Code/User/settings.json" ;;
    Linux)  settings_file="${HOME}/.config/Code/User/settings.json" ;;
    *)      echo "  (skip) unsupported platform for settings scan"; return 0 ;;
  esac

  if [[ ! -f "$settings_file" ]]; then
    echo "  (skip) settings.json not found at: $settings_file"
    return 0
  fi

  # Source paths that have been moved into armonia. We scan for any amicode.*
  # setting whose value contains these prefixes.
  local -a stale_paths=()
  local -a new_paths=()
  local found_stale=0

  # Check for stale harmoniqs source paths that are now under armonia/repos
  for src_dir in "${REPO_SOURCES[@]}"; do
    if grep -q "$src_dir" "$settings_file" 2>/dev/null; then
      found_stale=1
      break
    fi
  done

  if [[ $found_stale -eq 0 ]]; then
    echo "  (ok) no stale paths found in settings.json"
    return 0
  fi

  echo ""
  echo "  Found paths in VS Code settings that may be stale after migration:"
  echo ""

  # Build the mapping and show it
  local -a sed_args=()
  for src_dir in "${REPO_SOURCES[@]}"; do
    if grep -q "$src_dir" "$settings_file" 2>/dev/null; then
      # Map the old source dir to armonia/repos (the move destination)
      local escaped_src escaped_dest
      escaped_src=$(printf '%s\n' "$src_dir" | sed 's/[&/\]/\\&/g')
      escaped_dest=$(printf '%s\n' "${ARMONIA}/repos" | sed 's/[&/\]/\\&/g')
      sed_args+=(-e "s|${src_dir}|${ARMONIA}/repos|g")
      # Show specific matches
      grep -n "$src_dir" "$settings_file" | while IFS= read -r line; do
        echo "    $line"
      done
      echo "    → would replace: $src_dir → ${ARMONIA}/repos"
      echo ""
    fi
  done

  if [[ ${#sed_args[@]} -eq 0 ]]; then
    echo "  (ok) no actionable stale paths"
    return 0
  fi

  # Prompt for confirmation
  echo -n "  Rewrite these paths in settings.json? [y/N] "
  if [[ -t 0 ]]; then
    read -r answer
  else
    answer="n"
    echo "(non-interactive, skipping)"
  fi

  if [[ "$answer" =~ ^[Yy] ]]; then
    # Backup then rewrite
    cp -p "$settings_file" "${settings_file}.bak.$(date +%s)"
    sed -i '' "${sed_args[@]}" "$settings_file"
    echo "  done (backup saved as settings.json.bak.*)"
  else
    echo "  skipped — you can manually update these paths later"
  fi
}

# -------------------------------------------------------------------
# Final diagnostic: warn about any non-symlink entries under ~/.amico/ that
# are not in the known list. Informational only — never moves unknown entries.
diagnostic_pass() {
  echo "--- diagnostic ---"
  local unknown_found=0

  if [[ ! -d "$AMICO" ]]; then
    echo "  (ok) ~/.amico/ does not exist"
    return 0
  fi

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue
    local name
    name=$(basename "$entry")

    # Check if this is a known entry
    local known=0
    for k in "${KNOWN_ENTRIES[@]}"; do
      if [[ "$name" == "$k" ]]; then
        known=1
        break
      fi
    done

    if [[ $known -eq 0 ]]; then
      if [[ $unknown_found -eq 0 ]]; then
        echo "  WARNING: unknown entries found under ~/.amico/ (not migrated):"
        unknown_found=1
      fi
      if [[ -L "$entry" ]]; then
        echo "    (symlink) $name → $(readlink "$entry")"
      elif [[ -d "$entry" ]]; then
        echo "    (dir)  $name"
      else
        echo "    (file) $name"
      fi
    fi
  done < <(find "$AMICO" -mindepth 1 -maxdepth 1 2>/dev/null)

  if [[ $unknown_found -eq 0 ]]; then
    echo "  (ok) all entries under ~/.amico/ are known"
  fi
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

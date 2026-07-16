#!/usr/bin/env bash
# Amicode one-lab installer (idempotent). Run from the repo:
#   bash packages/extension/scripts/install.sh
set -euo pipefail
EXT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JULIA_PROJECT="$HOME/.amico/julia"        # absolute — '~' does not expand inside flags
VSIX="${VSIX:-$EXT_ROOT/amicode.vsix}"
LAB_TOML="$HOME/.amico/lab.toml"

say() { printf '\033[1;35m[amicode]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[amicode] %s\033[0m\n' "$*" >&2; exit 1; }

# 1. Julia present?
command -v julia >/dev/null 2>&1 || die "Julia not found. Install: curl -fsSL https://install.julialang.org | sh  (then re-run)"
say "julia: $(julia --version)"

# 1b. Julia version vs the pinned Manifest. Manifest.toml is minor-format-specific
# (pins `julia_version`); instantiating it on a different MINOR drifts silently or
# fails confusingly, undercutting the deterministic-no-resolver-drift guarantee.
# Minor mismatch → fatal; patch mismatch → warn (a patch-level re-resolve is fine).
pinned_ver="$(sed -nE 's/^julia_version = "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$EXT_ROOT/julia/Manifest.toml" | head -1)"
running_ver="$(julia --version | sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
if [ -n "$pinned_ver" ] && [ -n "$running_ver" ]; then
  if [ "${running_ver%.*}" != "${pinned_ver%.*}" ]; then
    die "Julia minor mismatch: running $running_ver, Manifest pins $pinned_ver. Match the minor and re-run, e.g.: juliaup add ${pinned_ver%.*} && juliaup default ${pinned_ver%.*}"
  elif [ "$running_ver" != "$pinned_ver" ]; then
    say "note: running Julia $running_ver differs from the Manifest's pinned patch $pinned_ver (minor matches; proceeding)."
  fi
fi

# 2. Instantiate the pinned project (deterministic; ~5-10 min first time)
mkdir -p "$JULIA_PROJECT"
cp "$EXT_ROOT/julia/Project.toml"  "$JULIA_PROJECT/Project.toml"
cp "$EXT_ROOT/julia/Manifest.toml" "$JULIA_PROJECT/Manifest.toml"
say "instantiating Piccolo project at $JULIA_PROJECT (first run precompiles - be patient)..."
julia --project="$JULIA_PROJECT" -e 'using Pkg; Pkg.instantiate()' || die "Pkg.instantiate failed (see Julia error above)"

# 3. Install the VSIX
if command -v code >/dev/null 2>&1; then
  [ -f "$VSIX" ] || die "VSIX not found at $VSIX - build it: pnpm --filter amicode package"
  code --install-extension "$VSIX" || die "code --install-extension failed"
  say "installed VSIX: $VSIX"
else
  say "WARNING: 'code' CLI not on PATH. Install it (VS Code: Shell Command: Install 'code' command), then: code --install-extension $VSIX"
fi

# 4. Starter lab.toml
if [ ! -f "$LAB_TOML" ]; then cp "$EXT_ROOT/scripts/lab.toml.example" "$LAB_TOML"; say "wrote starter $LAB_TOML"; fi

# 5. Next steps
say "done. Next: (a) configure an LLM provider for opencode + select a matching model (RUNBOOK.md step 4), (b) run: node $EXT_ROOT/scripts/healthcheck.mjs"

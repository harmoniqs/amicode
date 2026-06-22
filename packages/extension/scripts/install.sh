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

# 2. Instantiate the pinned project (deterministic; ~5-10 min first time)
mkdir -p "$JULIA_PROJECT"
cp "$EXT_ROOT/julia/Project.toml"  "$JULIA_PROJECT/Project.toml"
cp "$EXT_ROOT/julia/Manifest.toml" "$JULIA_PROJECT/Manifest.toml"
say "instantiating Piccolo project at $JULIA_PROJECT (first run precompiles - be patient)..."
julia --project="$JULIA_PROJECT" -e 'using Pkg; Pkg.instantiate()' || die "Pkg.instantiate failed (see Julia error above)"

# 2b. Build the sysimage (bakes Piccolo + CairoMakie + solve/plot paths → first
# solve starts in seconds instead of ~100s of JIT). Best-effort: if it fails the
# lab still works, just with a slow first run, and amico-run runs without it.
SYSIMG_DYLIB="$JULIA_PROJECT/amico-sysimage.dylib"; SYSIMG_SO="$JULIA_PROJECT/amico-sysimage.so"
if [ -f "$SYSIMG_DYLIB" ] || [ -f "$SYSIMG_SO" ]; then
  say "sysimage already present - skipping (delete it to rebuild)"
elif [ "${AMICO_SKIP_SYSIMAGE:-0}" = "1" ]; then
  say "AMICO_SKIP_SYSIMAGE=1 - skipping sysimage build (first solve will be slow)"
else
  say "building sysimage (one-time, ~5-15 min; removes the cold-start lag)..."
  if julia -e 'using Pkg; Pkg.add("PackageCompiler")' \
     && AMICO_JULIA_PROJECT="$JULIA_PROJECT" julia "$EXT_ROOT/julia/build_sysimage.jl"; then
    say "sysimage built - amico-run will auto-detect it"
  else
    say "WARNING: sysimage build failed - the lab still works, first solve will just be slow (re-run install.sh to retry)"
  fi
fi

# 3. Install the VSIX
if command -v code >/dev/null 2>&1; then
  [ -f "$VSIX" ] || die "VSIX not found at $VSIX - build it: pnpm --filter amicode-v2 package"
  code --install-extension "$VSIX" || die "code --install-extension failed"
  say "installed VSIX: $VSIX"
else
  say "WARNING: 'code' CLI not on PATH. Install it (VS Code: Shell Command: Install 'code' command), then: code --install-extension $VSIX"
fi

# 4. Starter lab.toml
if [ ! -f "$LAB_TOML" ]; then cp "$EXT_ROOT/scripts/lab.toml.example" "$LAB_TOML"; say "wrote starter $LAB_TOML"; fi

# 5. Next steps
say "done. Next: (a) set Bedrock creds (see RUNBOOK.md), (b) run: node $EXT_ROOT/scripts/healthcheck.mjs"

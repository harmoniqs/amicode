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

# 1. Julia present? amicode manages the toolchain via juliaup. $JULIA is the
# command used below; it becomes juliaup's launcher +<minor> when managed, so we
# pin the Manifest minor WITHOUT clobbering the user's global default.
JULIA=(julia)
pinned_ver="$(sed -nE 's/^julia_version = "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/p' "$EXT_ROOT/julia/Manifest.toml" | head -1)"
pinned_minor="${pinned_ver%.*}"
setup_fingerprint="$(node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(c.createHash("sha256").update(fs.readFileSync(process.argv[1])).update("\0").update(fs.readFileSync(process.argv[2])).digest("hex"))' "$EXT_ROOT/julia/Project.toml" "$EXT_ROOT/julia/Manifest.toml")"

install_juliaup() {
  say "installing juliaup (Julia version manager)..."
  curl -fsSL https://install.julialang.org | sh -s -- --yes || die "juliaup install failed"
  export PATH="$HOME/.juliaup/bin:$PATH"   # available in THIS shell (juliaup edits the profile for future ones)
}

if ! command -v julia >/dev/null 2>&1 && ! command -v juliaup >/dev/null 2>&1; then
  printf '\033[1;35m[amicode]\033[0m Julia not found. Install it now via juliaup? [Y/n] '
  read -r ans
  case "${ans:-Y}" in [Nn]*) die "Julia is required. Install: curl -fsSL https://install.julialang.org | sh  (then re-run)";; esac
  install_juliaup
fi

# Pin the Manifest minor via juliaup when available (add the channel if missing),
# and route this script's Julia calls through it via `julia +<minor>`.
if command -v juliaup >/dev/null 2>&1 && [ -n "$pinned_minor" ]; then
  JULIAUP_BIN="$(cd "$(dirname "$(command -v juliaup)")" && pwd)"
  JULIAUP="$JULIAUP_BIN/juliaup"
  JULIA_LAUNCHER="$JULIAUP_BIN/julia"
  if ! "$JULIA_LAUNCHER" "+${pinned_minor}" --startup-file=no --version >/dev/null 2>&1; then
    say "adding Julia ${pinned_minor} via juliaup..."
    "$JULIAUP" add "${pinned_minor}" || die "juliaup add ${pinned_minor} failed"
  fi
  JULIA=("$JULIA_LAUNCHER" "+${pinned_minor}")
fi

command -v julia >/dev/null 2>&1 || die "Julia still not found after setup — open a new shell (so the juliaup PATH edit takes) and re-run."
say "julia: $("${JULIA[@]}" --version)"

# 1b. Version vs the pinned Manifest. Manifest.toml is minor-format-specific;
# instantiating on a different MINOR drifts silently. When juliaup-pinned above
# this always matches; the check still guards a manual (non-juliaup) julia.
# Minor mismatch → fatal; patch mismatch → warn (a patch-level re-resolve is fine).
running_ver="$("${JULIA[@]}" --version | sed -nE 's/.*[^0-9]([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')"
if [ -n "$pinned_ver" ] && [ -n "$running_ver" ]; then
  if [ "${running_ver%.*}" != "${pinned_minor}" ]; then
    die "Julia minor mismatch: running $running_ver, Manifest pins $pinned_ver. Install juliaup and re-run, or: juliaup add ${pinned_minor} && juliaup default ${pinned_minor}"
  elif [ "$running_ver" != "$pinned_ver" ]; then
    say "note: running Julia $running_ver differs from the Manifest's pinned patch $pinned_ver (minor matches; proceeding)."
  fi
fi

# 2. Instantiate the pinned project (deterministic; ~5-10 min first time)
mkdir -p "$JULIA_PROJECT"
cp "$EXT_ROOT/julia/Project.toml"  "$JULIA_PROJECT/Project.toml"
cp "$EXT_ROOT/julia/Manifest.toml" "$JULIA_PROJECT/Manifest.toml"
say "instantiating Piccolo project at $JULIA_PROJECT (first run precompiles - be patient)..."
"${JULIA[@]}" --project="$JULIA_PROJECT" -e 'using Pkg; Pkg.instantiate()' || die "Pkg.instantiate failed (see Julia error above)"
setup_marker="$JULIA_PROJECT/.amicode-instantiated"
printf '%s\n' "$setup_fingerprint" > "${setup_marker}.tmp"
mv "${setup_marker}.tmp" "$setup_marker"

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

#!/usr/bin/env bash
# install-cli-pin.sh — pin the amico CLI's dist to a stable root (amicode#1666,
# the papers-digest frozen-bundle convention applied to the CLI itself).
#
# WHY: the ~/.local/bin/amico (+ amico-run, gh, …) shims are symlinks into a
# moving repo checkout, and a checkout is a moving target — observed 2026-09-25:
# the live CLI served a stale side-checkout on an old branch for weeks, and
# every ops job silently ran months-old code. The launchers resolve the PINNED
# root FIRST (AMICO_CLI_FROM_CHECKOUT=1 is the explicit dev override back to
# the checkout). This installer is how the pin gets there.
#
# Usage:
#   install-cli-pin.sh --dist <dir> [--root <dir>]
#     --dist  REQUIRED: the built dist dir (packages/amico-run/dist) — this
#             script never builds; it copies what you built.
#     --root  the pinned root. Default: $AMICO_CLI_PIN_ROOT, else
#             ~/.amico/server/cli (the launcher's own default, so the two
#             never diverge).
#
# Sidecars: one <name>.js.sha256 per bundle, shasum format ("<hex>  <name>.js")
# — the same convention as ~/.amico/ops/papers-digest/bin/amico.js.sha256;
# `amico doctor` recomputes and compares them for the pinned_cli record.
set -euo pipefail

DIST=""
ROOT="${AMICO_CLI_PIN_ROOT:-$HOME/.amico/server/cli}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dist) DIST="${2:?--dist requires a path}"; shift 2 ;;
    --root) ROOT="${2:?--root requires a path}"; shift 2 ;;
    *) echo "install-cli-pin: unknown arg: $1" >&2; echo "usage: install-cli-pin.sh --dist <dir> [--root <dir>]" >&2; exit 64 ;;
  esac
done
if [[ -z "$DIST" ]]; then
  echo "install-cli-pin: --dist is required (the built packages/amico-run/dist; this script never builds)" >&2
  echo "usage: install-cli-pin.sh --dist <dir> [--root <dir>]" >&2
  exit 64
fi
if [[ ! -d "$DIST" ]]; then
  echo "install-cli-pin: dist dir not found: $DIST" >&2
  exit 66
fi
shopt -s nullglob
BUNDLES=("$DIST"/*.js)
if [[ ${#BUNDLES[@]} -eq 0 ]]; then
  echo "install-cli-pin: no *.js bundles in $DIST — build first (pnpm --filter @amicode/amico-run build)" >&2
  exit 66
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else echo "install-cli-pin: no sha256 tool (sha256sum or shasum) on PATH" >&2; exit 69
  fi
}

mkdir -p "$ROOT"
for f in "${BUNDLES[@]}"; do
  name="$(basename "$f")"
  install -m 0755 "$f" "$ROOT/$name"
  printf '%s  %s\n' "$(sha256_file "$ROOT/$name")" "$name" > "$ROOT/$name.sha256"
  echo "pinned $name ($(sha256_file "$ROOT/$name" | cut -c1-12))"
done
echo "pinned ${#BUNDLES[@]} bundle(s) to $ROOT (sidecars written; amico doctor reports freshness as pinned_cli)"

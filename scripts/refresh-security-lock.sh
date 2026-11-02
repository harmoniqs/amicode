#!/usr/bin/env bash
# refresh-security-lock.sh — re-apply the in-range lockfile refresh that clears the Dependabot critical/high
# advisories documented in docs/security/dependabot-triage-2026-11.md, then PROVE the result with pnpm audit.
#
# WHY A SCRIPT: resolving a pnpm-lock.yaml merge conflict by taking the other side and re-resolving silently
# DISCARDS earlier refreshes (it happened on #2081: a re-resolve brought back 14 high advisories under
# @vscode/vsce). Run this after ANY lockfile conflict resolution, then check the exit code.
#
# Usage: scripts/refresh-security-lock.sh          # refresh + audit; exit 1 on any critical, or any high not allowlisted
#        scripts/refresh-security-lock.sh --check  # audit only (no changes)
# Allowed high (documented, deliberately deferred): zod 3.25.76 via gitlab-ai-provider (see the triage doc).
set -euo pipefail
cd "$(dirname "$0")/.."

PKGS=(undici js-yaml markdown-it linkify-it brace-expansion nanoid postcss source-map-js @azure/identity @azure/msal-node)
OUT="${TMPDIR:-/tmp}/refresh-security-lock.audit.$$.json"
trap 'rm -f "$OUT"' EXIT

if [ "${1:-}" != "--check" ]; then
  pnpm update --ignore-scripts "${PKGS[@]}" --recursive
fi

# pnpm audit exits non-zero when it finds anything; the verdict is computed below, not by its exit code.
pnpm audit --json > "$OUT" 2>/dev/null || true
if [ ! -s "$OUT" ]; then
  echo "refresh-security-lock: pnpm audit produced no output (registry unreachable?) — refusing to report OK" >&2
  exit 2
fi

python3 - "$OUT" <<'PY'
import json
import sys

ALLOW = {("zod", "3.25.76")}  # deferred high: see docs/security/dependabot-triage-2026-11.md
data = json.load(open(sys.argv[1]))
bad = []
for adv in data.get("advisories", {}).values():
    if adv["severity"] not in ("high", "critical"):
        continue
    for finding in adv["findings"]:
        if adv["severity"] == "high" and (adv["module_name"], finding["version"]) in ALLOW:
            continue
        # `paths` can be empty (pnpm omits it for some findings); that must never turn a real advisory
        # into a crash, or the check would fail for the wrong reason (or, worse, be mistaken for a pass).
        via = finding["paths"][0][:90] if finding.get("paths") else "(path not reported)"
        bad.append(
            "{} {}@{} (fix {}) via {}".format(
                adv["severity"], adv["module_name"], finding["version"], adv.get("patched_versions"), via
            )
        )
print("vulnerabilities:", data.get("metadata", {}).get("vulnerabilities"))
if bad:
    print("UNEXPECTED high/critical advisories:")
    for line in sorted(set(bad)):
        print("  " + line)
    sys.exit(1)
print("OK: only the documented, deferred zod high remains")
PY

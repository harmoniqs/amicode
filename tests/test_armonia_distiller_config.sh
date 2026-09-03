#!/usr/bin/env bash
# Fixture for armonia-distiller-config (vault-mgmt spec M4, portability — #363).
# Two fake homes (a Mac-shaped one and a Linux-shaped one), no real $HOME
# touched: assert every generated path resolves on its home (no foreign-home
# string survives), the binary contract is per-machine, and generation is
# idempotent.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN="$HERE/../scripts/armonia-distiller-config"
[ -x "$GEN" ] || { echo "FAIL: $GEN not executable"; exit 1; }
fail() { echo "FAIL: $*"; exit 1; }

SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT

for HOME_NAME in mac-shaped linux-shaped; do
  H="$SB/$HOME_NAME-home"
  mkdir -p "$H/.amico/vaults/vault-tester/amicode" "$H/.amico/ops" "$H/.amico/amicode" \
           "$H/.amico/problems" "$H/.amico/runs/default" \
           "$H/.vscode/extensions/harmoniqs.amicode-0.3.9" "$H/.local/bin"
  printf 'kind = "personal"\nname = "vault-tester"\n' > "$H/.amico/vaults/vault-tester/.amico-vault.toml"
  touch "$H/.vscode/extensions/harmoniqs.amicode-0.3.9/DISTILLER.md"
  if [ "$HOME_NAME" = mac-shaped ]; then
    printf '#!/bin/sh\ntrue\n' > "$H/.local/bin/amico-opencode-fleet-guard"; chmod +x "$H/.local/bin/amico-opencode-fleet-guard"
  fi
  # linux-shaped deliberately has NO fleet-guard (the erich shape — the found incident)

  AMICO_HOME="$H/.amico" HOME="$H" bash "$GEN" > "$SB/$HOME_NAME.json" \
    || fail "generation must succeed on $HOME_NAME"

  AMICO_HOME="$H/.amico" HOME="$H" bash "$GEN" > "$SB/$HOME_NAME.2.json"
  python3 - "$SB/$HOME_NAME.json" "$SB/$HOME_NAME.2.json" <<'PY' || exit 1
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
assert a == b, "generation must be idempotent (regenerate → identical)"
PY

  python3 - "$SB/$HOME_NAME.json" "$H" <<'PY' || exit 1
import json, sys, os
cfg, home = json.load(open(sys.argv[1])), sys.argv[2]

def walk_paths(o):
    if isinstance(o, dict):
        for k, v in o.items():
            yield from walk_paths(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk_paths(v)
    elif isinstance(o, str):
        yield o

# the incident's invariant, portable form: every generated path stays inside
# its own home tree and resolves — a foreign-home string (the /Users/ bug)
# cannot survive because every path is $HOME-derived
for p in walk_paths(cfg):
    if p.startswith("/"):
        assert p.startswith(home + "/"), f"no foreign-home path may survive: {p}"
        assert os.path.exists(p), f"every generated absolute path must resolve on its home: {p}"
assert "/Users/" not in open(sys.argv[1]).read(), "the literal incident string must never appear on a non-Mac home"

binary = cfg["binary"]
if sys.argv[2].endswith("mac-shaped-home"):
    assert binary and os.path.exists(binary), "mac-shaped: fleet-guard present → declared + resolvable"
    assert "present" in cfg["binary_contract"]
else:
    assert binary is None, "linux-shaped: fleet-guard absent → declared ABSENT (null), never a Mac-shaped placeholder"
    assert "ABSENT" in cfg["binary_contract"]

assert cfg["job_defaults"]["vault_display_name"] == "vault-tester", "display name from the identity file"
PY
done

echo "PASS: distiller-config portability (two homes resolve; binary per-machine contract; idempotent)"

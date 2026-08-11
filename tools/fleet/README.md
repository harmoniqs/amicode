# Fleet — configurable multi-machine studio

Operational tooling for Amicode's fleet: one canonical server, clients attach via tunnel.

## Architecture

Fleet topology is declared in `~/.amico/ops/fleet/fleet.json`:

```json
{
  "role": "client",
  "canonical": {
    "host": "my-server-hostname",
    "port": 4096,
    "sshAlias": "my-server"
  }
}
```

- **No file = standalone** (safe default — local server, pre-fleet behavior)
- `role`: `"standalone"` | `"server"` | `"client"`
- The guard script, extension, installer, and CI all read from this file

## Components

* **Guard** — `amico-opencode-fleet-guard` installed to `~/.local/bin`. Client reads fleet.json and exits 1 (panel rides tunnel); server/standalone execs the frozen opencode binary. Prevents silent fork (ADR 0005, #279, #324, #338).
* **Tunnel** — `co.harmoniqs.amico-tunnel.plist` (launchd) with `ServerAliveInterval 15 / CountMax 2 / TCPKeepAlive yes`. The SSH alias and port come from fleet.json.
* **Extension** — detects fleet role at activation; client mode polls the tunnel; "Go Standalone" switches permanently to local mode.

## Commands

| Command | What it does |
|---------|-------------|
| `Amicode: Fleet — Go Standalone` | Leave the fleet permanently. Writes `role: "standalone"`, clears guard/port settings, unloads tunnel, spawns local server. |
| `Amicode: Fleet — Repair` | Re-installs guard + tunnel from repo (same as `bash tools/fleet/install.sh`). |

## Install (for fleet clients/servers)

```bash
# Create fleet.json first:
mkdir -p ~/.amico/ops/fleet
cat > ~/.amico/ops/fleet/fleet.json << 'EOF'
{
  "role": "client",
  "canonical": {
    "host": "your-server-hostname",
    "port": 4096,
    "sshAlias": "your-ssh-alias"
  }
}
EOF

# Then install guard + tunnel + settings:
bash tools/fleet/install.sh          # idempotent: guard + tunnel + machine settings
bash tools/fleet/install.sh --check  # check only (CI + healthcheck)
```

## Verification

```bash
cat ~/.amico/ops/fleet/fleet.json    # role + canonical
lsof -nP -iTCP:4096 -sTCP:LISTEN    # ssh LISTEN (tunnel), no opencode
curl http://127.0.0.1:4096/session   # 200 via tunnel
```

## Go Standalone

When the canonical is offline or you want to leave the fleet:

```bash
# In VS Code:
#   Command Palette → Amicode: Fleet — Go Standalone
#   — writes fleet.json role=standalone, clears guard override
#     (opencodeBinary="" + opencodePort=0 → ephemeral), unloads tunnel, restarts locally.

# Manual (no VS Code):
cat > ~/.amico/ops/fleet/fleet.json << 'EOF'
{"role": "standalone"}
EOF
# Then restart VS Code / the extension.
```

## Prevention

* **In-extension fleet health** — `src/fleet_health.ts` + `amicode.healthcheck` report `Fleet role / guard / settings / tunnel` (darwin-only, skipped when standalone).
* **Installer** — `tools/fleet/install.sh` reads fleet.json for topology. No file = skip.
* **CI gate** — `ci.yml` `fleet-gate` runs `assert_fleet_guard.sh` (verifies guard references fleet.json, has exit 1, packaged copies in sync).

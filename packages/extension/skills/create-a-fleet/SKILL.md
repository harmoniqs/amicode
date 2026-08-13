---
name: create-a-fleet
description: "Fleet lifecycle management — create, add machines, remove, dismantle, reconfigure. Use when the user clicks Create Fleet or asks to set up/manage a fleet."
agents: [researcher, experimenter]
surface: public
---

# Fleet Management

Manage the Amicode fleet lifecycle — create a fleet, add machines, remove machines,
dismantle, reconfigure, and check sync status. The fleet is a set of machines sharing
one canonical opencode server (the "host"). Clients connect over SSH tunnels and auto-sync
their extension + binary state from the host.

**Architecture:** Host is ground truth, clients are disposable mirrors, standalone is
the offline fallback. Sync is bidirectional: fleet mode = host→client auto-sync;
standalone dev work pushes back to host on reconnect via direct SSH git push (no GitHub
intermediary).

## When to use

Use this skill when:
- The user clicks "Create Fleet" in the fleet panel
- The user asks to set up a fleet, add/remove a machine, dismantle, or reconfigure
- The user asks about fleet status or sync health

## Prerequisites

- SSH key-based auth is configured to the target host (you validate, don't set up keys)
- The user tells you the SSH target (`user@host` or an SSH alias)
- You have bash tool access to run `ssh target "command"` from the local machine

## Operations

### `/fleet create` — Full Setup Flow

Two modes: **Development clone** (push local repos, build from source) and **Release binary**
(binary already installed on remote).

#### Step 1: Get the SSH target

Ask the user for the SSH alias or `user@host` for the remote server.
Use the `question` tool with `kind: "text"` and `options: []` (the schema
requires the `options` key even for free-form text inputs).

#### Step 2: Validate SSH connectivity

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <target> "echo ok"
```

If this fails, the user's SSH keys aren't configured. Tell them and stop.

#### Step 3: Choose binary mode

Ask: **Development clone** (for amicode developers — pushes repos, builds from source)
or **Release binary** (binary pre-installed on the remote).

#### Step 4: Pre-flight checks

```bash
# Check if port 4096 is available
ssh <target> 'lsof -i :4096 -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && echo taken || echo free'
```

If the port is taken, ask the user to choose a different port or stop the existing service.

#### Step 5 (dev-clone only): Check and install dev tools

Check each tool:
```bash
ssh <target> "git --version"
ssh <target> "node --version"
ssh <target> "pnpm --version"
ssh <target> "bun --version"
```

If any are missing, **offer to install them**:
```bash
# Install bun
ssh <target> 'curl -fsSL https://bun.sh/install | bash'

# Install pnpm (requires node)
ssh <target> 'npm install -g pnpm'

# Install node via nvm (if node missing)
ssh <target> 'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash && source ~/.nvm/nvm.sh && nvm install --lts'
```

Re-check after installation. If still missing, report and stop.

#### Step 6 (dev-clone only): Detect local repos

Walk up from the extension path to find the amicode repo root:
```bash
# On the LOCAL machine:
# amicode repo: walk up from the running extension to find .git
# opencode repo: walk up from the configured binary path to find .git
# Fallback: ~/harmoniqs/amicode and ~/harmoniqs/opencode
```

#### Step 7 (dev-clone only): Push repos to host

```bash
# Init bare-ish repos on host (accept pushes to checked-out branch)
ssh <target> 'mkdir -p ~/harmoniqs/opencode ~/harmoniqs/amicode && \
  cd ~/harmoniqs/opencode && [ ! -d .git ] && git init && git config receive.denyCurrentBranch updateInstead; \
  cd ~/harmoniqs/amicode && [ ! -d .git ] && git init && git config receive.denyCurrentBranch updateInstead'

# Push from local (use 600s timeout — initial push of a 530MB repo takes time)
cd <local-opencode-repo>
git remote remove fleet-host 2>/dev/null || true
git remote add fleet-host <target>:~/harmoniqs/opencode
git push fleet-host <current-branch>:<current-branch> --force

cd <local-amicode-repo>
git remote remove fleet-host 2>/dev/null || true
git remote add fleet-host <target>:~/harmoniqs/amicode
git push fleet-host <current-branch>:<current-branch> --force

# Checkout branches on host
ssh <target> 'cd ~/harmoniqs/opencode && git checkout <branch> && cd ~/harmoniqs/amicode && git checkout <branch>'
```

**Timeout handling:** If push times out, retry. The initial push of a large repo can take
5-10 minutes. Report progress: "Pushing opencode (530 MB) — this can take several minutes
on the first push."

#### Step 8: Copy session databases to server

Copy local opencode session databases to the server **before** the build. This ensures
sessions are in place before the binary or service starts (which would otherwise create
empty DBs). The `local_rebuild_amicode.sh` script's backup/restore logic then protects
them on subsequent rebuilds.

```bash
# Check if local session databases exist
ls ~/.local/share/opencode/opencode*.db 2>/dev/null

# Ensure target directory exists
ssh <target> 'mkdir -p ~/.local/share/opencode'

# Copy databases (clean copy — server has no sessions on first setup)
scp ~/.local/share/opencode/opencode*.db <target>:~/.local/share/opencode/
# Also copy WAL/SHM sidecars if present
scp ~/.local/share/opencode/opencode*.db-wal <target>:~/.local/share/opencode/ 2>/dev/null || true
scp ~/.local/share/opencode/opencode*.db-shm <target>:~/.local/share/opencode/ 2>/dev/null || true
```

If the server already has sessions (e.g. re-creating a fleet), copy with a `.local-merge.db`
suffix and attempt a sqlite3 merge on the server instead of overwriting.

Skip this step if no local session databases exist (first install).

#### Step 9 (dev-clone only): Build on host

```bash
# Build opencode binary
ssh <target> 'cd ~/harmoniqs/opencode/packages/opencode && bun install && bun run script/build.ts --single --skip-install'

# Build amicode extension
ssh <target> 'cd ~/harmoniqs/amicode && pnpm install && cd packages/extension && pnpm run build'

# Codesign (macOS only)
ssh <target> 'codesign --sign - --force ~/harmoniqs/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode 2>/dev/null || true'
```

**Build failure handling:** If a build fails, read the error output. Common issues:
- Missing native deps: suggest `brew install` or `apt install`
- Node version too old: suggest nvm upgrade
- pnpm lockfile mismatch: suggest `pnpm install --no-frozen-lockfile`

#### Step 10: Create fleet directory and write fleet.json on host

```bash
ssh <target> 'mkdir -p ~/.amico/ops/fleet'

# Write fleet.json (atomic: tmp + mv)
ssh <target> 'cat > ~/.amico/ops/fleet/fleet.json.tmp << '\''EOF'\''
{
  "role": "server",
  "canonical": {
    "host": "<target>",
    "port": 4096
  }
}
EOF
mv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json'
```

#### Step 11: Generate and store fleet token

```bash
# Generate a 32-byte hex token
TOKEN=$(openssl rand -hex 32)

# Store on host
ssh <target> "printf '%s' '${TOKEN}' > ~/.amico/ops/fleet/fleet_token.tmp && chmod 600 ~/.amico/ops/fleet/fleet_token.tmp && mv ~/.amico/ops/fleet/fleet_token.tmp ~/.amico/ops/fleet/fleet_token"
```

#### Step 12: Install server service

**macOS (launchd):**
```bash
ssh <target> 'mkdir -p ~/Library/LaunchAgents && cat > ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist << '\''EOF'\''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.harmoniqs.amico-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>BINARY_PATH</string>
    <string>serve</string>
    <string>--port</string>
    <string>4096</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/amico-server.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/amico-server.err.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist 2>/dev/null
launchctl start co.harmoniqs.amico-server'
```

Replace `BINARY_PATH` with:
- Dev-clone mode: `~/harmoniqs/opencode/packages/opencode/dist/opencode-darwin-arm64/bin/opencode`
- Release mode: the path from `which opencode` or `~/.local/bin/opencode`

**Linux (systemd):**
```bash
ssh <target> 'mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/amico-server.service << '\''EOF'\''
[Unit]
Description=Amico Fleet Server
After=network.target

[Service]
ExecStart=BINARY_PATH serve --port 4096
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now amico-server.service'
```

#### Step 13: Configure local machine as client

Write the local fleet.json:
```bash
mkdir -p ~/.amico/ops/fleet
cat > ~/.amico/ops/fleet/fleet.json.tmp << 'EOF'
{
  "role": "client",
  "canonical": {
    "host": "<target>",
    "port": 4096,
    "sshAlias": "<target>"
  }
}
EOF
mv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json

# Store token locally
printf '%s' "${TOKEN}" > ~/.amico/ops/fleet/fleet_token.tmp
chmod 600 ~/.amico/ops/fleet/fleet_token.tmp
mv ~/.amico/ops/fleet/fleet_token.tmp ~/.amico/ops/fleet/fleet_token
```

#### Step 14: Install tunnel plist (macOS client only)

```bash
cat > ~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.harmoniqs.amico-tunnel</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string>
    <string>ServerAliveInterval=15</string>
    <string>-o</string>
    <string>ServerAliveCountMax=2</string>
    <string>-o</string>
    <string>TCPKeepAlive=yes</string>
    <string>-L</string>
    <string>127.0.0.1:4096:127.0.0.1:4096</string>
    <string>SSH_ALIAS</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/amico-tunnel.err.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist
```

Replace `SSH_ALIAS` with the target, and `4096` with the chosen port.

#### Step 15: Write server version file

```bash
ssh <target> 'VERSION=$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(\"$HOME/harmoniqs/amicode/packages/extension/package.json\",\"utf8\")).version)" 2>/dev/null || echo "0.0.0")
mkdir -p ~/.amico/ops/fleet
cat > ~/.amico/ops/fleet/server_version.json << VEOF
{
  "version": "$VERSION",
  "schema": 1,
  "capabilities": ["sessions", "fleet-state", "fleet-action", "profiles", "host-settings", "sweep", "topology"]
}
VEOF'
```

#### Step 16: Verify and finish

Run the validation checklist:
```bash
# Server service running?
ssh <target> 'launchctl list | grep co.harmoniqs.amico-server'  # macOS
# or: ssh <target> 'systemctl --user is-active amico-server.service'  # Linux

# Server responding?
ssh <target> 'curl -s http://127.0.0.1:4096/ | head -1'

# Tunnel connects (from local)?
curl -s http://127.0.0.1:4096/ | head -1
```

Tell the user: **"Fleet created. Reload VS Code to connect to the host server."**

---

### `/fleet add <target>` — Add a Machine

1. Validate SSH connectivity to the new target
2. Run pre-flight (port available, binary present or dev-clone provision)
3. Configure the target as a client (write fleet.json, store token, install tunnel plist)
4. Verify tunnel connects

---

### `/fleet remove <target>` — Remove a Machine

1. SSH into the target
2. Revert fleet.json to standalone:
   ```bash
   ssh <target> 'cat > ~/.amico/ops/fleet/fleet.json.tmp << '\''EOF'\''
   {"role": "standalone"}
   EOF
   mv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json'
   ```
3. Unload tunnel/guard services:
   ```bash
   ssh <target> 'launchctl unload ~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist 2>/dev/null; true'
   ```

---

### `/fleet dismantle` — Tear Down the Fleet

1. Read the current fleet config to find the server target
2. Stop the server service:
   ```bash
   # macOS:
   ssh <server> 'launchctl stop co.harmoniqs.amico-server 2>/dev/null; launchctl unload ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist 2>/dev/null; true'
   # Linux:
   ssh <server> 'systemctl --user stop amico-server.service 2>/dev/null; systemctl --user disable amico-server.service 2>/dev/null; true'
   ```
3. Revert server to standalone (same as remove)
4. Revert local to standalone:
   ```bash
   cat > ~/.amico/ops/fleet/fleet.json.tmp << 'EOF'
   {"role": "standalone"}
   EOF
   mv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json
   ```
5. Unload local tunnel plist

---

### `/fleet reconfigure` — Change Host/Port/SSH Alias

1. Read current fleet.json
2. Ask what to change (host, port, SSH alias)
3. Update fleet.json (atomic write)
4. If port changed: update tunnel plist, reload
5. If host changed: update tunnel plist, reload; verify connectivity

---

### `/fleet status` — Show Current State

```bash
# Local role
cat ~/.amico/ops/fleet/fleet.json

# Server health (if client)
curl -s http://127.0.0.1:4096/ | head -1

# Tunnel status (macOS)
launchctl list | grep co.harmoniqs.amico-tunnel

# Server service status (if server)
ssh <server> 'launchctl list | grep co.harmoniqs.amico-server'
```

---

## Error Handling

### Missing tools (install them)
Never just report "tool X not found." Always offer to install:
- **bun**: `curl -fsSL https://bun.sh/install | bash`
- **pnpm**: `npm install -g pnpm`
- **node**: via nvm or system package manager
- **git**: `brew install git` (macOS) or `apt install git` (Linux)

### Push timeout (retry with progress)
The initial push of a ~530 MB repo can take 5-10 minutes. If it times out:
- Report how far it got (git push shows progress)
- Retry — subsequent pushes are incremental and much faster
- Consider: `git push --force` with a longer timeout

### Build failure (read error, fix, retry)
- Read the full stderr output
- Common patterns: missing native dependency, wrong Node version, lockfile drift
- Fix the issue on the host (install deps, update node), then retry the build step

### Service won't start (check logs)
```bash
# macOS:
ssh <target> 'cat /tmp/amico-server.err.log'
ssh <target> 'cat /tmp/amico-server.out.log'

# Linux:
ssh <target> 'journalctl --user -u amico-server.service --no-pager -n 50'
```

---

## Fleet.json Schema

```json
{
  "role": "standalone" | "server" | "client",
  "canonical": {
    "host": "user@hostname",
    "port": 4096,
    "sshAlias": "optional-ssh-alias"
  }
}
```

Location: `~/.amico/ops/fleet/fleet.json`

**All writes MUST be atomic** — write to `.tmp`, then `mv`:
```bash
cat > ~/.amico/ops/fleet/fleet.json.tmp << 'EOF'
<content>
EOF
mv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json
```

---

## Local Repo Detection

The agent detects repo paths from the running build context:

- **Amicode repo:** Walk up from the extension install path (the running VS Code extension
  lives inside the repo) until finding `.git`. Fallback: `~/harmoniqs/amicode`.
- **Opencode repo:** Walk up from the configured opencode binary path (the `amicode.opencodeBinary`
  VS Code setting) until finding `.git`. Fallback: `~/harmoniqs/opencode`.

To find these in practice:
```bash
# The extension path is available in the chat context — walk up to .git
# The binary path is in VS Code settings: amicode.opencodeBinary

# Or use the fallbacks directly:
ls ~/harmoniqs/amicode/.git  # amicode repo
ls ~/harmoniqs/opencode/.git  # opencode repo
```

---

## Validation Checklist

Run these to confirm the fleet is healthy:

1. **SSH reachable**: `ssh -o BatchMode=yes -o ConnectTimeout=10 <target> "echo ok"`
2. **Tools present** (dev-clone): `ssh <target> "git --version && node --version && pnpm --version && bun --version"`
3. **Repos pushed** (dev-clone): `ssh <target> "test -d ~/harmoniqs/opencode/.git && test -d ~/harmoniqs/amicode/.git && echo ok"`
4. **Build succeeds** (dev-clone): Binary exists at expected path
5. **Service running**: `ssh <target> 'launchctl list | grep co.harmoniqs.amico-server'` (macOS)
6. **Server responding**: `ssh <target> 'curl -s http://127.0.0.1:4096/ | head -1'`
7. **Tunnel connects** (client): `curl -s http://127.0.0.1:4096/ | head -1` (from local)

---

## Constraints

- The agent MUST validate SSH connectivity before any remote operation
- The agent MUST NOT store SSH passwords or private keys
- The agent MUST report each step's outcome before proceeding to the next
- The agent MUST offer to install missing tools (not just report them missing)
- Fleet.json writes MUST be atomic (tmp + rename)
- The canonical server MUST be a system service (launchd/systemd), not a child process
- Sessions MUST survive client disconnect (the service config ensures this)

## Cross-reference

For fleet troubleshooting (sync conflicts, tunnel down, drift, SSH failures),
use `/fleet-troubleshooting` instead. It is launched automatically from fleet
notifications when an issue is detected.

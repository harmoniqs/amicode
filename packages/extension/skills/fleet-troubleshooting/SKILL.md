---
name: fleet-troubleshooting
description: Diagnose and resolve fleet issues — sync conflicts, tunnel connectivity, fleet drift, SSH failures, and sync errors. Launched automatically from fleet notifications.
agents: [pulse-designer]
surface: internal
---

# Fleet Troubleshooting

You are helping the user diagnose and resolve a fleet issue. This skill is
triggered automatically when the fleet detects a problem — the prompt includes
structured diagnostic context under `## Fleet Issue` with the issue kind and
relevant details.

## Issue Kinds

### sync-conflict

**What happened:** The local and host git repositories have diverged — a push
was rejected because both sides have commits the other doesn't.

**Diagnosis steps:**

1. Identify the repo (amicode or opencode) from the context
2. Show the divergence:
   ```bash
   git -C <repo_path> log --oneline <remote_sha>..<local_sha>  # local-only commits
   git -C <repo_path> log --oneline <local_sha>..<remote_sha>  # host-only commits
   ```
3. Check if the local commits are meaningful (real work vs auto-sync artifacts)

**Resolution strategies (present all, recommend based on context):**

- **Rebase local onto host** (recommended when local has real work):
  ```bash
  git -C <repo_path> fetch fleet-host
  git -C <repo_path> rebase fleet-host/<branch>
  ```
  Then re-run sync: `Cmd+Shift+P → Amicode: Sync with fleet host`

- **Force-push local to host** (when local is ahead and host changes are stale):
  ```bash
  git -C <repo_path> push fleet-host <branch> --force-with-lease
  ```
  Then trigger host rebuild via sync command.

- **Hard-reset local to host** (when local changes are expendable):
  ```bash
  git -C <repo_path> fetch fleet-host
  git -C <repo_path> reset --hard fleet-host/<branch>
  ```

**After resolution:** Tell the user to re-run sync (`Cmd+Shift+P → Amicode: Sync with fleet host`) to verify.

---

### tunnel-down

**What happened:** The SSH tunnel to the fleet host is not responding. The
extension polled `127.0.0.1:<port>` multiple times and got no response.

**Diagnosis steps:**

1. Check if the tunnel LaunchAgent is running:
   ```bash
   launchctl list | grep amico-tunnel
   ```
2. Check if the SSH connection to the host works at all:
   ```bash
   ssh -o BatchMode=yes -o ConnectTimeout=5 <host_alias> echo ok
   ```
3. Check if the port forward is listening:
   ```bash
   lsof -i TCP:<port> -sTCP:LISTEN
   ```
4. Check the tunnel log:
   ```bash
   cat ~/Library/Logs/amico-tunnel.log | tail -30
   ```

**Resolution strategies:**

- **Restart the tunnel** (most common fix):
  ```bash
  launchctl kickstart -k gui/$(id -u)/co.harmoniqs.amico-tunnel
  ```

- **Re-establish SSH connectivity** (if SSH itself fails):
  - Check `~/.ssh/config` for the host alias
  - Verify the host is reachable: `ping <host_ip>`
  - Check SSH key: `ssh-add -l`
  - If using Tailscale: `tailscale status`

- **Port conflict** (if another process holds the port):
  ```bash
  lsof -i TCP:<port> -sTCP:LISTEN
  kill <pid>  # if it's a stale tunnel
  launchctl kickstart -k gui/$(id -u)/co.harmoniqs.amico-tunnel
  ```

- **Go standalone** (if the host is genuinely unreachable):
  ```bash
  # Via command palette: Amicode: Go Standalone
  ```
  Explain that standalone mode runs everything locally until the host returns.

---

### fleet-drift

**What happened:** The fleet client's local services are misconfigured — the
LaunchAgent plist, guard script, or extension settings don't match what the
fleet expects.

**Diagnosis steps:**

1. Read which checks failed from the context (`failed_checks` field)
2. For each failed check, inspect the specific file:
   - **guard**: Check `~/harmoniqs/amicode/packages/extension/fleet-guard.sh` exists and is executable
   - **tunnel plist**: Check `~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist` has correct port/host
   - **binary path**: Check `amicode.opencodeBinary` in VS Code settings matches the fleet binary
   - **port mismatch**: Check `amicode.opencodePort` matches the tunnel's local port

**Resolution strategies:**

- **Re-run fleet setup** (recommended — fixes everything):
  ```bash
  # The fleet installer script re-derives all config from fleet.json
  bash ~/harmoniqs/amicode/packages/extension/scripts/fleet-client-install.sh
  ```

- **Fix individual settings** (surgical, when only one check failed):
  - Update `amicode.opencodeBinary` in VS Code settings
  - Edit the plist to fix port/host, then `launchctl bootout` + `bootstrap`
  - Regenerate the guard script

- **After fixing:** Reload the window (`Cmd+Shift+P → Developer: Reload Window`)

---

### ssh-failure

**What happened:** An SSH command to the fleet host failed — auth rejected,
host key mismatch, timeout, or other SSH error.

**Diagnosis steps:**

1. Read the error from context (`stderr`, `exit_code`)
2. Test SSH manually:
   ```bash
   ssh -vvv -o BatchMode=yes -o ConnectTimeout=10 <target> echo ok
   ```
3. Common error patterns:
   - `Permission denied` → key not loaded or not authorized
   - `Host key verification failed` → host key changed (MITM warning or reinstall)
   - `Connection timed out` → network issue or host down
   - `Connection refused` → SSH daemon not running on host

**Resolution strategies:**

- **Key not loaded:**
  ```bash
  ssh-add ~/.ssh/id_ed25519  # or whichever key
  ssh-add -l  # verify
  ```

- **Key not authorized on host:**
  ```bash
  ssh-copy-id <target>
  ```

- **Host key changed** (only if you trust the change):
  ```bash
  ssh-keygen -R <host_ip>
  ssh <target>  # accept new key
  ```

- **Host unreachable:** Check network, VPN/Tailscale status, firewall rules.

---

### sync-error

**What happened:** The sync process failed for a non-conflict reason — a build
failed on the host, rsync/scp failed, or git operations errored.

**Diagnosis steps:**

1. Read the error message from context
2. Common patterns:
   - `build failed` → compilation error on the host after pulling
   - `rsync: connection unexpectedly closed` → SSH interrupted mid-transfer
   - `git: not a git repository` → repo path is wrong or deleted

**Resolution strategies:**

- **Build failure on host:** SSH in and check:
  ```bash
  ssh <host> "cd ~/harmoniqs/opencode && git status && npm run build 2>&1 | tail -20"
  ```
  Fix the build error, then re-sync.

- **Transfer failure:** Usually transient — retry:
  ```bash
  # Cmd+Shift+P → Amicode: Sync with fleet host
  ```

- **Missing repo:** The host may need re-cloning:
  ```bash
  ssh <host> "cd ~/harmoniqs && git clone <repo_url>"
  ```

---

## General Principles

1. **Always show what you're doing** — run diagnostic commands and show their output before proposing fixes.
2. **Prefer the least destructive option** — rebase over force-push, restart over reinstall.
3. **Verify after fixing** — always end with a verification step (re-run sync, check status).
4. **Offer standalone as escape hatch** — if the issue can't be resolved quickly, going standalone lets the user keep working while we debug.
5. **Read fleet.json for topology** — `~/.amico/ops/fleet/fleet.json` has the host target, port, and role.

## Cross-reference

For fleet lifecycle operations (create, add, remove, dismantle, reconfigure),
use `/create-a-fleet` instead.

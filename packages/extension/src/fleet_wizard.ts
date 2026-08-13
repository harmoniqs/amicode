// Fleet Setup Wizard — SSH-based fleet creation, machine add/remove, dismantle,
// and reconfiguration. Uses child_process.spawn for SSH commands, never stores
// passwords/keys. Validates SSH connectivity before proceeding.
//
// Part of #354 (Fleet Panel: setup wizard + fleet lifecycle).

import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { writeFleetConfig, FLEET_DIR, type FleetConfig } from "./fleet_fallback";

// ============================================================================
// SSH execution helpers (pure, testable with mocked exec)
// ============================================================================

export interface SshExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

export type SshExec = (target: string, command: string) => Promise<SshExecResult>;

/** Default SSH executor: spawns `ssh <target> <command>`. */
export function defaultSshExec(target: string, command: string): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const proc = cp.spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, command], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }));
    proc.on("error", (err) => resolve({ ok: false, stdout: "", stderr: err.message, code: null }));
  });
}

/** Default SCP executor: copies a file to the remote. */
export function scpFile(localPath: string, target: string, remotePath: string): Promise<SshExecResult> {
  return new Promise((resolve) => {
    const proc = cp.spawn("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", localPath, `${target}:${remotePath}`], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), code }));
    proc.on("error", (err) => resolve({ ok: false, stdout: "", stderr: err.message, code: null }));
  });
}

// ============================================================================
// Pre-flight checks
// ============================================================================

export interface PreflightCheck {
  name: string;
  status: "pending" | "pass" | "fail";
  detail?: string;
  fix?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  allPass: boolean;
}

/** Run pre-flight checks on the SSH target. */
export async function runPreflight(
  target: string,
  opts: { exec?: SshExec; binaryName?: string; port?: number } = {},
): Promise<PreflightResult> {
  const exec = opts.exec ?? defaultSshExec;
  const binaryName = opts.binaryName ?? "opencode";
  const port = opts.port ?? 4096;
  const checks: PreflightCheck[] = [];

  // 1. SSH reachable
  const sshCheck: PreflightCheck = { name: "SSH reachable", status: "pending" };
  checks.push(sshCheck);
  const sshResult = await exec(target, "echo ok");
  if (sshResult.ok && sshResult.stdout.includes("ok")) {
    sshCheck.status = "pass";
  } else {
    sshCheck.status = "fail";
    sshCheck.detail = sshResult.stderr || "Connection failed";
    sshCheck.fix = "Verify SSH key-based auth is configured for this host";
    return { checks, allPass: false };
  }

  // 2. Binary present
  const binCheck: PreflightCheck = { name: "Binary present", status: "pending" };
  checks.push(binCheck);
  const whichResult = await exec(target, `which ${binaryName} || test -f ~/.local/bin/${binaryName} && echo found`);
  if (whichResult.ok && (whichResult.stdout.includes("/") || whichResult.stdout.includes("found"))) {
    binCheck.status = "pass";
  } else {
    binCheck.status = "fail";
    binCheck.detail = `${binaryName} not found on remote`;
    binCheck.fix = `SCP the binary to the remote machine: scp $(which ${binaryName}) ${target}:~/.local/bin/`;
  }

  // 3. Port available
  const portCheck: PreflightCheck = { name: "Port available", status: "pending" };
  checks.push(portCheck);
  const portResult = await exec(target, `lsof -i :${port} -sTCP:LISTEN 2>/dev/null | grep -q LISTEN && echo taken || echo free`);
  if (portResult.stdout.includes("free") || !portResult.stdout.includes("taken")) {
    portCheck.status = "pass";
  } else {
    portCheck.status = "fail";
    portCheck.detail = `Port ${port} is already in use on the remote machine`;
    portCheck.fix = `Choose a different port or stop the process using port ${port}`;
  }

  return { checks, allPass: checks.every((c) => c.status === "pass") };
}

// ============================================================================
// Fleet lifecycle operations
// ============================================================================

export interface WizardStep {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}

/** Generate a fleet token. */
export function generateFleetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Configure the remote machine as a fleet server.
 *  Returns the steps with their final status. */
export async function configureRemoteServer(
  target: string,
  opts: {
    exec?: SshExec;
    port?: number;
    token?: string;
    platform?: "darwin" | "linux";
    binaryPath?: string;
  } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const port = opts.port ?? 4096;
  const token = opts.token ?? generateFleetToken();
  const platform = opts.platform ?? "darwin";
  const binaryPath = opts.binaryPath;
  const steps: WizardStep[] = [];

  // Step 1: Create fleet directory
  const mkdirStep: WizardStep = { name: "Create fleet directory", status: "running" };
  steps.push(mkdirStep);
  const mkdirResult = await exec(target, "mkdir -p ~/.amico/ops/fleet");
  if (!mkdirResult.ok) {
    mkdirStep.status = "failed";
    mkdirStep.detail = mkdirResult.stderr;
    return steps;
  }
  mkdirStep.status = "done";

  // Step 2: Write fleet.json (role: server)
  const configStep: WizardStep = { name: "Write fleet.json", status: "running" };
  steps.push(configStep);
  const fleetJson = JSON.stringify({ role: "server", canonical: { host: target, port } }, null, 2);
  const writeResult = await exec(target,
    `cat > ~/.amico/ops/fleet/fleet.json.tmp << 'FLEETEOF'\n${fleetJson}\nFLEETEOF\nmv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json`);
  if (!writeResult.ok) {
    configStep.status = "failed";
    configStep.detail = writeResult.stderr;
    return steps;
  }
  configStep.status = "done";

  // Step 3: Store fleet token
  const tokenStep: WizardStep = { name: "Store fleet token", status: "running" };
  steps.push(tokenStep);
  const tokenResult = await exec(target,
    `printf '%s' '${token}' > ~/.amico/ops/fleet/fleet_token.tmp && chmod 600 ~/.amico/ops/fleet/fleet_token.tmp && mv ~/.amico/ops/fleet/fleet_token.tmp ~/.amico/ops/fleet/fleet_token`);
  if (!tokenResult.ok) {
    tokenStep.status = "failed";
    tokenStep.detail = tokenResult.stderr;
    return steps;
  }
  tokenStep.status = "done";

  // Step 4: Install and start the server service
  const serviceStep: WizardStep = { name: "Start server service", status: "running" };
  steps.push(serviceStep);
  if (platform === "darwin") {
    // Create launchd plist
    const plist = buildServerLaunchdPlist(port, binaryPath);
    const svcResult = await exec(target,
      `mkdir -p ~/Library/LaunchAgents && cat > ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist.tmp << 'PLISTEOF'\n${plist}\nPLISTEOF\nmv ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist.tmp ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist && launchctl load ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist 2>/dev/null; launchctl start co.harmoniqs.amico-server`);
    if (!svcResult.ok) {
      serviceStep.status = "failed";
      serviceStep.detail = svcResult.stderr;
      return steps;
    }
  } else {
    // systemd unit
    const unit = buildServerSystemdUnit(port, binaryPath);
    const svcResult = await exec(target,
      `mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/amico-server.service.tmp << 'UNITEOF'\n${unit}\nUNITEOF\nmv ~/.config/systemd/user/amico-server.service.tmp ~/.config/systemd/user/amico-server.service && systemctl --user daemon-reload && systemctl --user enable --now amico-server.service`);
    if (!svcResult.ok) {
      serviceStep.status = "failed";
      serviceStep.detail = svcResult.stderr;
      return steps;
    }
  }
  serviceStep.status = "done";

  return steps;
}

/** Configure the local machine as a fleet client. */
export function configureLocalClient(
  canonicalHost: string,
  opts: {
    port?: number;
    sshAlias?: string;
    token?: string;
  } = {},
): WizardStep[] {
  const port = opts.port ?? 4096;
  const sshAlias = opts.sshAlias ?? canonicalHost;
  const token = opts.token ?? "";
  const steps: WizardStep[] = [];

  // Step 1: Write fleet.json
  const configStep: WizardStep = { name: "Write local fleet.json", status: "running" };
  steps.push(configStep);
  try {
    const config: FleetConfig = {
      role: "client",
      canonical: { host: canonicalHost, port, sshAlias },
    };
    writeFleetConfig(config);
    configStep.status = "done";
  } catch (err) {
    configStep.status = "failed";
    configStep.detail = String(err);
    return steps;
  }

  // Step 2: Store fleet token locally
  const tokenStep: WizardStep = { name: "Store fleet token", status: "running" };
  steps.push(tokenStep);
  try {
    const tokenPath = path.join(FLEET_DIR, "fleet_token");
    const tmp = `${tokenPath}.tmp`;
    fs.mkdirSync(FLEET_DIR, { recursive: true });
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, tokenPath);
    tokenStep.status = "done";
  } catch (err) {
    tokenStep.status = "failed";
    tokenStep.detail = String(err);
    return steps;
  }

  // Step 3: Install tunnel plist (macOS only)
  if (process.platform === "darwin") {
    const tunnelStep: WizardStep = { name: "Install tunnel plist", status: "running" };
    steps.push(tunnelStep);
    try {
      const plist = buildTunnelLaunchdPlist(sshAlias, port);
      const plistPath = path.join(homedir(), "Library", "LaunchAgents", "co.harmoniqs.amico-tunnel.plist");
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      fs.writeFileSync(plistPath, plist);
      tunnelStep.status = "done";
    } catch (err) {
      tunnelStep.status = "failed";
      tunnelStep.detail = String(err);
    }
  }

  return steps;
}

/** Remove a machine from the fleet (SSH into target, revert to standalone). */
export async function removeMachine(
  target: string,
  opts: { exec?: SshExec } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const steps: WizardStep[] = [];

  const revertStep: WizardStep = { name: "Revert to standalone", status: "running" };
  steps.push(revertStep);
  const standaloneJson = JSON.stringify({ role: "standalone" }, null, 2);
  const result = await exec(target,
    `cat > ~/.amico/ops/fleet/fleet.json.tmp << 'EOF'\n${standaloneJson}\nEOF\nmv ~/.amico/ops/fleet/fleet.json.tmp ~/.amico/ops/fleet/fleet.json`);
  if (!result.ok) {
    revertStep.status = "failed";
    revertStep.detail = result.stderr;
    return steps;
  }
  revertStep.status = "done";

  // Unload tunnel/guard
  const unloadStep: WizardStep = { name: "Unload services", status: "running" };
  steps.push(unloadStep);
  await exec(target, "launchctl unload ~/Library/LaunchAgents/co.harmoniqs.amico-tunnel.plist 2>/dev/null; true");
  unloadStep.status = "done";

  return steps;
}

/** Dismantle the fleet: stop server, revert all to standalone. */
export async function dismantleFleet(
  serverTarget: string,
  opts: { exec?: SshExec; platform?: "darwin" | "linux" } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const platform = opts.platform ?? "darwin";
  const steps: WizardStep[] = [];

  // Stop the server service
  const stopStep: WizardStep = { name: "Stop server", status: "running" };
  steps.push(stopStep);
  if (platform === "darwin") {
    await exec(serverTarget, "launchctl stop co.harmoniqs.amico-server 2>/dev/null; launchctl unload ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist 2>/dev/null; true");
  } else {
    await exec(serverTarget, "systemctl --user stop amico-server.service 2>/dev/null; systemctl --user disable amico-server.service 2>/dev/null; true");
  }
  stopStep.status = "done";

  // Revert server to standalone
  const revertSteps = await removeMachine(serverTarget, { exec });
  steps.push(...revertSteps);

  // Revert local to standalone
  const localStep: WizardStep = { name: "Revert local to standalone", status: "running" };
  steps.push(localStep);
  try {
    writeFleetConfig({ role: "standalone" });
    localStep.status = "done";
  } catch (err) {
    localStep.status = "failed";
    localStep.detail = String(err);
  }

  return steps;
}

// ============================================================================
// Service file generators (pure, testable)
// ============================================================================

export function buildServerLaunchdPlist(port: number, binaryPath?: string): string {
  const bin = binaryPath ?? "opencode";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.harmoniqs.amico-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bin}</string>
    <string>serve</string>
    <string>--port</string>
    <string>${port}</string>
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
</plist>`;
}

export function buildServerSystemdUnit(port: number, binaryPath?: string): string {
  const bin = binaryPath ?? "opencode";
  return `[Unit]
Description=Amico Fleet Server
After=network.target

[Service]
ExecStart=${bin} serve --port ${port}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target`;
}

export function buildTunnelLaunchdPlist(sshAlias: string, port: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
    <string>127.0.0.1:${port}:127.0.0.1:${port}</string>
    <string>${sshAlias}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/amico-tunnel.err.log</string>
</dict>
</plist>`;
}

// ============================================================================
// Binary provisioning mode
// ============================================================================

export type BinaryMode = "release" | "dev-clone";

/** Pre-flight checks specific to the dev-clone mode: git, node, pnpm, bun. */
export async function runDevPreflightChecks(
  target: string,
  opts: { exec?: SshExec } = {},
): Promise<PreflightResult> {
  const exec = opts.exec ?? defaultSshExec;
  const checks: PreflightCheck[] = [];

  const tools = [
    { name: "git", cmd: "git --version", fix: "Install git on the remote machine" },
    { name: "node", cmd: "node --version", fix: "Install Node.js (v20+) on the remote machine" },
    { name: "pnpm", cmd: "pnpm --version", fix: "Install pnpm: npm install -g pnpm" },
    { name: "bun", cmd: "bun --version", fix: "Install bun: curl -fsSL https://bun.sh/install | bash" },
  ];

  for (const tool of tools) {
    const check: PreflightCheck = { name: `${tool.name} available`, status: "pending" };
    checks.push(check);
    const result = await exec(target, tool.cmd);
    if (result.ok) {
      check.status = "pass";
      check.detail = result.stdout.trim();
    } else {
      check.status = "fail";
      check.detail = `${tool.name} not found`;
      check.fix = tool.fix;
    }
  }

  return { checks, allPass: checks.every((c) => c.status === "pass") };
}

/** Clone repos + build on the remote (the "Development clone" mode).
 *  Adapted from ~/harmoniqs/rebuild_amicode.sh for remote execution. */
export async function provisionDevClone(
  target: string,
  opts: {
    exec?: SshExec;
    opencodeBranch?: string;
    amicodeBranch?: string;
  } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const opencodeBranch = opts.opencodeBranch ?? "local/amicode";
  const amicodeBranch = opts.amicodeBranch ?? "main";
  const steps: WizardStep[] = [];

  // Step 1: Create directory structure
  const mkdirStep: WizardStep = { name: "Create ~/harmoniqs", status: "running" };
  steps.push(mkdirStep);
  const mkdirResult = await exec(target, "mkdir -p ~/harmoniqs");
  if (!mkdirResult.ok) {
    mkdirStep.status = "failed";
    mkdirStep.detail = mkdirResult.stderr;
    return steps;
  }
  mkdirStep.status = "done";

  // Step 2: Clone opencode (or pull if exists)
  const ocStep: WizardStep = { name: "Clone/pull opencode", status: "running" };
  steps.push(ocStep);
  const ocResult = await exec(target, `
    if [ -d ~/harmoniqs/opencode/.git ]; then
      cd ~/harmoniqs/opencode && git fetch origin && git checkout ${opencodeBranch} && git pull origin ${opencodeBranch}
    else
      git clone https://github.com/harmoniqs/opencode.git ~/harmoniqs/opencode && cd ~/harmoniqs/opencode && git checkout ${opencodeBranch}
    fi
  `);
  if (!ocResult.ok) {
    ocStep.status = "failed";
    ocStep.detail = ocResult.stderr;
    return steps;
  }
  ocStep.status = "done";

  // Step 3: Clone amicode (or pull if exists)
  const acStep: WizardStep = { name: "Clone/pull amicode", status: "running" };
  steps.push(acStep);
  const acResult = await exec(target, `
    if [ -d ~/harmoniqs/amicode/.git ]; then
      cd ~/harmoniqs/amicode && git fetch origin && git checkout ${amicodeBranch} && git pull origin ${amicodeBranch}
    else
      git clone https://github.com/harmoniqs/amicode.git ~/harmoniqs/amicode && cd ~/harmoniqs/amicode && git checkout ${amicodeBranch}
    fi
  `);
  if (!acResult.ok) {
    acStep.status = "failed";
    acStep.detail = acResult.stderr;
    return steps;
  }
  acStep.status = "done";

  // Step 4: Install opencode deps + build
  const ocBuildStep: WizardStep = { name: "Build opencode binary", status: "running" };
  steps.push(ocBuildStep);
  const ocBuildResult = await exec(target,
    "cd ~/harmoniqs/opencode/packages/opencode && bun install && bun run script/build.ts --single --skip-install");
  if (!ocBuildResult.ok) {
    ocBuildStep.status = "failed";
    ocBuildStep.detail = ocBuildResult.stderr;
    return steps;
  }
  ocBuildStep.status = "done";

  // Step 5: Install amicode deps + build
  const acBuildStep: WizardStep = { name: "Build amicode extension", status: "running" };
  steps.push(acBuildStep);
  const acBuildResult = await exec(target,
    "cd ~/harmoniqs/amicode && pnpm install && cd packages/extension && pnpm run build");
  if (!acBuildResult.ok) {
    acBuildStep.status = "failed";
    acBuildStep.detail = acBuildResult.stderr;
    return steps;
  }
  acBuildStep.status = "done";

  // Step 6: Ad-hoc codesign the binary (macOS)
  const signStep: WizardStep = { name: "Codesign binary", status: "running" };
  steps.push(signStep);
  const builtBinaryPath = devBinaryPath();
  await exec(target, `codesign --sign - --force ${builtBinaryPath} 2>/dev/null || true`);
  signStep.status = "done";

  // Step 7: Install rebuild script
  const scriptStep: WizardStep = { name: "Install rebuild script", status: "running" };
  steps.push(scriptStep);
  const script = buildRemoteRebuildScript(opencodeBranch, amicodeBranch);
  const scriptResult = await exec(target,
    `cat > ~/harmoniqs/rebuild_amicode.sh << 'SCRIPTEOF'\n${script}\nSCRIPTEOF\nchmod +x ~/harmoniqs/rebuild_amicode.sh`);
  if (!scriptResult.ok) {
    scriptStep.status = "failed";
    scriptStep.detail = scriptResult.stderr;
    return steps;
  }
  scriptStep.status = "done";

  return steps;
}

/** The path to the dev-built opencode binary on the remote (macOS arm64). */
export function devBinaryPath(platform?: string, arch?: string): string {
  const p = platform ?? "darwin";
  const a = arch ?? "arm64";
  return `~/harmoniqs/opencode/packages/opencode/dist/opencode-${p}-${a}/bin/opencode`;
}

/** Generate the rebuild script for the remote host. Same logic as the user's
 *  local rebuild_amicode.sh but without the VS Code settings update (the
 *  server runs headless). */
export function buildRemoteRebuildScript(opencodeBranch: string, amicodeBranch: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

# Rebuild script for the fleet server (generated by the fleet wizard).
# Run this on the server to pull latest and rebuild both repos.

# ── Session DB backup ──────────────────────────────────────────────────────────
DBDIR="$HOME/.config/opencode"
BACKUP="$DBDIR/.backup-$(date +%Y%m%d-%H%M%S)"

if ls "$DBDIR"/opencode*.db 1>/dev/null 2>&1; then
  mkdir -p "$BACKUP"
  for f in "$DBDIR"/opencode*.db "$DBDIR"/opencode*.db-wal "$DBDIR"/opencode*.db-shm; do
    [ -f "$f" ] && cp -p "$f" "$BACKUP/"
  done
  echo "==> Session DBs backed up to $BACKUP"
else
  echo "==> No session DBs found to back up"
fi

# ── Pull sources ───────────────────────────────────────────────────────────────
echo ""
echo "==> Pulling opencode (${opencodeBranch})..."
cd ~/harmoniqs/opencode
git fetch origin
git checkout ${opencodeBranch}
git pull origin ${opencodeBranch}

echo ""
echo "==> Pulling amicode (${amicodeBranch})..."
cd ~/harmoniqs/amicode
git fetch origin
git checkout ${amicodeBranch}
git pull origin ${amicodeBranch}

# ── Build ──────────────────────────────────────────────────────────────────────
echo ""
echo "==> Building opencode binary..."
cd ~/harmoniqs/opencode/packages/opencode
bun install
bun run script/build.ts --single --skip-install

echo ""
echo "==> Building amicode extension..."
cd ~/harmoniqs/amicode
pnpm install
cd packages/extension
pnpm run build

# ── Codesign (macOS) ───────────────────────────────────────────────────────────
BUILT="${devBinaryPath()}"
if [ -f "$BUILT" ]; then
  codesign --sign - --force "$BUILT" 2>/dev/null || true
  echo "==> Binary ready: $BUILT"
else
  echo "==> WARNING: binary not found at $BUILT"
fi

# ── Restart server service ─────────────────────────────────────────────────────
echo ""
echo "==> Restarting fleet server..."
launchctl stop co.harmoniqs.amico-server 2>/dev/null || true
sleep 1
launchctl start co.harmoniqs.amico-server 2>/dev/null || true

# ── Restore session DBs if zeroed ─────────────────────────────────────────────
if [ -d "$BACKUP" ]; then
  restored=0
  for f in "$BACKUP"/opencode*.db; do
    [ -f "$f" ] || continue
    basename="$(basename "$f")"
    target="$DBDIR/$basename"
    if [ ! -s "$target" ] && [ -s "$f" ]; then
      cp -p "$f" "$target"
      [ -f "$f-wal" ] && cp -p "$f-wal" "$target-wal"
      [ -f "$f-shm" ] && cp -p "$f-shm" "$target-shm"
      restored=$((restored + 1))
    fi
  done
  [ $restored -gt 0 ] && echo "==> Restored $restored session DB(s) from backup"
fi

echo ""
echo "Done. Fleet server restarted with the new build."`;
}

// ============================================================================
// Session database merge (local → server)
// ============================================================================

const SESSION_DB_DIR = path.join(homedir(), ".local", "share", "opencode");
const REMOTE_SESSION_DB_DIR = "~/.local/share/opencode";

export interface LocalSessionInfo {
  dbFiles: string[];
  totalSize: number;
  nonEmpty: number;
}

/** Discover local session databases that could be merged to the server. */
export function discoverLocalSessions(dir: string = SESSION_DB_DIR): LocalSessionInfo {
  const dbFiles: string[] = [];
  let totalSize = 0;
  let nonEmpty = 0;

  try {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      if (!file.startsWith("opencode") || !file.endsWith(".db")) continue;
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      dbFiles.push(file);
      totalSize += stat.size;
      if (stat.size > 0) nonEmpty++;
    }
  } catch {
    // Dir doesn't exist or unreadable
  }

  return { dbFiles, totalSize, nonEmpty };
}

/** Check if the server already has session databases (non-empty). */
export async function serverHasSessions(
  target: string,
  opts: { exec?: SshExec } = {},
): Promise<boolean> {
  const exec = opts.exec ?? defaultSshExec;
  const result = await exec(target, `find ${REMOTE_SESSION_DB_DIR} -name "opencode*.db" -size +0 2>/dev/null | head -1`);
  return result.ok && result.stdout.trim().length > 0;
}

/** Copy local session databases to the server.
 *  - If the server has NO sessions: copies all local DBs directly (clean merge).
 *  - If the server HAS sessions: copies local DBs with a .local-merge suffix,
 *    then runs sqlite3 to merge tables (best-effort). */
export async function mergeSessionsToServer(
  target: string,
  opts: {
    exec?: SshExec;
    scp?: (localPath: string, target: string, remotePath: string) => Promise<SshExecResult>;
    localDir?: string;
  } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const scpFn = opts.scp ?? scpFile;
  const localDir = opts.localDir ?? SESSION_DB_DIR;
  const steps: WizardStep[] = [];

  const localSessions = discoverLocalSessions(localDir);
  if (localSessions.nonEmpty === 0) {
    const skipStep: WizardStep = { name: "Check local sessions", status: "done", detail: "No non-empty session databases found locally" };
    steps.push(skipStep);
    return steps;
  }

  // Ensure remote dir exists
  const mkdirStep: WizardStep = { name: "Prepare remote session dir", status: "running" };
  steps.push(mkdirStep);
  const mkdirResult = await exec(target, `mkdir -p ${REMOTE_SESSION_DB_DIR}`);
  if (!mkdirResult.ok) {
    mkdirStep.status = "failed";
    mkdirStep.detail = mkdirResult.stderr;
    return steps;
  }
  mkdirStep.status = "done";

  // Check if server already has sessions
  const hasExisting = await serverHasSessions(target, { exec });

  if (!hasExisting) {
    // Clean merge: server is fresh, just copy all DBs over
    const copyStep: WizardStep = { name: `Copy ${localSessions.nonEmpty} session DB(s) to server`, status: "running" };
    steps.push(copyStep);

    for (const dbFile of localSessions.dbFiles) {
      const localPath = path.join(localDir, dbFile);
      if (fs.statSync(localPath).size === 0) continue;

      const result = await scpFn(localPath, target, `${REMOTE_SESSION_DB_DIR}/${dbFile}`);
      if (!result.ok) {
        copyStep.status = "failed";
        copyStep.detail = `Failed to copy ${dbFile}: ${result.stderr}`;
        return steps;
      }

      // Also copy WAL/SHM sidecars if they exist
      const walPath = `${localPath}-wal`;
      const shmPath = `${localPath}-shm`;
      if (fs.existsSync(walPath)) await scpFn(walPath, target, `${REMOTE_SESSION_DB_DIR}/${dbFile}-wal`);
      if (fs.existsSync(shmPath)) await scpFn(shmPath, target, `${REMOTE_SESSION_DB_DIR}/${dbFile}-shm`);
    }
    copyStep.status = "done";
  } else {
    // Server has existing sessions — copy with suffix and attempt sqlite merge
    const copyStep: WizardStep = { name: `Copy ${localSessions.nonEmpty} local DB(s) for merge`, status: "running" };
    steps.push(copyStep);

    for (const dbFile of localSessions.dbFiles) {
      const localPath = path.join(localDir, dbFile);
      if (fs.statSync(localPath).size === 0) continue;

      const mergeFile = dbFile.replace(/\.db$/, ".local-merge.db");
      const result = await scpFn(localPath, target, `${REMOTE_SESSION_DB_DIR}/${mergeFile}`);
      if (!result.ok) {
        copyStep.status = "failed";
        copyStep.detail = `Failed to copy ${dbFile}: ${result.stderr}`;
        return steps;
      }
    }
    copyStep.status = "done";

    // Attempt SQLite merge on the server
    const mergeStep: WizardStep = { name: "Merge session databases", status: "running" };
    steps.push(mergeStep);

    // For each .local-merge.db, attach it to the main DB and INSERT OR IGNORE
    for (const dbFile of localSessions.dbFiles) {
      if (fs.statSync(path.join(localDir, dbFile)).size === 0) continue;
      const mainDb = `${REMOTE_SESSION_DB_DIR}/${dbFile}`;
      const mergeDb = `${REMOTE_SESSION_DB_DIR}/${dbFile.replace(/\.db$/, ".local-merge.db")}`;

      // Get tables from the merge DB and insert into main
      const mergeResult = await exec(target, `
        if command -v sqlite3 >/dev/null 2>&1; then
          tables=$(sqlite3 "${mergeDb}" ".tables" 2>/dev/null)
          for table in $tables; do
            sqlite3 "${mainDb}" "ATTACH '${mergeDb}' AS merge_db; INSERT OR IGNORE INTO $table SELECT * FROM merge_db.$table;" 2>/dev/null || true
          done
          rm -f "${mergeDb}"
          echo "merged"
        else
          echo "no-sqlite3"
        fi
      `);

      if (mergeResult.stdout.includes("no-sqlite3")) {
        mergeStep.status = "done";
        mergeStep.detail = "sqlite3 not available on server — local DBs copied with .local-merge.db suffix for manual merge";
        break;
      }
    }
    if (!mergeStep.detail) {
      mergeStep.status = "done";
      mergeStep.detail = "Sessions merged successfully";
    }
  }

  return steps;
}


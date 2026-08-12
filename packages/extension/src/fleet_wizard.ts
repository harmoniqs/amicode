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
  } = {},
): Promise<WizardStep[]> {
  const exec = opts.exec ?? defaultSshExec;
  const port = opts.port ?? 4096;
  const token = opts.token ?? generateFleetToken();
  const platform = opts.platform ?? "darwin";
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
    const plist = buildServerLaunchdPlist(port);
    const svcResult = await exec(target,
      `mkdir -p ~/Library/LaunchAgents && cat > ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist.tmp << 'PLISTEOF'\n${plist}\nPLISTEOF\nmv ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist.tmp ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist && launchctl load ~/Library/LaunchAgents/co.harmoniqs.amico-server.plist 2>/dev/null; launchctl start co.harmoniqs.amico-server`);
    if (!svcResult.ok) {
      serviceStep.status = "failed";
      serviceStep.detail = svcResult.stderr;
      return steps;
    }
  } else {
    // systemd unit
    const unit = buildServerSystemdUnit(port);
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

export function buildServerLaunchdPlist(port: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.harmoniqs.amico-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>opencode</string>
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

export function buildServerSystemdUnit(port: number): string {
  return `[Unit]
Description=Amico Fleet Server
After=network.target

[Service]
ExecStart=/usr/bin/env opencode serve --port ${port}
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

// Fleet Host Settings — read/write canonical server configuration over SSH
// (or locally when this machine IS the server). Settings: DB path, port,
// binary path, log directory. Changes that need a restart show an indicator.
//
// Part of #355 (Fleet Panel: remote host settings).

import { readFleetConfig, getFleetRole } from "./fleet_fallback";
import type { SshExec } from "./fleet_ssh";
import { defaultSshExec } from "./fleet_ssh";

export interface HostSettings {
  dbPath: string;
  port: number;
  binaryPath: string;
  logDir: string;
}

/** Settings that require a server restart when changed. */
export const RESTART_REQUIRED_SETTINGS: (keyof HostSettings)[] = ["dbPath", "port", "binaryPath"];

/** Determine which settings would require a restart if changed. */
export function settingsNeedingRestart(
  current: HostSettings,
  updated: HostSettings,
): (keyof HostSettings)[] {
  return RESTART_REQUIRED_SETTINGS.filter((k) => current[k] !== updated[k]);
}

/** Validate host settings. Returns array of error messages (empty = valid). */
export function validateHostSettings(settings: Partial<HostSettings>): string[] {
  const errors: string[] = [];
  if (settings.port !== undefined) {
    if (!Number.isInteger(settings.port) || settings.port < 1024 || settings.port > 65535) {
      errors.push("Port must be an integer between 1024 and 65535");
    }
  }
  if (settings.dbPath !== undefined && !settings.dbPath.startsWith("/")) {
    errors.push("Database path must be absolute");
  }
  if (settings.binaryPath !== undefined && !settings.binaryPath.startsWith("/")) {
    errors.push("Binary path must be absolute");
  }
  if (settings.logDir !== undefined && !settings.logDir.startsWith("/")) {
    errors.push("Log directory must be absolute");
  }
  return errors;
}

/** The remote config file path on the canonical server. */
const REMOTE_CONFIG_PATH = "~/.amico/ops/fleet/server_config.json";

/** Read host settings from the canonical server.
 *  - If role=server (this machine): reads locally.
 *  - If role=client: reads over SSH. */
export async function readHostSettings(opts: {
  exec?: SshExec;
  localRead?: (path: string) => string;
} = {}): Promise<HostSettings | null> {
  const role = getFleetRole();
  const config = readFleetConfig();

  if (role === "standalone") return null;

  if (role === "server") {
    // Read locally
    const localRead = opts.localRead ?? ((p: string) => {
      const fs = require("node:fs");
      return fs.readFileSync(p.replace("~", require("node:os").homedir()), "utf8");
    });
    try {
      const raw = localRead(REMOTE_CONFIG_PATH);
      return parseHostSettings(raw);
    } catch {
      return defaultHostSettings(config?.canonical?.port ?? 4096);
    }
  }

  // Client: read over SSH
  const exec = opts.exec ?? defaultSshExec;
  const target = config?.canonical?.sshAlias ?? config?.canonical?.host ?? "";
  if (!target) return null;

  const result = await exec(target, `cat ${REMOTE_CONFIG_PATH} 2>/dev/null`);
  if (result.ok && result.stdout) {
    return parseHostSettings(result.stdout);
  }
  return defaultHostSettings(config?.canonical?.port ?? 4096);
}

/** Write host settings to the canonical server.
 *  - If role=server: writes locally.
 *  - If role=client: writes over SSH. */
export async function writeHostSettings(
  settings: HostSettings,
  opts: { exec?: SshExec; localWrite?: (path: string, content: string) => void } = {},
): Promise<{ ok: boolean; error?: string }> {
  const errors = validateHostSettings(settings);
  if (errors.length > 0) return { ok: false, error: errors[0] };

  const role = getFleetRole();
  const config = readFleetConfig();
  const json = JSON.stringify(settings, null, 2);

  if (role === "server") {
    const localWrite = opts.localWrite ?? ((p: string, content: string) => {
      const fs = require("node:fs");
      const path = require("node:path");
      const resolved = p.replace("~", require("node:os").homedir());
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.tmp`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, resolved);
    });
    try {
      localWrite(REMOTE_CONFIG_PATH, json);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Client: write over SSH
  const exec = opts.exec ?? defaultSshExec;
  const target = config?.canonical?.sshAlias ?? config?.canonical?.host ?? "";
  if (!target) return { ok: false, error: "No canonical server configured" };

  const result = await exec(target,
    `mkdir -p ~/.amico/ops/fleet && cat > ${REMOTE_CONFIG_PATH}.tmp << 'CFGEOF'\n${json}\nCFGEOF\nmv ${REMOTE_CONFIG_PATH}.tmp ${REMOTE_CONFIG_PATH}`);
  if (!result.ok) return { ok: false, error: result.stderr || "SSH write failed" };
  return { ok: true };
}

/** Restart the canonical server service (over SSH for clients, locally for servers). */
export async function restartServer(opts: {
  exec?: SshExec;
  platform?: "darwin" | "linux";
} = {}): Promise<{ ok: boolean; error?: string }> {
  const role = getFleetRole();
  const config = readFleetConfig();
  const platform = opts.platform ?? (process.platform === "darwin" ? "darwin" : "linux");
  const exec = opts.exec ?? defaultSshExec;

  const cmd = platform === "darwin"
    ? "launchctl stop co.harmoniqs.amico-server 2>/dev/null; sleep 1; launchctl start co.harmoniqs.amico-server"
    : "systemctl --user restart amico-server.service";

  if (role === "server") {
    // Execute locally
    const cp = require("node:child_process");
    try {
      cp.execSync(cmd, { timeout: 10000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  // Client: restart over SSH
  const target = config?.canonical?.sshAlias ?? config?.canonical?.host ?? "";
  if (!target) return { ok: false, error: "No canonical server configured" };

  const result = await exec(target, cmd);
  if (!result.ok) return { ok: false, error: result.stderr || "Restart failed" };
  return { ok: true };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseHostSettings(json: string): HostSettings | null {
  try {
    const data = JSON.parse(json);
    return {
      dbPath: String(data.dbPath ?? ""),
      port: Number(data.port ?? 4096),
      binaryPath: String(data.binaryPath ?? ""),
      logDir: String(data.logDir ?? ""),
    };
  } catch {
    return null;
  }
}

function defaultHostSettings(port: number): HostSettings {
  return {
    dbPath: "~/.amico/ops/sessions.db",
    port,
    binaryPath: "/usr/local/bin/opencode",
    logDir: "/tmp/amico-server-logs",
  };
}

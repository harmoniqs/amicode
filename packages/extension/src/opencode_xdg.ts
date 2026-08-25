import os from "node:os";
import path from "node:path";

/**
 * Resolve the opencode config directory following XDG conventions.
 * Returns `$XDG_CONFIG_HOME/opencode` if the env var is set,
 * otherwise `~/.config/opencode`.
 */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg || path.join(os.homedir(), ".config");
  return path.join(base, "opencode");
}

/**
 * Resolve the opencode data directory following XDG conventions.
 * Returns `$XDG_DATA_HOME/opencode` if the env var is set,
 * otherwise `~/.local/share/opencode`.
 */
export function opencodeDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg || path.join(os.homedir(), ".local", "share");
  return path.join(base, "opencode");
}

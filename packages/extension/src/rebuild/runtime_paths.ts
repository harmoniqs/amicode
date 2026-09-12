/**
 * Runtime path self-discovery — #1022
 *
 * The extension discovers its own binary and asset paths at runtime from
 * context.extensionPath, eliminating the need to write settings after each
 * rebuild. Override settings remain first-class (fleet guard, development).
 *
 * Resolution order:
 * - Binary: configOverride > self-discovered (vendor/opencode/<platform>/opencode)
 * - App bundle: configOverride > self-discovered (dist/app)
 * - Developer mode: dedicated setting > marker file > false
 */

import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

// ── Types ──

export interface RuntimePaths {
  binaryPath: string;
  binarySource: "config-override" | "self-discovered";
  appBundlePath: string;
  appBundleSource: "config-override" | "self-discovered";
  extensionPath: string;
  platformKey: string;
}

export interface PathValidation {
  exists: boolean;
  executable?: boolean;
  diagnostic?: string;
}

// ── resolveRuntimePaths ──

/**
 * Resolve the opencode binary and app bundle paths.
 * Uses config overrides when set, otherwise self-discovers from extensionPath.
 */
export function resolveRuntimePaths(opts: {
  extensionPath: string;
  platform: string;
  arch: string;
  configBinary: string;
  configAppBundleDir: string;
}): RuntimePaths {
  const { extensionPath, platform, arch, configBinary, configAppBundleDir } = opts;
  const platformKey = `${platform}-${arch}`;

  // Binary: config override → self-discovered
  const binaryOverride = (configBinary ?? "").trim();
  const binaryPath = binaryOverride !== ""
    ? binaryOverride
    : join(extensionPath, "vendor", "opencode", platformKey, "opencode");
  const binarySource: "config-override" | "self-discovered" =
    binaryOverride !== "" ? "config-override" : "self-discovered";

  // App bundle: config override → self-discovered (dist/app)
  const appOverride = (configAppBundleDir ?? "").trim();
  const appBundlePath = appOverride !== ""
    ? appOverride
    : join(extensionPath, "dist", "app");
  const appBundleSource: "config-override" | "self-discovered" =
    appOverride !== "" ? "config-override" : "self-discovered";

  return {
    binaryPath,
    binarySource,
    appBundlePath,
    appBundleSource,
    extensionPath,
    platformKey,
  };
}

// ── detectDeveloperMode ──

/**
 * Detect developer mode from a dedicated setting or marker file.
 * Replaces the devAssetRoot-as-signal pattern.
 */
export function detectDeveloperMode(opts: {
  developerModeSetting?: boolean;
  markerFileExists?: boolean;
}): boolean {
  if (opts.developerModeSetting) return true;
  if (opts.markerFileExists) return true;
  return false;
}

// ── validateOverride ──

/**
 * Validate a config override path (binary or app bundle).
 * Returns whether the path exists/is executable and a diagnostic if not.
 */
export function validateOverride(path: string): PathValidation {
  if (!path || path.trim() === "") {
    return { exists: false, diagnostic: "Path is empty" };
  }

  try {
    const stat = statSync(path);
    if (stat.isFile()) {
      try {
        accessSync(path, constants.X_OK);
        return { exists: true, executable: true };
      } catch {
        return { exists: true, executable: false, diagnostic: `${path} exists but is not executable` };
      }
    }
    if (stat.isDirectory()) {
      return { exists: true };
    }
    return { exists: true };
  } catch {
    return {
      exists: false,
      diagnostic: `The configured path does not exist: \`${path}\`. Clear the setting to use the bundled binary, or update it.`,
    };
  }
}

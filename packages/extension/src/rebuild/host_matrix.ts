/**
 * Supported-host matrix — #1023
 *
 * Platform classification, WSL version detection, and Gatekeeper clearance.
 *
 * Supported hosts:
 * - macOS arm64 (full)
 * - Linux x64/arm64 (full) — includes WSL 2
 * - WSL 2 (linux-x64, full — extension host runs inside WSL)
 *
 * Rejected hosts:
 * - WSL 1 (detected + rejected — no atomic rename on lxfs)
 * - Windows native (zero mutation, routes to WSL guidance)
 * - Intel Mac / darwin-x64 (early rejection)
 */

import { SUPPORTED, unsupportedHostAdvice } from "../opencode_binary";

type ExecFn = (cmd: string, cwd?: string) => Promise<{ ok: boolean; stdout?: string; error?: string }>;

// ── Types ──

export interface HostClassification {
  supported: boolean;
  platformKey: string;
  rejection?: string;
  wslVersion?: 1 | 2 | null;
}

// ── classifyHost ──

/**
 * Classify the current host for rebuild support.
 */
export function classifyHost(
  platform: string = process.platform,
  arch: string = process.arch,
): HostClassification {
  const key = `${platform}-${arch}`;

  if (!(SUPPORTED as readonly string[]).includes(key)) {
    return {
      supported: false,
      platformKey: key,
      rejection: unsupportedHostAdvice(platform, arch),
    };
  }

  return {
    supported: true,
    platformKey: key,
  };
}

// ── detectWSLVersion ──

/**
 * Detect whether the host is running under WSL and which version.
 * Returns 1, 2, or null (not WSL).
 *
 * Detection: read /proc/version. If it contains "Microsoft" or "microsoft",
 * it's WSL. If it also contains "WSL2", it's WSL 2; otherwise WSL 1.
 *
 * WSL 1's lxfs does not support atomic rename across directories — #1021's
 * swap would fail silently. WSL 2 uses a real Linux kernel with ext4.
 */
export async function detectWSLVersion(
  platform: string,
  exec: ExecFn,
): Promise<1 | 2 | null> {
  if (platform !== "linux") return null;

  const result = await exec("cat /proc/version");
  if (!result.ok) return null;

  const version = result.stdout ?? "";
  if (!/microsoft/i.test(version)) return null;

  // WSL 2 has "WSL2" or "microsoft-standard-WSL2" in the version string
  if (/WSL2/i.test(version)) return 2;

  // WSL 1 has "Microsoft" but not "WSL2"
  return 1;
}

// ── gateKeeperClear ──

/**
 * Clear macOS Gatekeeper quarantine flag on the vendored binary.
 * Best-effort: failure is logged but does not block the rebuild.
 *
 * The vendored binary is unsigned — Gatekeeper blocks it on first run.
 * `xattr -d com.apple.quarantine` removes the flag.
 */
export async function gateKeeperClear(
  binaryPath: string,
  exec: ExecFn,
): Promise<void> {
  try {
    await exec(`xattr -d com.apple.quarantine "${binaryPath}"`);
  } catch {
    // Best-effort — Gatekeeper clearance is not critical
  }
}

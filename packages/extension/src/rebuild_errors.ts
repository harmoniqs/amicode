/**
 * Structured rebuild error catalog — #1016
 *
 * Every user-facing rebuild error is a classified entry with:
 * - message: one-line summary (shown prominently)
 * - fix: numbered steps the user can take (rendered as an ordered list)
 * - detail?: raw stderr or diagnostic (shown in a collapsible block)
 *
 * Raw stderr is NEVER the primary message. The rendering layer (#1022)
 * owns the UI; this module owns the classification.
 */

export interface RebuildError {
  readonly code: string;
  readonly message: string;
  readonly fix: readonly string[];
}

export function rebuildError(code: string, message: string, fix: string[]): RebuildError {
  return { code, message, fix };
}

// ── Lock file errors (#1018) ──

export const LOCK_FILE_MISSING = (path: string) =>
  rebuildError("LOCK_MISSING", `opencode.lock.json not found at ${path}`, [
    "Ensure you are pointing at the amicode repo root.",
    "If you just cloned, run `git checkout main` first.",
  ]);

export const LOCK_FILE_MALFORMED = (detail: string) =>
  rebuildError("LOCK_MALFORMED", "opencode.lock.json is malformed or incomplete", [
    "Pull the latest main: `git pull origin main`.",
    `Parse error: ${detail}`,
  ]);

export const LOCK_MISSING_TAG = rebuildError(
  "LOCK_NO_TAG",
  "opencode.lock.json has no release tag — cannot identify the binary to download",
  [
    "Run `pnpm --filter amicode opencode:pin <tag>` to pin a release.",
    "Or pull main to get the latest promoted pin.",
  ],
);

export const LOCK_MISSING_REF = rebuildError(
  "LOCK_NO_REF",
  "opencode.lock.json has no fork commit ref",
  [
    "The lock file must have a 40-character hex `ref` field.",
    "Run `pnpm --filter amicode opencode:pin <tag>` to fix it.",
  ],
);

export const LOCK_MISSING_PLATFORM = (platform: string, available: string[]) =>
  rebuildError(
    "LOCK_NO_PLATFORM",
    `No lock entry for ${platform} (available: ${available.join(", ")})`,
    ["Run `pnpm --filter amicode opencode:pin <tag>` to add this platform."],
  );

// ── Platform errors (#1018, #1023) ──

export const UNSUPPORTED_PLATFORM_WIN32 = rebuildError(
  "UNSUPPORTED_WIN32",
  "Amicode has no native Windows build",
  [
    "Open your project in WSL (Remote — WSL).",
    "Amicode will install and run inside the Linux extension host.",
  ],
);

export const UNSUPPORTED_PLATFORM_INTEL_MAC = rebuildError(
  "UNSUPPORTED_INTEL_MAC",
  "Amicode ships an Apple Silicon build only",
  ["This Mac needs an arm64 processor. Rosetta cannot help; the binary is arm64-native."],
);

export const UNSUPPORTED_PLATFORM_GENERIC = (key: string, supported: string[]) =>
  rebuildError("UNSUPPORTED_PLATFORM", `Amicode has no build for ${key}`, [
    `Supported platforms: ${supported.join(", ")}`,
  ]);

// ── Git errors (#1018) ──

export const GIT_DIRTY_TREE = rebuildError(
  "GIT_DIRTY",
  "Working tree has uncommitted changes",
  ["Commit or stash your local changes before rebuilding from main."],
);

export const GIT_PULL_FAILED = (detail: string) =>
  rebuildError("GIT_PULL_FAILED", "git pull failed", [
    "Check your network connection.",
    "If the branch has diverged, reset: `git fetch origin && git reset --hard origin/main`.",
    `Detail: ${detail}`,
  ]);

export const GIT_NON_FF = rebuildError(
  "GIT_NON_FF",
  "Cannot fast-forward main — the branch has diverged",
  [
    "Reset to origin: `git fetch origin && git reset --hard origin/main`.",
    "Or rebase manually: `git rebase origin/main`.",
  ],
);

// ── Download errors (#1018, #1019) ──

export const DOWNLOAD_HASH_MISMATCH = (asset: string) =>
  rebuildError("HASH_MISMATCH", `Corrupted download or tampered release (${asset})`, [
    "Try again — transient corruption is the most common cause.",
    "If the error persists, report it.",
  ]);

export const RELEASE_DELETED = (tag: string) =>
  rebuildError("RELEASE_DELETED", `The release \`${tag}\` is no longer available`, [
    "This may be a repository issue — contact your team.",
    "Or pull main to get an updated lock file.",
  ]);

export const DOWNLOAD_FAILED = (detail: string) =>
  rebuildError("DOWNLOAD_FAILED", "Binary download failed", [
    "Check your network connection.",
    "If behind a corporate proxy, configure git and curl proxy settings.",
    `Detail: ${detail}`,
  ]);

// ── Build errors (#1018, #1020) ──

export const PNPM_INSTALL_FAILED = (detail: string) =>
  rebuildError("PNPM_INSTALL", "pnpm install failed", [
    "Check your network connection (npm registry access).",
    "Try `pnpm install` manually in the amicode repo.",
    `Detail: ${detail}`,
  ]);

export const EXTENSION_BUILD_FAILED = (detail: string) =>
  rebuildError("BUILD_FAILED", "Extension build failed", [
    "Try `pnpm -r build` manually in the amicode repo.",
    `Detail: ${detail}`,
  ]);

// ── Deployment errors (#1021) ──

export const BACKUP_FAILED = (detail: string) =>
  rebuildError("BACKUP_FAILED", "Could not back up the installed extension", [
    "Check disk space and permissions on the VS Code extensions directory.",
    `Detail: ${detail}`,
  ]);

export const SWAP_FAILED = (detail: string) =>
  rebuildError("SWAP_FAILED", "Atomic swap failed during deployment", [
    "The installed extension may be locked by another process.",
    "Try closing other VS Code windows and retry.",
    `Detail: ${detail}`,
  ]);

export const HEALTH_CHECK_TIMEOUT = rebuildError(
  "HEALTH_TIMEOUT",
  "Post-deployment health check timed out",
  [
    "The new extension may have failed to activate.",
    "Try reloading the window manually: Cmd+Shift+P → Reload Window.",
  ],
);

// ── Provisioning errors (#1020) ──

export const NODE_NOT_FOUND = rebuildError(
  "NODE_MISSING",
  "Node.js >= 20 is required but not found",
  [
    "Install Node.js: https://nodejs.org/",
    "Or use nvm: `nvm install 20`.",
  ],
);

export const GIT_NOT_FOUND = rebuildError(
  "GIT_MISSING",
  "git is required but not found",
  ["Install git: https://git-scm.com/"],
);

export const BUN_PROVISION_FAILED = (detail: string) =>
  rebuildError("BUN_PROVISION", "Failed to provision bun (needed for Local rebuilds only)", [
    "Try installing bun manually: `curl -fsSL https://bun.sh/install | bash`.",
    `Detail: ${detail}`,
  ]);

export const COREPACK_FAILED = (detail: string) =>
  rebuildError("COREPACK_FAILED", "corepack enable failed (pnpm provisioning)", [
    "Try `corepack enable` manually (may need sudo on some systems).",
    "Or install pnpm directly: `npm install -g pnpm@9`.",
    `Detail: ${detail}`,
  ]);

// ── Settings / UI errors (#1022) ──

export const STALE_OVERRIDE = (setting: string, path: string) =>
  rebuildError("STALE_OVERRIDE", `The configured path does not exist: ${path}`, [
    `Clear the \`${setting}\` setting to use the bundled binary.`,
    "Or update it to the correct path.",
  ]);

// ── Legacy errors ──

export const UNKNOWN_ERROR = (detail: string) =>
  rebuildError("UNKNOWN", "An unexpected error occurred during rebuild", [
    "Check the output above for details.",
    `Detail: ${detail}`,
  ]);

/**
 * Classify a raw error string into a structured RebuildError.
 * Used as a fallback when the error doesn't come from a known path.
 */
export function classifyError(raw: string): RebuildError {
  if (raw.includes("SHA256 mismatch")) {
    const asset = raw.match(/for (\S+):/)?.[1] ?? "unknown";
    return DOWNLOAD_HASH_MISMATCH(asset);
  }
  if (raw.includes("404") || raw.includes("no longer available")) {
    const tag = raw.match(/release `([^`]+)`/)?.[1] ?? "unknown";
    return RELEASE_DELETED(tag);
  }
  if (raw.includes("fast-forward")) return GIT_NON_FF;
  if (raw.includes("git pull") || raw.includes("git fetch")) return GIT_PULL_FAILED(raw);
  if (raw.includes("pnpm install")) return PNPM_INSTALL_FAILED(raw);
  if (raw.includes("bun install") || raw.includes("bun run")) return EXTENSION_BUILD_FAILED(raw);
  return UNKNOWN_ERROR(raw);
}

import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

export class OpencodeMissingError extends Error {}

export interface ResolvedBinary {
  path: string;
  source: "config-override" | "vendored";
}

/** Must stay in lockstep with opencode.lock.json's `platforms` — a fetch_opencode
 *  test asserts the two sets are equal, since they live in different files. */
export const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64"] as const;

/**
 * Where Amicode *does* run, for a host where it doesn't. The Marketplace carries a
 * lean vsix per supported target plus a binary-less package for every other target
 * (release.yml) — a missing target is not neutral, VS Code silently resolves such a
 * client down to the newest *universal* version on the listing (0.0.2, published
 * before the platform split) and installs a stale build. Those cover packages land
 * here, so this is the only place that tells the user what to do next.
 */
export function unsupportedHostAdvice(platform: string = process.platform, arch: string = process.arch): string {
  if (platform === "win32") {
    return (
      "Amicode has no native Windows build — it runs in the Linux extension host. " +
      "Open your project in WSL (Remote — WSL) and Amicode will install and run there."
    );
  }
  if (platform === "darwin") {
    return `Amicode ships an Apple Silicon build only — this Mac reports ${arch}. Rosetta cannot help; the vendored binary is arm64-native.`;
  }
  return `Amicode has no build for ${platform}-${arch} (built: ${SUPPORTED.join(", ")}).`;
}

/** Spec §4: config override → vendored → hard error. NO $PATH fallback (Assumption 4 stays dead). */
export function resolveOpencodeBinary(extensionRoot: string, configValue: string): ResolvedBinary {
  const override = (configValue ?? "").trim();
  if (override !== "") return { path: override, source: "config-override" };

  const key = `${process.platform}-${process.arch}`;
  if (!(SUPPORTED as readonly string[]).includes(key)) {
    throw new OpencodeMissingError(`platform ${key} not supported (supported: ${SUPPORTED.join(", ")})`);
  }
  const vendored = join(extensionRoot, "vendor", "opencode", key, "opencode");
  try {
    accessSync(vendored, constants.X_OK);
  } catch {
    throw new OpencodeMissingError(
      `vendored opencode missing at ${vendored} — run \`pnpm --filter amicode fetch:opencode\` (dev) or reinstall the extension`,
    );
  }
  return { path: vendored, source: "vendored" };
}

export type ForkBinaryResolution =
  | { found: true; path: string }
  | { found: false; reason: "not-found" }
  | { found: false; reason: "not-executable"; path: string };

/**
 * Resolve the built opencode binary from a FORK CHECKOUT's dist output —
 * distinct from resolveOpencodeBinary() above, which resolves the VENDORED
 * binary shipped with the extension itself.
 *
 * Used by the Developer Tools dev-tools-update (path validation) and
 * dev-tools-rebuild (post-build codesign) handlers, which used to each
 * carry their own, independently-drifting candidate list (#943):
 * dev-tools-update never checked the platform-suffixed dist directory a
 * real build actually produces, so a genuinely valid repo path was
 * indistinguishable from a typo; dev-tools-rebuild's own list only covered
 * darwin, missing both Linux targets. Both now share this one list,
 * sourced from SUPPORTED.
 *
 * Checks every supported platform's suffixed directory (not just the
 * current host's — the repo root being validated need not have been built
 * on this machine) before falling back to the legacy unsuffixed layout an
 * older build script once produced, and finally treats the input itself as
 * a direct binary path in case the user pointed straight at one instead of
 * a repo root.
 */
export function findForkedOpencodeBinary(repoRoot: string): ForkBinaryResolution {
  const candidates = [
    ...SUPPORTED.map((key) => join(repoRoot, "packages", "opencode", "dist", `opencode-${key}`, "bin", "opencode")),
    join(repoRoot, "packages", "opencode", "dist", "opencode", "bin", "opencode"),
    join(repoRoot, "dist", "opencode", "bin", "opencode"),
    repoRoot, // direct binary path — the field also accepts pointing straight at a binary
  ];

  let notExecutable: string | undefined;
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
      return { found: true, path: candidate };
    } catch {
      notExecutable ??= candidate;
    }
  }
  return notExecutable ? { found: false, reason: "not-executable", path: notExecutable } : { found: false, reason: "not-found" };
}

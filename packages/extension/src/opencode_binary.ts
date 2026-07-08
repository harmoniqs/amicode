import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export class OpencodeMissingError extends Error {}

export interface ResolvedBinary {
  path: string;
  source: "config-override" | "vendored";
}

const SUPPORTED = ["darwin-arm64", "linux-x64"] as const;

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
      `vendored opencode missing at ${vendored} — run \`pnpm --filter amicode-v2 fetch:opencode\` (dev) or reinstall the extension`,
    );
  }
  return { path: vendored, source: "vendored" };
}

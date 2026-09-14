/**
 * Overlay-hash cache (#1178, wiring the #1148 skip guard).
 *
 * The rebuild's binary build + server teardown should run ONLY when the engine
 * overlay tree actually changed. We record the overlay hash the currently
 * deployed binary was built from; the next rebuild compares against it via
 * `shouldSkipBinaryBuild`. An extension-only change (overlay unchanged) then
 * skips both the binary build AND the teardown — the kill-free rebuild.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** Where the last-built overlay hash is recorded. */
export function overlayHashMarkerPath(): string {
  return join(homedir(), ".amico", "ops", "server", "overlay-hash.txt");
}

/** The overlay hash the deployed binary was built from, or null if unknown. */
export function readCachedOverlayHash(filePath?: string): string | null {
  const p = filePath ?? overlayHashMarkerPath();
  try {
    const raw = readFileSync(p, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Record the overlay hash after a successful binary build. */
export function writeCachedOverlayHash(hash: string, filePath?: string): void {
  const p = filePath ?? overlayHashMarkerPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, hash, { encoding: "utf8" });
}

/** Pasqal connector staging (#161, scope note from #159/#169).
 *
 *  The fork's Connections panel resolves the Pasqal validator as
 *  $AMICO_PASQAL_VALIDATOR override → <opsDir>/scripts/pasqal-connector/
 *  pasqal_validate.py (opsDir = $AMICODE_OPS_DIR, else ~/.amico/amicode).
 *  This module stages the DEFAULT path only — the override env is the panel's
 *  concern and is never read or written here.
 *
 *  Semantics: ALWAYS-COPY at every activation. The default staged path is
 *  extension-owned: a user override belongs behind $AMICO_PASQAL_VALIDATOR
 *  (pointing anywhere else), so an unconditional refresh can never clobber
 *  user work — and it keeps the staged script in lockstep with the installed
 *  extension version (overwrite-on-version-change subsumed, no staleness
 *  window, no version bookkeeping for two small files). Failures throw; the
 *  activation caller catches and logs (staging must never kill activation). */
import * as fs from "node:fs";
import * as path from "node:path";
import { amicodeOpsDir } from "./substrate/vault_store";

/** The shipped connector assets (packages/extension/scripts/pasqal-connector,
 *  kept in the vsix by explicit .vscodeignore negations — the β.2 trap). The
 *  tests/ subdir deliberately does NOT ship or stage. */
export const PASQAL_CONNECTOR_FILES = ["pasqal_validate.py", "requirements.txt"] as const;

/** <opsDir>/scripts/pasqal-connector — the panel's default resolution dir. */
export function pasqalConnectorDir(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "scripts", "pasqal-connector");
}

/** Copy the shipped connector assets into the ops dir. Returns what landed
 *  where (for the activation log line). */
export function stagePasqalConnector(
  extensionPath: string,
  opsDir: string = amicodeOpsDir(),
): { dir: string; staged: string[] } {
  const srcDir = path.join(extensionPath, "scripts", "pasqal-connector");
  const dir = pasqalConnectorDir(opsDir);
  fs.mkdirSync(dir, { recursive: true });
  const staged: string[] = [];
  for (const f of PASQAL_CONNECTOR_FILES) {
    const src = path.join(srcDir, f);
    if (!fs.existsSync(src))
      throw new Error(
        `pasqal connector asset missing from the extension: ${src} — packaging dropped it (.vscodeignore)`,
      );
    fs.copyFileSync(src, path.join(dir, f));
    staged.push(f);
  }
  return { dir, staged };
}

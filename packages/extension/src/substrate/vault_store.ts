/** Vault resolution + onboarding-stream readers (spec-20260705-002847 §2, §3
 *  routing). The user-memory section BUILDERS + index readers (KNOWLEDGE /
 *  DEMOS / memory index) moved to the amicode_context plugin's live
 *  stack_state.ts (injected per-prompt); what remains here is what prep-time
 *  code still needs — the personal-vault resolver, PROFILE.md presence (the
 *  onboarding routing predicate), and the onboarding-stream marker. Everything
 *  is read-only and failure-tolerant: a missing vault, file, or stream simply
 *  yields the empty value and the session proceeds unpersonalized. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export function defaultVaultsRoot(): string {
  return path.join(os.homedir(), ".amico", "vaults");
}

/** Ops-side amicode state (queue, lock, onboarding stream, distiller config).
 *  NOT the vault — operational, per charter/19. */
export function amicodeOpsDir(): string {
  return process.env.AMICODE_OPS_DIR ?? path.join(os.homedir(), ".amico", "amicode");
}

export function onboardingDir(opsDir: string = amicodeOpsDir()): string {
  return path.join(opsDir, "onboarding");
}

export function resolvePersonalVault(vaultsRoot: string, override: string): string {
  if (override) return override;
  let entries: string[];
  try {
    entries = fs.readdirSync(vaultsRoot).sort();
  } catch {
    return "";
  }
  for (const name of entries) {
    const marker = path.join(vaultsRoot, name, ".amico-vault.toml");
    try {
      const text = fs.readFileSync(marker, "utf8");
      if (/^\s*kind\s*=\s*"personal"\s*$/m.test(text)) return path.join(vaultsRoot, name);
    } catch {
      continue;
    }
  }
  return "";
}

/** Non-empty PROFILE.md content, or "" (whitespace-only counts as absent — §3). */
export function readProfileMd(vaultDir: string): string {
  try {
    const text = fs.readFileSync(path.join(vaultDir, "amicode", "PROFILE.md"), "utf8");
    return text.trim() === "" ? "" : text;
  } catch {
    return "";
  }
}

/** Second disjunct of the routing predicate (§3): completed marker in the
 *  onboarding stream. Checks both the legacy events.jsonl marker AND the new
 *  file-based marker (a `completed` file in the onboarding dir). */
export function hasOnboardingCompleted(onboardingStreamDir: string): boolean {
  // New marker: the agent writes an empty `completed` file directly.
  if (fs.existsSync(path.join(onboardingStreamDir, "completed"))) return true;
  // Legacy marker: amicode_profile tool appends to events.jsonl.
  let text: string;
  try {
    text = fs.readFileSync(path.join(onboardingStreamDir, "events.jsonl"), "utf8");
  } catch {
    return false;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).entity === "onboarding_completed") return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ─── Devtools restore marker ─────────────────────────────────────────────────
// A temporary file that tells the next activation "this reinstall was triggered
// by the devtools toggle, not a manual user action — skip onboarding." The
// marker is consumed (deleted) on read so it only suppresses once.

const DEVTOOLS_RESTORE_MARKER = ".devtools-restore";

/** Write the devtools restore marker. Called by toggle-OFF before uninstall. */
export function writeDevtoolsRestoreMarker(opsDir: string = amicodeOpsDir()): void {
  fs.mkdirSync(opsDir, { recursive: true });
  fs.writeFileSync(path.join(opsDir, DEVTOOLS_RESTORE_MARKER), String(Date.now()));
}

/** Check and consume the devtools restore marker. Returns true if it existed
 *  (meaning this activation follows a toggle-OFF reinstall, not a fresh install). */
export function consumeDevtoolsRestoreMarker(opsDir: string = amicodeOpsDir()): boolean {
  const markerPath = path.join(opsDir, DEVTOOLS_RESTORE_MARKER);
  try {
    fs.unlinkSync(markerPath);
    return true;
  } catch {
    return false;
  }
}

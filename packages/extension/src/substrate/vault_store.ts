/** Vault resolution + user-memory readers (spec-20260705-002847 §2, §3 routing).
 *
 *  The personal vault is the first mount under the vaults root whose
 *  `.amico-vault.toml` marker declares `kind = "personal"`. Everything here is
 *  read-only and failure-tolerant: a missing vault, file, or stream simply
 *  yields the empty value and the session proceeds unpersonalized. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const KNOWLEDGE_LINE_CAP = 50;

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

/** List-item lines from an amicode index file, capped. */
function readIndexLines(vaultDir: string, file: string, cap: number): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(vaultDir, "amicode", file), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, cap);
}

/** KNOWLEDGE.md list-item lines, capped (§2.3). */
export function readKnowledgeLines(vaultDir: string, cap: number = KNOWLEDGE_LINE_CAP): string[] {
  return readIndexLines(vaultDir, "KNOWLEDGE.md", cap);
}

/** DEMOS.md list-item lines (L1 §3) — separate index so reference demos never
 *  age against KNOWLEDGE.md's problem cap. Capped tighter (splice budget ≤~2KB). */
export function readDemoLines(vaultDir: string, cap = 30): string[] {
  return readIndexLines(vaultDir, "DEMOS.md", cap);
}

/** Second disjunct of the routing predicate (§3): completed marker in the
 *  onboarding stream. Malformed lines are skipped. */
export function hasOnboardingCompleted(onboardingStreamDir: string): boolean {
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

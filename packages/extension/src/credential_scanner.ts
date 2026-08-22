// Credential Scanner — Auto-Import Credentials (#449)
//
// Scans flat-file credential sources in priority order, deduplicates by provider,
// and returns detected credentials. Keys NEVER leave the extension host process.
//
// Source priority (first hit per provider wins):
//   1. ~/.local/share/opencode/account.json  (v2)
//   2. ~/.local/share/opencode/auth.json     (v1)
//   3. process.env
//   4. Shell RC files (~/.zshrc, ~/.bashrc, ~/.zprofile, ~/.bash_profile)
//   5. ~/.claude/.credentials.json           (type: "api" only)

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { PROVIDER_MODELS } from "./onboarding_panel";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DetectedCredential {
  provider: string;
  key: string;
  source: string;
}

export interface ScanOptions {
  accountJsonPath: string;
  authJsonPath: string;
  env: Record<string, string | undefined>;
  rcPaths: string[];
  claudeCredPath: string;
}

export interface ScanResult {
  credentials: DetectedCredential[];
}

/** Webview-safe representation — NO key material. */
export interface SafeCredential {
  provider: string;
  source: string;
  model: string;
}

// ─── Env var → provider mapping ──────────────────────────────────────────────

const ENV_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GOOGLE_API_KEY: "google",
  OPENROUTER_API_KEY: "openrouter",
  OPENCODE_API_KEY: "opencode",
};

/** Env vars to scan in process.env and shell RC files. */
const SCANNABLE_ENV_VARS = Object.keys(ENV_TO_PROVIDER);

// ─── Provider ID normalization ───────────────────────────────────────────────

const PROVIDER_ALIASES: Record<string, string> = {
  "opencode-go": "opencode",
};

function normalizeProviderId(raw: string): string {
  return PROVIDER_ALIASES[raw] ?? raw;
}

// ─── Provider → env var (for config writing) ─────────────────────────────────

const PROVIDER_ENV_VAR: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_API_KEY",
  opencode: "OPENCODE_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// ─── Scanner ─────────────────────────────────────────────────────────────────

/** Default scan options using standard paths. */
export function defaultScanOptions(): ScanOptions {
  const home = os.homedir();
  const dataDir = path.join(home, ".local", "share", "opencode");
  return {
    accountJsonPath: path.join(dataDir, "account.json"),
    authJsonPath: path.join(dataDir, "auth.json"),
    env: process.env as Record<string, string | undefined>,
    rcPaths: [
      path.join(home, ".zshrc"),
      path.join(home, ".bashrc"),
      path.join(home, ".zprofile"),
      path.join(home, ".bash_profile"),
    ],
    claudeCredPath: path.join(home, ".claude", ".credentials.json"),
  };
}

/**
 * Scan for existing API credentials across all configured sources.
 * Sources are checked in priority order; first hit per provider wins.
 * Unreadable or malformed sources are skipped silently.
 */
export async function scanCredentials(options: ScanOptions): Promise<ScanResult> {
  const seen = new Set<string>();
  const credentials: DetectedCredential[] = [];

  function add(provider: string, key: string, source: string): void {
    const normalized = normalizeProviderId(provider);
    if (seen.has(normalized)) return;
    if (!key || key.trim() === "") return;
    seen.add(normalized);
    credentials.push({ provider: normalized, key: key.trim(), source });
  }

  // 1. opencode account.json (v2)
  scanAccountJson(options.accountJsonPath, add);

  // 2. opencode auth.json (v1)
  scanAuthJson(options.authJsonPath, add);

  // 3. Environment variables
  scanEnv(options.env, add);

  // 4. Shell RC files
  for (const rcPath of options.rcPaths) {
    scanRcFile(rcPath, add);
  }

  // 5. Claude Code .credentials.json
  scanClaudeCredentials(options.claudeCredPath, add);

  return { credentials };
}

// ─── Source scanners ─────────────────────────────────────────────────────────

type AddFn = (provider: string, key: string, source: string) => void;

function scanAccountJson(filePath: string, add: AddFn): void {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return;

    // v2 format: { version: 2, accounts: { <id>: { serviceID, credential: { type, key } } }, active: { <serviceID>: <id> } }
    if (data.version === 2 && typeof data.accounts === "object" && data.accounts !== null) {
      for (const [, entry] of Object.entries(data.accounts)) {
        if (typeof entry !== "object" || entry === null) continue;
        const acct = entry as { serviceID?: string; credential?: { type?: string; key?: string } };
        if (!acct.serviceID) continue;
        if (acct.credential?.type === "api" && typeof acct.credential.key === "string") {
          add(acct.serviceID, acct.credential.key, "opencode (account)");
        }
      }
      return;
    }

    // Legacy flat format: { <serviceID>: { token: "..." } }
    for (const [serviceId, entry] of Object.entries(data)) {
      if (typeof entry === "object" && entry !== null && "token" in entry) {
        const token = (entry as { token: unknown }).token;
        if (typeof token === "string") {
          add(serviceId, token, "opencode (account)");
        }
      }
    }
  } catch {
    // Skip unreadable/malformed files silently
  }
}

function scanAuthJson(filePath: string, add: AddFn): void {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return;

    // v1 format: flat { <serviceID>: { type: "api", key: "..." } }
    for (const [serviceId, entry] of Object.entries(data)) {
      if (typeof entry !== "object" || entry === null) continue;
      const cred = entry as { type?: string; key?: string };
      if (cred.type === "api" && typeof cred.key === "string") {
        add(serviceId, cred.key, "opencode (auth)");
      }
    }
  } catch {
    // Skip unreadable/malformed files silently
  }
}

function scanEnv(env: Record<string, string | undefined>, add: AddFn): void {
  for (const varName of SCANNABLE_ENV_VARS) {
    const value = env[varName];
    if (typeof value === "string" && value.trim() !== "") {
      add(ENV_TO_PROVIDER[varName], value, "environment");
    }
  }
}

/**
 * Parse shell RC files using strict regex — NO eval, NO child_process, NO subshell.
 * Matches: export VAR_NAME="value", export VAR_NAME='value', export VAR_NAME=value
 * Skips commented lines and lines with subshell expansion $(...) or backticks.
 */
function scanRcFile(filePath: string, add: AddFn): void {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    const basename = path.basename(filePath);

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // Skip comments
      if (trimmed.startsWith("#")) continue;

      // Strict regex: export VAR=value (with optional quotes)
      const match = trimmed.match(/^export\s+([\w]+)=["']?([^"'\s]*)["']?/);
      if (!match) continue;

      const [, varName, value] = match;
      if (!SCANNABLE_ENV_VARS.includes(varName)) continue;
      if (!value || value.trim() === "") continue;

      // Skip lines with subshell expansion (security: never execute)
      if (value.includes("$(") || value.includes("`")) continue;

      add(ENV_TO_PROVIDER[varName], value, basename);
    }
  } catch {
    // Skip unreadable files silently
  }
}

function scanClaudeCredentials(filePath: string, add: AddFn): void {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return;

    for (const entry of data) {
      if (typeof entry !== "object" || entry === null) continue;
      // Only import type: "api" entries — NEVER OAuth tokens
      if (entry.type !== "api") continue;
      const provider = entry.provider;
      const key = entry.key;
      if (typeof provider === "string" && typeof key === "string") {
        add(provider, key, "Claude Code");
      }
    }
  } catch {
    // Skip unreadable/malformed files silently
  }
}

// ─── Webview-safe output (AC8) ───────────────────────────────────────────────

/**
 * Convert detected credentials to a webview-safe format.
 * Keys are STRIPPED — only provider names, sources, and default model IDs are included.
 */
export function webviewSafeResults(credentials: DetectedCredential[]): SafeCredential[] {
  return credentials.map((c) => {
    const models = PROVIDER_MODELS[c.provider];
    const defaultModel = models?.[0]?.id ?? `${c.provider}/unknown`;
    return {
      provider: c.provider,
      source: c.source,
      model: defaultModel,
    };
  });
}

// ─── Key validation (#455) ───────────────────────────────────────────────────

/** Known placeholder keys that should never be persisted to config. */
const PLACEHOLDER_KEYS = new Set(["sk-test"]);

/**
 * Returns true if the API key is valid for writing to config.
 * Rejects: empty strings, known placeholders, and keys shorter than 10 chars.
 * Empty string is allowed ONLY when the caller explicitly passes it (OAuth
 * providers like github-copilot don't use API keys at all — they pass empty
 * and the entry is written without options.apiKey). This function is called
 * only when a key IS present (non-empty), so empty returns false here.
 */
export function isValidApiKey(key: string): boolean {
  if (!key || key.trim() === "") return false;
  if (PLACEHOLDER_KEYS.has(key.trim())) return false;
  if (key.trim().length < 10) return false;
  return true;
}

// ─── Batch config writing (AC7) ──────────────────────────────────────────────

/**
 * Write all detected providers to opencode.json in one pass.
 * The `activeProvider` becomes the active `model` (using its first model entry).
 * Uses the same schema as writeOnboardingConfig: provider.<id>.options.apiKey, env as string[].
 * Credentials with placeholder or invalid keys are silently skipped (#455).
 */
export function writeBatchConfig(
  credentials: DetectedCredential[],
  activeProvider: string,
  configPath?: string,
): void {
  const targetPath = configPath ?? path.join(os.homedir(), ".config", "opencode", "opencode.json");
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  // Read existing config to merge
  let existing: Record<string, unknown> = {};
  try {
    if (fs.existsSync(targetPath)) {
      existing = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    }
  } catch {
    // Start fresh if parsing fails
  }

  // Build provider entries — replaces the entire provider section
  // (on redo, user's selection is the canonical set; old entries don't persist)
  const providerEntry: Record<string, unknown> = {};

  for (const cred of credentials) {
    // Skip credentials with invalid/placeholder keys (#455)
    if (!isValidApiKey(cred.key)) continue;

    const entry: Record<string, unknown> = {};
    if (cred.key) {
      entry.options = { apiKey: cred.key };
    }
    const envVar = PROVIDER_ENV_VAR[cred.provider];
    if (envVar) {
      entry.env = [envVar];
    }
    providerEntry[cred.provider] = entry;
  }

  // Determine active model — only set when we have a known default.
  // Unknown providers (e.g. amazon-bedrock) let the server resolve its own
  // default from the connected provider's model list.
  const activeModels = PROVIDER_MODELS[activeProvider];
  const activeModel = activeModels?.[0]?.id;

  const result: Record<string, unknown> = {
    ...existing,
    $schema: "https://opencode.ai/config.json",
    provider: providerEntry,
  };
  if (activeModel) {
    result.model = activeModel;
  } else {
    // Remove stale model field if it points to an unknown model
    delete result.model;
  }

  fs.writeFileSync(targetPath, JSON.stringify(result, null, 2) + "\n");
}

// ─── Disconnect excluded providers from auth stores ──────────────────────────

/**
 * Remove credentials for excluded providers from opencode's auth stores.
 * After a server restart, excluded providers will no longer auto-connect.
 */
export function disconnectProviders(
  providers: string[],
  options?: { accountJsonPath?: string; authJsonPath?: string },
): void {
  const home = os.homedir();
  const dataDir = path.join(home, ".local", "share", "opencode");
  const accountPath = options?.accountJsonPath ?? path.join(dataDir, "account.json");
  const authPath = options?.authJsonPath ?? path.join(dataDir, "auth.json");

  // Build the set of serviceIDs to remove, including aliases
  const excludeSet = new Set(providers);
  if (excludeSet.has("opencode")) excludeSet.add("opencode-go");

  // Remove from account.json (v2)
  try {
    const raw = fs.readFileSync(accountPath, "utf8");
    const data = JSON.parse(raw);
    if (data.version === 2 && typeof data.accounts === "object" && data.accounts !== null) {
      let modified = false;
      for (const [id, entry] of Object.entries(data.accounts)) {
        const acct = entry as { serviceID?: string };
        if (acct.serviceID && excludeSet.has(acct.serviceID)) {
          delete data.accounts[id];
          if (data.active && acct.serviceID in data.active) {
            delete data.active[acct.serviceID];
          }
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(accountPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
  } catch {
    // Skip if file doesn't exist or is malformed
  }

  // Remove from auth.json (v1)
  try {
    const raw = fs.readFileSync(authPath, "utf8");
    const data = JSON.parse(raw);
    if (typeof data === "object" && data !== null) {
      let modified = false;
      for (const serviceId of excludeSet) {
        if (serviceId in data) {
          delete data[serviceId];
          modified = true;
        }
      }
      if (modified) {
        fs.writeFileSync(authPath, JSON.stringify(data, null, 2) + "\n");
      }
    }
  } catch {
    // Skip if file doesn't exist or is malformed
  }
}

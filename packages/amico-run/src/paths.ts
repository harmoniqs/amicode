// Centralized path resolution for Amicode application state.
//
// Resolution order (baseDir):
//   1. $AMICODE_ROOT env override (for tests / unusual layouts)
//   2. ~/.amicode/ exists → canonical new layout
//   3. ~/.amico/ exists → legacy fallback (pre-migration users)
//   4. ~/.amicode/ (default for fresh installs — created on first write by caller)
//
// Vaults are workspace-level (not app state) and resolve separately:
//   1. $AMICO_VAULTS_ROOT env override
//   2. ~/armonia/vaults/ exists → canonical
//   3. <baseDir>/vaults/ → legacy fallback
//
// Each sub-path resolver also respects its own $AMICO_* env override (for
// test isolation via execFileSync bundles) — the override wins unconditionally.
//
// This module is the SINGLE SOURCE OF TRUTH for path policy. Every consumer
// that formerly did `join(homedir(), ".amico", ...)` should import from here.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── base resolution ──────────────────────────────────────────────────────────

let _cachedBase: string | undefined;

/**
 * The root directory for all Amicode application state.
 * Cached for the process lifetime (path layout doesn't change mid-run).
 */
export function baseDir(): string {
  if (_cachedBase !== undefined) return _cachedBase;

  const explicit = process.env.AMICODE_ROOT;
  if (explicit && explicit.trim() !== "") {
    _cachedBase = explicit;
    return _cachedBase;
  }

  const canonical = join(homedir(), ".amicode");
  if (existsSync(canonical)) {
    _cachedBase = canonical;
    return _cachedBase;
  }

  const legacy = join(homedir(), ".amico");
  if (existsSync(legacy)) {
    _cachedBase = legacy;
    return _cachedBase;
  }

  // Fresh install: canonical path (created on first write by caller)
  _cachedBase = canonical;
  return _cachedBase;
}

/** Whether the resolved base is the new canonical layout (~/.amicode/). */
export function isCanonicalLayout(): boolean {
  return baseDir() === join(homedir(), ".amicode");
}

/** Whether we're on the legacy layout (~/.amico/). */
export function isLegacyLayout(): boolean {
  return baseDir() === join(homedir(), ".amico");
}

/** Reset the cached base (for tests only). */
export function _resetBaseDir(): void {
  _cachedBase = undefined;
}

// ── sub-path resolvers ────────────────────────────────────────────────────────
// Each respects its own env override first, then derives from baseDir().

/** Runs root: <base>/runs/<labId>/ */
export function runsRoot(labId: string): string {
  return join(baseDir(), "runs", labId);
}

/** Problems root: <base>/problems/ */
export function problemsRoot(): string {
  return join(baseDir(), "problems");
}

/** Julia project: <base>/env/julia/ (canonical) or <base>/julia/ (legacy) */
export function juliaProject(): string {
  const base = baseDir();
  if (isLegacyLayout()) return join(base, "julia");
  return join(base, "env", "julia");
}

/** Ledger directory: <base>/ledger/ */
export function ledgerDir(): string {
  return join(baseDir(), "ledger");
}

/** Ledger file: $AMICO_LEDGER or <base>/ledger/runs.jsonl */
export function ledgerFile(): string {
  const env = process.env.AMICO_LEDGER;
  if (env && env.trim() !== "") return env;
  return join(ledgerDir(), "runs.jsonl");
}

/** Claims file: $AMICO_CLAIMS_FILE or <base>/ledger/claims.jsonl */
export function claimsFile(): string {
  const env = process.env.AMICO_CLAIMS_FILE;
  if (env && env.trim() !== "") return env;
  return join(ledgerDir(), "claims.jsonl");
}

/** Authoring directory: <base>/authoring/ */
export function authoringDir(): string {
  return join(baseDir(), "authoring");
}

/** Authoring file: <base>/authoring/authoring.json */
export function authoringFile(): string {
  return join(authoringDir(), "authoring.json");
}

/** Devices directory: <base>/devices/ */
export function devicesDir(): string {
  return join(baseDir(), "devices");
}

/** Library directory: <base>/library/ */
export function libraryDir(): string {
  return join(baseDir(), "library");
}

/**
 * Ops directory (entitlements, solver-mode, onboarding state):
 *   $AMICODE_OPS_DIR or <base>/ops/ (canonical) or <base>/amicode/ (legacy)
 */
export function opsDir(): string {
  const env = process.env.AMICODE_OPS_DIR;
  if (env && env.trim() !== "") return env;
  const base = baseDir();
  if (isLegacyLayout()) return join(base, "amicode");
  return join(base, "ops");
}

/**
 * Fleet directory:
 *   $AMICO_FLEET_DIR or <base>/fleet/ (canonical) or <base>/ops/fleet/ (legacy)
 */
export function fleetDir(): string {
  const env = process.env.AMICO_FLEET_DIR;
  if (env && env.trim() !== "") return env;
  const base = baseDir();
  if (isLegacyLayout()) return join(base, "ops", "fleet");
  return join(base, "fleet");
}

// ── config files ──────────────────────────────────────────────────────────────
// Canonical layout puts configs in <base>/config/<name>.
// Legacy layout has them loose at <base>/<name>.

/** Resolve a config file path by name. */
export function configFile(name: string): string {
  const base = baseDir();
  if (isLegacyLayout()) return join(base, name);
  return join(base, "config", name);
}

/** profile.json */
export function profileFile(): string {
  return configFile("profile.json");
}

/** cloud.json: cloud API credentials */
export function cloudConfigFile(): string {
  return configFile("cloud.json");
}

/** pasqal.json: Pasqal credentials */
export function pasqalConfigFile(): string {
  return configFile("pasqal.json");
}

/** connections.json: connections status cache */
export function connectionsFile(): string {
  return configFile("connections.json");
}

/** lab.toml: hardware lab profile */
export function labTomlFile(): string {
  return configFile("lab.toml");
}

/** mounts.toml: vault mount manifest */
export function mountsTomlFile(): string {
  const env = process.env.AMICO_MOUNTS_TOML;
  if (env && env.trim() !== "") return env;
  return configFile("mounts.toml");
}

// ── vaults (workspace-level, lives under ~/armonia/) ─────────────────────────

/**
 * Vaults root: $AMICO_VAULTS_ROOT or ~/armonia/vaults/ (canonical) or <base>/vaults/ (legacy).
 * Vaults are workspace content (shared knowledge), not app state — they live
 * under ~/armonia/ in the canonical layout.
 */
export function vaultsRoot(): string {
  const env = process.env.AMICO_VAULTS_ROOT;
  if (env && env.trim() !== "") return env;

  const armonia = join(homedir(), "armonia", "vaults");
  if (existsSync(armonia)) return armonia;

  return join(baseDir(), "vaults");
}

/** The team vault (armonissima) */
export function teamVaultDir(): string {
  return join(vaultsRoot(), "armonissima");
}

/** Catalog pulses directory (under team vault) */
export function catalogPulsesDir(): string {
  return join(teamVaultDir(), "catalog", "pulses");
}

/** Profiles directory (under team vault) */
export function profilesVaultDir(): string {
  const env = process.env.AMICO_PROFILES_DIR;
  if (env && env.trim() !== "") return env;
  return join(teamVaultDir(), "profiles");
}

/** Skills directory (internal, under team vault) */
export function teamSkillsDir(): string {
  return join(teamVaultDir(), "skills");
}

// ── repos (workspace layer) ──────────────────────────────────────────────────

/** Repos root: ~/armonia/repos/ */
export function reposRoot(): string {
  return join(homedir(), "armonia", "repos");
}

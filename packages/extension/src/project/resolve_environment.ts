// resolve_environment.ts — Four-strategy environment resolution for a given
// project path. Part of #882 (sub-issue of #880 Research Environments).
//
// Resolution order:
//   1. Walk-up: look for research-environment.toml in ancestor directories,
//      stopping at the workspace folder root
//   2. Explicit path: read [environment].path from the project's TOML
//   3. Workspace scan: check sibling workspace folders for a matching slug
//   4. Registry: look up the slug in ~/.amico/environments.toml
//
// Walk-up wins over explicit path when both resolve (physical topology is
// authoritative). All failures are null + console.warn — never thrown errors.
//
// NO VS Code API dependency — `workspaceRoots` is passed by the caller.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ResolvedEnvironment {
  path: string;           // absolute path to environment root
  slug: string;           // from manifest
  name: string;           // from manifest
  schemaVersion: number;  // validated <= KNOWN_VERSION
}

export interface ResolveOptions {
  /** Override the registry path (for testing). */
  registryPath?: string;
}

// ── Constants ───────────────────────────────────────────────────────────────

const KNOWN_SCHEMA_VERSION = 1;
const ENV_MANIFEST = "research-environment.toml";
const PROJECT_MANIFEST = "research-project.toml";

// ── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, ResolvedEnvironment | null>();

export function invalidateEnvironmentCache(): void {
  cache.clear();
}

// ── Manifest reading ────────────────────────────────────────────────────────

function readEnvManifest(dir: string): ResolvedEnvironment | null {
  const manifestPath = join(dir, ENV_MANIFEST);
  if (!existsSync(manifestPath)) return null;

  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    console.warn(`amicode: failed to read ${manifestPath}`);
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw) as Record<string, unknown>;
  } catch {
    console.warn(`amicode: malformed TOML in ${manifestPath}`);
    return null;
  }

  const schemaVersion = parsed.schema_version;
  if (typeof schemaVersion !== "number") {
    console.warn(`amicode: missing schema_version in ${manifestPath}`);
    return null;
  }
  if (schemaVersion > KNOWN_SCHEMA_VERSION) {
    console.warn(
      `amicode: ${manifestPath} has schema_version ${schemaVersion} (known: ${KNOWN_SCHEMA_VERSION}) — treating as unreadable`,
    );
    return null;
  }

  const slug = parsed.slug;
  const name = parsed.name;
  if (typeof slug !== "string" || typeof name !== "string") {
    console.warn(`amicode: missing slug or name in ${manifestPath}`);
    return null;
  }

  return {
    path: dir,
    slug,
    name,
    schemaVersion,
  };
}

/** Read the [environment] section from a project's research-project.toml. */
function readProjectEnvironmentSection(
  projectDir: string,
): { slug: string; path?: string } | null {
  const tomlPath = join(projectDir, PROJECT_MANIFEST);
  if (!existsSync(tomlPath)) return null;

  try {
    const raw = readFileSync(tomlPath, "utf8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    const env = parsed.environment as Record<string, unknown> | undefined;
    if (!env || typeof env.slug !== "string") return null;
    return {
      slug: env.slug,
      path: typeof env.path === "string" ? env.path : undefined,
    };
  } catch {
    return null;
  }
}

// ── Strategy implementations ────────────────────────────────────────────────

/** Strategy 1: Walk up from projectDir, stopping at any workspace root. */
function walkUp(
  projectDir: string,
  workspaceRoots: string[],
): ResolvedEnvironment | null {
  const rootSet = new Set(workspaceRoots.map((r) => resolve(r)));
  let current = resolve(projectDir);

  // Walk up, including the project dir itself (but typically skipped since
  // a project dir doesn't have research-environment.toml)
  while (true) {
    const env = readEnvManifest(current);
    if (env) return env;

    // Stop if we've reached a workspace root
    if (rootSet.has(current)) break;

    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  return null;
}

/** Strategy 2: Resolve via [environment].path in the project TOML. */
function explicitPath(projectDir: string): ResolvedEnvironment | null {
  const section = readProjectEnvironmentSection(projectDir);
  if (!section?.path) return null;

  const envDir = resolve(section.path);
  if (!existsSync(envDir)) {
    console.warn(`amicode: [environment].path "${section.path}" does not exist`);
    return null;
  }

  const env = readEnvManifest(envDir);
  if (!env) {
    console.warn(`amicode: no valid manifest at [environment].path "${section.path}"`);
  }
  return env;
}

/** Strategy 3: Scan workspace folders for one whose manifest slug matches. */
function workspaceScan(
  projectDir: string,
  workspaceRoots: string[],
): ResolvedEnvironment | null {
  const section = readProjectEnvironmentSection(projectDir);
  if (!section) return null;

  for (const root of workspaceRoots) {
    const resolved = resolve(root);
    if (resolved === resolve(projectDir)) continue; // skip self
    const env = readEnvManifest(resolved);
    if (env && env.slug === section.slug) return env;
  }

  return null;
}

/** Strategy 4: Look up the slug in the environment registry. */
function registryLookup(
  projectDir: string,
  registryPath: string,
): ResolvedEnvironment | null {
  const section = readProjectEnvironmentSection(projectDir);
  if (!section) return null;

  if (!existsSync(registryPath)) return null;

  try {
    const raw = readFileSync(registryPath, "utf8");
    const parsed = parseToml(raw) as Record<string, unknown>;
    const envs = parsed.environments;
    if (!Array.isArray(envs)) return null;

    for (const entry of envs) {
      const e = entry as Record<string, unknown>;
      if (e.slug === section.slug && typeof e.path === "string") {
        const envDir = resolve(e.path);
        if (!existsSync(envDir)) continue; // stale entry
        const env = readEnvManifest(envDir);
        if (env) return env;
      }
    }
  } catch {
    // Registry parse failure — treat as empty
  }

  return null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Resolve the research environment for a project directory.
 * Returns null if no environment is found or all candidates are invalid.
 *
 * Resolution order: walk-up → explicit path → workspace scan → registry.
 * Walk-up wins over explicit path (physical topology is authoritative).
 *
 * Results are cached per project path. Call `invalidateEnvironmentCache()`
 * when manifest files change.
 */
export function resolveEnvironment(
  projectPath: string,
  workspaceRoots: string[],
  opts?: ResolveOptions,
): ResolvedEnvironment | null {
  const key = resolve(projectPath);

  if (cache.has(key)) {
    return cache.get(key)!;
  }

  const registryPath = opts?.registryPath ?? join(homedir(), ".amico", "environments.toml");

  // Strategy 1: walk-up (physical topology — authoritative)
  const walkUpResult = walkUp(projectPath, workspaceRoots);
  if (walkUpResult) {
    cache.set(key, walkUpResult);
    return walkUpResult;
  }

  // Strategy 2: explicit [environment].path
  const explicitResult = explicitPath(projectPath);
  if (explicitResult) {
    cache.set(key, explicitResult);
    return explicitResult;
  }

  // Strategy 3: workspace folder scan
  const scanResult = workspaceScan(projectPath, workspaceRoots);
  if (scanResult) {
    cache.set(key, scanResult);
    return scanResult;
  }

  // Strategy 4: registry lookup
  const regResult = registryLookup(projectPath, registryPath);
  if (regResult) {
    cache.set(key, regResult);
    return regResult;
  }

  // No environment found
  cache.set(key, null);
  return null;
}

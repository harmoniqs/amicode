import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillIndexEntry } from "./package_skills";

// --- Types ---

export interface SkillProvider {
  id: string;
  type: "directory" | "url";
  path?: string;
  url?: string;
  added: string;
  cache_path?: string;
}

export interface SkillProvidersConfig {
  version: number;
  providers: SkillProvider[];
}

// --- Internal helpers ---

/** Scan a directory for <name>/SKILL.md entries. User skills need only
 *  name + description in frontmatter (no surface tag required). */
function scanSkillDirectory(dirPath: string, source: SkillIndexEntry["source"]): SkillIndexEntry[] {
  const out: SkillIndexEntry[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return [];
  }
  for (const name of names.sort()) {
    const skillPath = path.join(dirPath, name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    try {
      const raw = fs.readFileSync(skillPath, "utf8");
      const m = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!m) {
        console.warn(`amicode: skipping malformed ${source} skill ${skillPath}: missing frontmatter`);
        continue;
      }
      const fm = parseYaml(m[1]) as { name?: string; description?: string };
      if (typeof fm.name !== "string" || typeof fm.description !== "string") {
        console.warn(`amicode: skipping ${source} skill ${skillPath}: frontmatter needs name + description`);
        continue;
      }
      out.push({ source, name: fm.name, description: fm.description, path: skillPath });
    } catch (e) {
      console.warn(`amicode: skipping ${source} skill ${skillPath}: ${e}`);
    }
  }
  return out;
}

// --- Public API ---

/** Resolve user skills from providers listed in skill-providers.json.
 *  Returns entries with source "custom". Missing/malformed config → []. */
export function resolveUserSkills(providersPath: string): SkillIndexEntry[] {
  let config: SkillProvidersConfig;
  try {
    const raw = fs.readFileSync(providersPath, "utf8");
    config = JSON.parse(raw) as SkillProvidersConfig;
  } catch {
    return [];
  }
  if (!config || !Array.isArray(config.providers)) return [];

  const out: SkillIndexEntry[] = [];
  for (const provider of config.providers) {
    if (provider.type === "directory" && provider.path) {
      out.push(...scanSkillDirectory(provider.path, "custom"));
    } else if (provider.type === "url" && provider.cache_path) {
      out.push(...resolveUrlProvider(provider.cache_path));
    }
  }
  return out;
}

/** Resolve workspace skills from .opencode/skills/ (auto-loaded, team consensus).
 *  Same scanning logic as user skills, but labeled "workspace". */
export function resolveWorkspaceSkills(wsSkillsDir: string): SkillIndexEntry[] {
  return scanSkillDirectory(wsSkillsDir, "workspace");
}

/** A merged entry may carry an `overridesShipped` flag when a custom/workspace
 *  skill shadows a platform (library/package) skill of the same name. */
export interface MergedSkillEntry extends SkillIndexEntry {
  overridesShipped?: boolean;
}

/** Merge skill entries with shadow semantics: custom > workspace > shipped.
 *  First match by name wins (resolution order). If a custom or workspace entry
 *  shadows a shipped skill, the winner carries `overridesShipped: true` so the
 *  Skill Index can label it appropriately. */
export function mergeSkillEntries(
  custom: SkillIndexEntry[],
  workspace: SkillIndexEntry[],
  shipped: SkillIndexEntry[],
): MergedSkillEntry[] {
  const seen = new Set<string>();
  const shippedNames = new Set(shipped.map((e) => e.name));
  const out: MergedSkillEntry[] = [];

  // Custom first (highest priority)
  for (const e of custom) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    const overrides = shippedNames.has(e.name);
    out.push(overrides ? { ...e, overridesShipped: true } : e);
  }
  // Workspace second
  for (const e of workspace) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    const overrides = shippedNames.has(e.name);
    out.push(overrides ? { ...e, overridesShipped: true } : e);
  }
  // Shipped last (only those not shadowed)
  for (const e of shipped) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push(e);
  }
  return out;
}

// --- Autodiscover ---

/** Known engine auto-load paths to scan for existing skills. */
const KNOWN_SKILL_PATHS = [
  ".claude/skills",
  ".agents/skills",
  ".config/opencode/skills",
];

/** Check if a directory contains at least one valid skill (has a <name>/SKILL.md). */
function hasSkills(dir: string): boolean {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (fs.existsSync(path.join(dir, name, "SKILL.md"))) return true;
    }
  } catch { /* empty */ }
  return false;
}

/** Discover external skill directories on the user's machine that can be
 *  imported as providers. Scans known engine auto-load paths under `homeDir`.
 *  Optionally filters out paths already registered in `existingProviders`. */
export function discoverExternalSkillPaths(
  homeDir: string,
  existingProviders: SkillProvider[] = [],
): string[] {
  const existingPaths = new Set(existingProviders.map((p) => p.path).filter(Boolean));
  const found: string[] = [];
  for (const rel of KNOWN_SKILL_PATHS) {
    const abs = path.join(homeDir, rel);
    if (!hasSkills(abs)) continue;
    if (existingPaths.has(abs)) continue;
    found.push(abs);
  }
  return found;
}

// --- URL providers ---

/** Resolve skills from a URL provider's local cache directory.
 *  The cache is a directory structure identical to a local directory provider
 *  (populated by a prior fetch). Returns skills labeled "custom" — the URL
 *  provenance is tracked in the provider config, not on each entry.
 *  Missing/empty cache → []. URL fetch failures never block session start. */
export function resolveUrlProvider(cacheDir: string): SkillIndexEntry[] {
  return scanSkillDirectory(cacheDir, "custom");
}

// --- Persistence (CRUD for skill-providers.json) ---

const EMPTY_CONFIG: SkillProvidersConfig = { version: 1, providers: [] };

/** Read and parse the skill-providers.json config. Missing/malformed → empty config. */
export function readSkillProviders(providersPath: string): SkillProvidersConfig {
  try {
    const raw = fs.readFileSync(providersPath, "utf8");
    const config = JSON.parse(raw) as SkillProvidersConfig;
    if (!config || !Array.isArray(config.providers)) return { ...EMPTY_CONFIG, providers: [] };
    return config;
  } catch {
    return { ...EMPTY_CONFIG, providers: [] };
  }
}

/** Add a provider to skill-providers.json. Creates the file and parent dirs if missing. */
export function addSkillProvider(providersPath: string, provider: SkillProvider): void {
  const config = readSkillProviders(providersPath);
  config.providers.push(provider);
  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  fs.writeFileSync(providersPath, JSON.stringify(config, null, 2));
}

/** Remove a provider by id from skill-providers.json. No-op if id not found. */
export function removeSkillProvider(providersPath: string, id: string): void {
  const config = readSkillProviders(providersPath);
  config.providers = config.providers.filter((p) => p.id !== id);
  fs.mkdirSync(path.dirname(providersPath), { recursive: true });
  fs.writeFileSync(providersPath, JSON.stringify(config, null, 2));
}

// --- Friendly naming ---

/** Known path patterns → friendly display names. Matches the trailing
 *  segments of the path so it works regardless of home directory prefix. */
const KNOWN_PATH_NAMES: [RegExp, string][] = [
  [/\.claude\/skills\/?$/, "Claude Skills"],
  [/\.chatgpt\/skills\/?$/, "ChatGPT Skills"],
  [/\.config\/opencode\/skills\/?$/, "OpenCode Skills"],
  [/\.agents\/skills\/?$/, "Agents Skills"],
];

/** Derive a friendly provider name from a directory path.
 *  Known engine paths get human-readable names; unknown paths use the basename. */
export function friendlyProviderName(dirPath: string): string {
  for (const [pattern, name] of KNOWN_PATH_NAMES) {
    if (pattern.test(dirPath)) return name;
  }
  return path.basename(dirPath);
}

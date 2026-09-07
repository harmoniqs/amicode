// detect.ts — project type detection (#666, #882).
// A Research Project is identified by a `research-project.toml` manifest at its root.
// A Research Environment is identified by a `research-environment.toml` manifest.
// Detection is by file presence only (fast stat, no content parsing).
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ProjectType = "research" | "dev" | "environment";

/**
 * Detect whether a directory is a Research Environment, Research Project,
 * or a Dev Project.
 *
 * Detection order:
 *   1. `research-environment.toml` exists → `"environment"`
 *   2. `research-project.toml` exists → `"research"`
 *   3. Otherwise → `"dev"`
 *
 * Environment takes priority (handles the monorepo root case where both
 * manifests might coexist).
 *
 * Re-evaluated on each call — no caching — so a directory that gains
 * a manifest after initial registration updates its type on next
 * resolution.
 */
export function detectProjectType(dir: string): ProjectType {
  try {
    if (existsSync(join(dir, "research-environment.toml"))) return "environment";
    if (existsSync(join(dir, "research-project.toml"))) return "research";
    return "dev";
  } catch {
    return "dev";
  }
}

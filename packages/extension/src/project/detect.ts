// detect.ts — project type detection (#666).
// A Research Project is identified by a `research-project.toml` manifest at its root.
// Detection is by file presence only (fast stat, no content parsing).
import { existsSync } from "node:fs";
import { join } from "node:path";

export type ProjectType = "research" | "dev";

/**
 * Detect whether a directory is a Research Project or a Dev Project.
 * A Research Project has a `research-project.toml` manifest at its root.
 * Everything else is a Dev Project (the existing git-repo model).
 *
 * Re-evaluated on each call — no caching — so a directory that gains
 * `research-project.toml` after initial registration updates its type on next
 * resolution.
 */
export function detectProjectType(dir: string): ProjectType {
  try {
    return existsSync(join(dir, "research-project.toml")) ? "research" : "dev";
  } catch {
    return "dev";
  }
}

// workspace_projects.ts — Scan VS Code workspace folders and produce typed
// project entries for the chat panel bridge (#663).
//
// The chat iframe's PromptProjectSelector reads these entries as its data
// source. Research Projects are identified by `research-project.toml`;
// everything else is a Dev Project. Research projects are grouped before dev
// projects (same ordering as the sidebar tree).

import type { ProjectType } from "./project/detect";

// ── Data contract ────────────────────────────────────────────────────────────

/** A workspace project entry as sent over the chat bridge. Matches the shape
 *  the app's PromptProject type expects (name, worktree, type, status). */
export interface WorkspaceProjectEntry {
  name: string;
  worktree: string;
  type: ProjectType;
  status?: string;
}

/** Injected dependencies — testable without VS Code API or filesystem. */
export interface WorkspaceProjectDeps {
  getWorkspaceFolders: () => Array<{ uri: { fsPath: string }; name: string }>;
  detectProjectType: (dir: string) => ProjectType;
  readToml: (dir: string) => { name?: string; status?: string };
}

// ── Scanner ──────────────────────────────────────────────────────────────────

/**
 * Convert VS Code workspace folders into typed project entries.
 * Research projects appear first, then dev projects (same grouping as the
 * sidebar tree service). Pure function — no caching, no side effects.
 */
export function getWorkspaceProjects(deps: WorkspaceProjectDeps): WorkspaceProjectEntry[] {
  const folders = deps.getWorkspaceFolders();
  const research: WorkspaceProjectEntry[] = [];
  const dev: WorkspaceProjectEntry[] = [];

  for (const folder of folders) {
    const dir = folder.uri.fsPath;
    const projectType = deps.detectProjectType(dir);

    if (projectType === "research") {
      let toml: { name?: string; status?: string } = {};
      try {
        toml = deps.readToml(dir);
      } catch {
        // Parse failure — fall back to folder name, no status
      }
      const entry: WorkspaceProjectEntry = {
        name: toml.name ?? folder.name,
        worktree: dir,
        type: "research",
      };
      if (toml.status) entry.status = toml.status;
      research.push(entry);
    } else {
      dev.push({
        name: folder.name,
        worktree: dir,
        type: "dev",
      });
    }
  }

  return [...research, ...dev];
}

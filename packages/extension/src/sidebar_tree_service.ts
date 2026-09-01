// sidebar_tree_service.ts — Extension-side tree scanning for the sidebar (#675).
//
// Owns the logic that the SidebarViewProvider's bridge handlers delegate to:
// scanning workspace folders, classifying projects, reading directory entries
// with filtering and sorting. All filesystem access runs on the extension host
// (Node runtime) and the results are posted to the webview via bridge messages.

import type { TreeRoot, TreeEntry } from "./sidebar_bridge";

// ── Dependencies (injected for testability) ──────────────────────────────────

export interface RawDirEntry {
  name: string;
  type: "file" | "directory";
}

export interface TreeServiceDeps {
  /** Classify a directory as research or dev. */
  detectProjectType: (dir: string) => "research" | "dev";
  /** Read research-project.toml fields (name, status). Returns {} on failure. */
  readToml: (dir: string) => { name?: string; status?: string };
  /** Read immediate children of a directory. */
  readDirectory?: (dir: string) => Promise<RawDirEntry[]>;
  /** Get exclude pattern strings from files.exclude. */
  getExcludePatterns?: () => string[];
  /** Get current workspace folders. */
  getWorkspaceFolders?: () => Array<{ uri: { fsPath: string }; name: string }>;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Stateless tree-scanning service. Each method is a pure query — no caching,
 * no watchers, no VS Code API calls. The provider wires these to the bridge.
 */
export class SidebarTreeService {
  private deps: TreeServiceDeps;

  constructor(deps: TreeServiceDeps) {
    this.deps = deps;
  }

  /**
   * Scan workspace folders and return structured roots.
   * Research Projects are grouped before Dev Projects.
   */
  getRoots(): TreeRoot[] {
    const workspaceFolders = this.deps.getWorkspaceFolders?.() ?? [];

    const research: TreeRoot[] = [];
    const dev: TreeRoot[] = [];

    for (const folder of workspaceFolders) {
      const dir = folder.uri.fsPath;
      const projectType = this.deps.detectProjectType(dir);

      if (projectType === "research") {
        const toml = this.deps.readToml(dir);
        research.push({
          path: dir,
          name: toml.name ?? folder.name,
          projectType: "research",
          metadata: toml.status ? { phase: toml.status } : undefined,
        });
      } else {
        dev.push({
          path: dir,
          name: folder.name,
          projectType: "dev",
        });
      }
    }

    // Research first, then dev
    return [...research, ...dev];
  }

  /**
   * Lazy-load immediate children of a directory.
   * Filters .git, applies files.exclude, sorts dirs-first then alphabetical.
   */
  async getChildren(dirPath: string): Promise<TreeEntry[]> {
    if (!this.deps.readDirectory) return [];

    const raw = await this.deps.readDirectory(dirPath);
    const excludePatterns = this.deps.getExcludePatterns?.() ?? [];

    const filtered = raw.filter((entry) => {
      // Always hide .git
      if (entry.name === ".git") return false;
      // Apply exclude patterns (simple name match)
      for (const pat of excludePatterns) {
        if (pat && entry.name === pat) return false;
      }
      return true;
    });

    // Sort: directories first, then files, alphabetically within each group
    filtered.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return filtered.map((entry) => ({
      name: entry.name,
      type: entry.type,
      path: `${dirPath}/${entry.name}`,
    }));
  }
}

// sidebar_tree_service.ts — Extension-side tree scanning for the sidebar (#675).
//
// Owns the logic that the SidebarViewProvider's bridge handlers delegate to:
// scanning workspace folders, classifying projects, reading directory entries
// with filtering and sorting. All filesystem access runs on the extension host
// (Node runtime) and the results are posted to the webview via bridge messages.

import type { TreeRoot, TreeEntry } from "./sidebar_bridge";
import { envColorIndex } from "./sidebar_bridge";

// ── Dependencies (injected for testability) ──────────────────────────────────

export interface RawDirEntry {
  name: string;
  type: "file" | "directory";
}

export interface TreeServiceDeps {
  /** Classify a directory as research, dev, or environment. */
  detectProjectType: (dir: string) => "research" | "dev" | "environment";
  /** Read research-project.toml fields (name, status). Returns {} on failure. */
  readToml: (dir: string) => { name?: string; status?: string };
  /** Resolve the research environment for a project directory. */
  resolveEnvironment?: (projectPath: string, workspaceRoots: string[]) => { path: string; slug: string; name: string; schemaVersion: number } | null;
  /** Read immediate children of a directory. */
  readDirectory?: (dir: string) => Promise<RawDirEntry[]>;
  /** Get exclude pattern strings from files.exclude. */
  getExcludePatterns?: () => string[];
  /** Get current workspace folders. */
  getWorkspaceFolders?: () => ReadonlyArray<{ uri: { fsPath: string }; name: string }>;
}

// ── Service ──────────────────────────────────────────────────────────────────

/**
 * Stateless tree-scanning service. Each method is a pure query — no caching,
 * no watchers, no VS Code API calls. The provider wires these to the bridge.
 */
export class SidebarTreeService {
  private deps: TreeServiceDeps;
  /** Map root path → resolved environment info from the last getRoots() call (#885). */
  private rootEnvironments = new Map<string, { name: string; slug: string; path: string }>();

  constructor(deps: TreeServiceDeps) {
    this.deps = deps;
  }

  /**
   * Scan workspace folders and return structured roots.
   * Research Projects are grouped before Dev Projects.
   */
  getRoots(): TreeRoot[] {
    const workspaceFolders = this.deps.getWorkspaceFolders?.() ?? [];
    const workspaceRoots = workspaceFolders.map((f) => f.uri.fsPath);

    const research: TreeRoot[] = [];
    const dev: TreeRoot[] = [];
    this.rootEnvironments.clear();

    for (const folder of workspaceFolders) {
      const dir = folder.uri.fsPath;
      const projectType = this.deps.detectProjectType(dir);

      // Environment folders are not shown as sidebar roots (AC-49)
      if (projectType === "environment") continue;

      if (projectType === "research") {
        const toml = this.deps.readToml(dir);
        const root: TreeRoot = {
          path: dir,
          name: toml.name ?? folder.name,
          projectType: "research",
          metadata: toml.status ? { phase: toml.status } : undefined,
        };
        // Resolve environment for this project (#884)
        if (this.deps.resolveEnvironment) {
          try {
            const env = this.deps.resolveEnvironment(dir, workspaceRoots);
            if (env) {
              root.environment = {
                name: env.name,
                slug: env.slug,
                path: env.path,
                colorIndex: envColorIndex(env.slug),
              };
              this.rootEnvironments.set(dir, { name: env.name, slug: env.slug, path: env.path });
            }
          } catch {
            // Resolution failure → no pill, not a crash
          }
        }
        research.push(root);
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

    const entries: TreeEntry[] = filtered.map((entry) => ({
      name: entry.name,
      type: entry.type,
      path: `${dirPath}/${entry.name}`,
    }));

    // If this is a project root with a bound environment, append the
    // environment as the last child (#885)
    const envInfo = this.rootEnvironments.get(dirPath);
    if (envInfo) {
      entries.push({
        name: envInfo.name,
        type: "directory",
        path: envInfo.path,
        entryKind: "environment-root",
        environmentSlug: envInfo.slug,
      });
    }

    return entries;
  }
}

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
  /** Read environment manifest fields (name, slug) from a directory. Returns null on failure. */
  readEnvironmentToml?: (dir: string) => { name: string; slug: string } | null;
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

  constructor(deps: TreeServiceDeps) {
    this.deps = deps;
  }

  /**
   * Scan workspace folders and return structured roots.
   * Environment roots first, then Research Projects, then Dev Projects.
   * Environments come from two sources: workspace folders with
   * research-environment.toml, and environments resolved from project bindings.
   * Deduped by slug — workspace-folder path wins over resolved path (#895).
   */
  getRoots(): TreeRoot[] {
    const workspaceFolders = this.deps.getWorkspaceFolders?.() ?? [];
    const workspaceRoots = workspaceFolders.map((f) => f.uri.fsPath);

    const research: TreeRoot[] = [];
    const dev: TreeRoot[] = [];
    /** Environment roots keyed by slug for dedup. */
    const envBySlug = new Map<string, TreeRoot>();
    /** Track which slugs each research project resolves to, for boundProjectCount. */
    const projectEnvSlugs: string[] = [];

    // ── Pass 1: workspace folders ──────────────────────────────────────────
    for (const folder of workspaceFolders) {
      const dir = folder.uri.fsPath;
      const projectType = this.deps.detectProjectType(dir);

      if (projectType === "environment") {
        // Collect environment workspace folders (#895)
        // Always overwrite: workspace source wins dedup over resolved (#895 bugfix)
        if (this.deps.readEnvironmentToml) {
          try {
            const envManifest = this.deps.readEnvironmentToml(dir);
            if (envManifest) {
              const slug = envManifest.slug;
              envBySlug.set(slug, {
                path: dir,
                name: envManifest.name,
                projectType: "environment",
                source: "workspace",
                boundProjectCount: 0,
                environment: {
                  name: envManifest.name,
                  slug,
                  path: dir,
                  colorIndex: envColorIndex(slug),
                },
              });
            }
          } catch {
            // Manifest read failure → skip this environment
          }
        }
        continue; // Environments are never in research/dev lists
      }

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
              projectEnvSlugs.push(env.slug);

              // Auto-surface resolved environments that aren't already in the map (#895)
              if (!envBySlug.has(env.slug)) {
                envBySlug.set(env.slug, {
                  path: env.path,
                  name: env.name,
                  projectType: "environment",
                  source: "resolved",
                  boundProjectCount: 0,
                  environment: {
                    name: env.name,
                    slug: env.slug,
                    path: env.path,
                    colorIndex: envColorIndex(env.slug),
                  },
                });
              }
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

    // ── Pass 2: compute boundProjectCount for each environment ─────────────
    for (const envRoot of envBySlug.values()) {
      const slug = envRoot.environment?.slug;
      if (slug) {
        envRoot.boundProjectCount = projectEnvSlugs.filter((s) => s === slug).length;
      }
    }

    // Environments first, then research, then dev
    const environments = [...envBySlug.values()];
    return [...environments, ...research, ...dev];
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

    return entries;
  }
}

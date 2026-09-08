// preview_file_tree.ts — Extension-side recursive directory scan for the
// Preview tab's project-wide file tree (#725).
//
// Produces a list of relative paths (forward-slash separated) filtered to
// RENDERABLE_EXTENSIONS. Called by pushPreviewFileTree() in extension.ts and
// pushed to the webview via the "preview-file-tree" bridge message.
//
// Design choices:
// - Synchronous fs.readdirSync for simplicity (runs once on app-ready + refresh,
//   not in a hot path). Async could be added if projects get very large.
// - Hidden directories (dotfiles), node_modules, __pycache__, .julia skipped.
// - Max depth of 20 to avoid runaway scans in pathological directory structures.

import { readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

/** File extensions the Preview tab can render. Used to filter the file tree. */
export const RENDERABLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".pdf",
  ".tex",
  ".bib",
  ".tikz",
  ".sty",
  ".cls",
  ".png",
  ".jpg",
  ".svg",
  ".log",
]);

/** Directories to always skip during recursive scan. */
const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".hg",
  ".svn",
  ".julia",
  ".vscode",
  ".idea",
  "build",
  "dist",
]);

const MAX_DEPTH = 20;

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Recursively scan a directory and return relative paths of renderable files.
 * Paths use forward slashes regardless of platform.
 *
 * Returns an empty array if the directory does not exist or is unreadable.
 */
export function scanRenderableFiles(rootDir: string): string[] {
  const results: string[] = [];

  function walk(dir: string, depth: number): void {
    if (depth > MAX_DEPTH) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory
    }

    for (const entry of entries) {
      // Skip hidden entries (dotfiles/dotdirs) and known skip dirs
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // broken symlink or permission issue
      }

      if (stat.isDirectory()) {
        walk(fullPath, depth + 1);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (RENDERABLE_EXTENSIONS.has(ext)) {
          // Produce a forward-slash relative path
          const rel = relative(rootDir, fullPath).replaceAll("\\", "/");
          results.push(rel);
        }
      }
    }
  }

  walk(rootDir, 0);
  return results;
}

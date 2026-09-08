// preview_file_tree.test.ts — TDD tests for the Preview tab file tree scanner.
// Tests the extension-side recursive directory scan + renderable-extension filter.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The module under test — will be created in the GREEN phase.
import {
  RENDERABLE_EXTENSIONS,
  scanRenderableFiles,
  pickPreviewProject,
} from "../src/preview_file_tree";
import type { WorkspaceProjectEntry } from "../src/workspace_projects";

// ── Fixtures ────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `amicode-preview-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Create a file at a relative path inside testDir. */
function touch(relativePath: string, content = ""): void {
  const full = join(testDir, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

// ── RENDERABLE_EXTENSIONS ───────────────────────────────────────────────────

describe("RENDERABLE_EXTENSIONS", () => {
  it("includes all expected renderable types", () => {
    const expected = [
      ".md", ".txt", ".pdf", ".tex", ".bib", ".tikz",
      ".sty", ".cls", ".png", ".jpg", ".svg", ".log",
    ];
    for (const ext of expected) {
      expect(RENDERABLE_EXTENSIONS.has(ext), `missing ${ext}`).toBe(true);
    }
  });

  it("does not include non-renderable types", () => {
    const excluded = [".js", ".ts", ".json", ".toml", ".py", ".jl", ".lock", ".exe"];
    for (const ext of excluded) {
      expect(RENDERABLE_EXTENSIONS.has(ext), `should not include ${ext}`).toBe(false);
    }
  });
});

// ── scanRenderableFiles ─────────────────────────────────────────────────────

describe("scanRenderableFiles", () => {
  it("returns relative paths for renderable files", () => {
    touch("paper/main.tex", "\\documentclass{article}");
    touch("paper/refs.bib", "@article{foo}");
    touch("notes.md", "# Notes");
    touch("figure.png", "PNG");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("paper/main.tex");
    expect(result).toContain("paper/refs.bib");
    expect(result).toContain("notes.md");
    expect(result).toContain("figure.png");
  });

  it("filters out non-renderable files", () => {
    touch("src/main.jl", "println()");
    touch("package.json", "{}");
    touch("Manifest.toml", "");
    touch("notes.md", "# ok");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("notes.md");
    expect(result).not.toContain("src/main.jl");
    expect(result).not.toContain("package.json");
    expect(result).not.toContain("Manifest.toml");
  });

  it("returns empty array for empty directory", () => {
    const result = scanRenderableFiles(testDir);
    expect(result).toEqual([]);
  });

  it("handles nested directory structures", () => {
    touch("a/b/c/deep.tex", "deep");
    touch("a/b/notes.md", "notes");
    touch("top.pdf", "pdf");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("a/b/c/deep.tex");
    expect(result).toContain("a/b/notes.md");
    expect(result).toContain("top.pdf");
  });

  it("skips hidden directories (dotfiles)", () => {
    touch(".git/config", "git");
    touch(".vscode/settings.json", "{}");
    touch("visible.md", "ok");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("visible.md");
    expect(result.some((p) => p.includes(".git"))).toBe(false);
    expect(result.some((p) => p.includes(".vscode"))).toBe(false);
  });

  it("skips node_modules", () => {
    touch("node_modules/pkg/readme.md", "readme");
    touch("real.md", "ok");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("real.md");
    expect(result.some((p) => p.includes("node_modules"))).toBe(false);
  });

  it("skips __pycache__ and .julia directories", () => {
    touch("__pycache__/cache.txt", "");
    touch(".julia/packages.txt", "");
    touch("real.txt", "ok");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("real.txt");
    expect(result.some((p) => p.includes("__pycache__"))).toBe(false);
    expect(result.some((p) => p.includes(".julia"))).toBe(false);
  });

  it("returns paths with forward slashes on all platforms", () => {
    touch("sub/dir/file.tex", "tex");

    const result = scanRenderableFiles(testDir);
    for (const p of result) {
      expect(p).not.toContain("\\");
    }
  });

  it("handles non-existent directory gracefully", () => {
    const result = scanRenderableFiles(join(testDir, "nonexistent"));
    expect(result).toEqual([]);
  });

  it("respects max depth to avoid runaway scans", () => {
    // Create a deeply nested structure (10 levels)
    let current = "";
    for (let i = 0; i < 10; i++) {
      current = current ? `${current}/d${i}` : `d${i}`;
    }
    touch(`${current}/deep.md`, "deep");
    touch("shallow.md", "shallow");

    const result = scanRenderableFiles(testDir);
    // Should find the shallow file
    expect(result).toContain("shallow.md");
    // The deep file may or may not be found depending on max depth implementation
    // but the scan should not hang or crash
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles files with multiple dots in name", () => {
    touch("paper.v2.final.tex", "tex");
    touch("data.2024-01-01.log", "log");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("paper.v2.final.tex");
    expect(result).toContain("data.2024-01-01.log");
  });

  it("case-insensitive extension matching", () => {
    touch("photo.PNG", "png");
    touch("photo.Jpg", "jpg");
    touch("paper.TEX", "tex");

    const result = scanRenderableFiles(testDir);
    expect(result).toContain("photo.PNG");
    expect(result).toContain("photo.Jpg");
    expect(result).toContain("paper.TEX");
  });
});

// ── pickPreviewProject ──────────────────────────────────────────────────────

describe("pickPreviewProject", () => {
  const research: WorkspaceProjectEntry = { name: "My Research", worktree: "/projects/research", type: "research" };
  const dev: WorkspaceProjectEntry = { name: "amicode", worktree: "/projects/amicode", type: "dev" };
  const dev2: WorkspaceProjectEntry = { name: "other-dev", worktree: "/projects/other", type: "dev" };

  it("prefers a research project when one exists", () => {
    expect(pickPreviewProject([dev, research])).toBe(research);
  });

  it("prefers the first research project when multiple exist", () => {
    const research2: WorkspaceProjectEntry = { name: "Second", worktree: "/projects/r2", type: "research" };
    expect(pickPreviewProject([research2, dev, research])).toBe(research2);
  });

  it("falls back to the first dev project when no research project exists", () => {
    expect(pickPreviewProject([dev, dev2])).toBe(dev);
  });

  it("returns undefined when the project list is empty", () => {
    expect(pickPreviewProject([])).toBeUndefined();
  });

  it("returns the only project regardless of type", () => {
    expect(pickPreviewProject([dev])).toBe(dev);
    expect(pickPreviewProject([research])).toBe(research);
  });
});

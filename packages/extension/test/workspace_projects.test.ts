import { describe, it, expect } from "vitest";
import {
  getWorkspaceProjects,
  type WorkspaceProjectEntry,
  type WorkspaceProjectDeps,
} from "../src/workspace_projects";

// ============================================================================
// Workspace project scanner (#663): converts VS Code workspace folders into
// typed project entries for the chat panel bridge message. The chat iframe's
// project selector below the composer reads this list.
// ============================================================================

function deps(
  folders: Array<{ name: string; path: string }>,
  overrides: Partial<WorkspaceProjectDeps> = {},
): WorkspaceProjectDeps {
  return {
    getWorkspaceFolders: () =>
      folders.map((f) => ({ uri: { fsPath: f.path }, name: f.name })),
    detectProjectType: () => "dev",
    readToml: () => ({}),
    ...overrides,
  };
}

describe("getWorkspaceProjects (#663)", () => {
  it("returns dev projects with folder name as the name", () => {
    const result = getWorkspaceProjects(
      deps([{ name: "harmoniqs", path: "/Users/jj/harmoniqs" }]),
    );
    expect(result).toEqual<WorkspaceProjectEntry[]>([
      { name: "harmoniqs", worktree: "/Users/jj/harmoniqs", type: "dev" },
    ]);
  });

  it("returns research projects with name and status from toml", () => {
    const result = getWorkspaceProjects(
      deps([{ name: "cz-speed-limit", path: "/Users/jj/projects/cz-speed-limit" }], {
        detectProjectType: () => "research",
        readToml: () => ({ name: "CZ Speed Limit Study", status: "running" }),
      }),
    );
    expect(result).toEqual<WorkspaceProjectEntry[]>([
      {
        name: "CZ Speed Limit Study",
        worktree: "/Users/jj/projects/cz-speed-limit",
        type: "research",
        status: "running",
      },
    ]);
  });

  it("research projects fall back to folder name when toml has no name", () => {
    const result = getWorkspaceProjects(
      deps([{ name: "my-study", path: "/tmp/my-study" }], {
        detectProjectType: () => "research",
        readToml: () => ({ status: "designing" }),
      }),
    );
    expect(result[0].name).toBe("my-study");
    expect(result[0].status).toBe("designing");
  });

  it("groups research projects before dev projects", () => {
    const typeMap: Record<string, "research" | "dev"> = {
      "/dev-repo": "dev",
      "/research-1": "research",
      "/another-dev": "dev",
      "/research-2": "research",
    };
    const result = getWorkspaceProjects(
      deps(
        [
          { name: "dev-repo", path: "/dev-repo" },
          { name: "research-1", path: "/research-1" },
          { name: "another-dev", path: "/another-dev" },
          { name: "research-2", path: "/research-2" },
        ],
        { detectProjectType: (dir) => typeMap[dir] ?? "dev" },
      ),
    );
    expect(result.map((p) => p.type)).toEqual([
      "research",
      "research",
      "dev",
      "dev",
    ]);
  });

  it("returns empty array when no workspace folders exist", () => {
    const result = getWorkspaceProjects(deps([]));
    expect(result).toEqual([]);
  });

  it("omits status field when toml has no status", () => {
    const result = getWorkspaceProjects(
      deps([{ name: "study", path: "/study" }], {
        detectProjectType: () => "research",
        readToml: () => ({ name: "Study" }),
      }),
    );
    expect(result[0]).not.toHaveProperty("status");
  });

  it("handles toml read failure gracefully (falls back to dev-style entry)", () => {
    const result = getWorkspaceProjects(
      deps([{ name: "bad-toml", path: "/bad" }], {
        detectProjectType: () => "research",
        readToml: () => {
          throw new Error("parse error");
        },
      }),
    );
    // Should not crash — returns a research entry with folder name fallback
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("bad-toml");
    expect(result[0].type).toBe("research");
  });
});

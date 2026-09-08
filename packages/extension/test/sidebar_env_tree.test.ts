// Sidebar nested environment tree — TreeService getChildren appends env row.
// Part of #885 (sub-issue of #880 Research Environments).
import { describe, it, expect } from "vitest";
import { SidebarTreeService } from "../src/sidebar_tree_service";
import type { RawDirEntry } from "../src/sidebar_tree_service";

describe("SidebarTreeService nested environment tree (#885)", () => {
  function makeService(env: { name: string; slug: string; path: string } | null = {
    path: "/env/transmon-oc",
    slug: "transmon-oc",
    name: "Transmon OC",
  }) {
    const folders = [
      { uri: { fsPath: "/proj" }, name: "proj" },
    ];
    return new SidebarTreeService({
      detectProjectType: () => "research",
      readToml: () => ({ name: "My Project", status: "running" }),
      resolveEnvironment: () => env ? { ...env, schemaVersion: 1 } : null,
      readDirectory: async (dir: string): Promise<RawDirEntry[]> => {
        if (dir === "/proj") {
          return [
            { name: "scripts", type: "directory" },
            { name: "data", type: "directory" },
            { name: "README.md", type: "file" },
          ];
        }
        return [];
      },
      getWorkspaceFolders: () => folders,
    });
  }

  it("appends environment as last child of a bound project root (AC-11)", async () => {
    const service = makeService();
    // Must call getRoots first to populate the environment map
    service.getRoots();

    const children = await service.getChildren("/proj");
    expect(children.length).toBe(4); // 3 regular + 1 environment
    const envEntry = children[children.length - 1];
    expect(envEntry.entryKind).toBe("environment-root");
    expect(envEntry.name).toBe("Transmon OC");
    expect(envEntry.path).toBe("/env/transmon-oc");
    expect(envEntry.environmentSlug).toBe("transmon-oc");
    expect(envEntry.type).toBe("directory");
  });

  it("no environment → no extra child", async () => {
    const service = makeService(null);
    service.getRoots();

    const children = await service.getChildren("/proj");
    expect(children.length).toBe(3); // just the regular children
    expect(children.find((c) => c.entryKind === "environment-root")).toBeUndefined();
  });

  it("environment row is always last (after sorted files)", async () => {
    const service = makeService();
    service.getRoots();

    const children = await service.getChildren("/proj");
    // Regular entries should be sorted (dirs first, then files)
    const regular = children.filter((c) => !c.entryKind);
    expect(regular[0].name).toBe("data");      // dir
    expect(regular[1].name).toBe("scripts");    // dir
    expect(regular[2].name).toBe("README.md");  // file

    // Environment is last
    expect(children[children.length - 1].entryKind).toBe("environment-root");
  });
});

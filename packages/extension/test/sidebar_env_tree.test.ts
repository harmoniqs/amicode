// Sidebar environment tree — TreeService getChildren appends env row + getRoots environment discovery.
// Part of #885 (sub-issue of #880 Research Environments) and #895 (environment accordion section).
import { describe, it, expect } from "vitest";
import { SidebarTreeService } from "../src/sidebar_tree_service";
import type { RawDirEntry } from "../src/sidebar_tree_service";
import { envColorIndex } from "../src/sidebar_bridge";

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

// ── Environment discovery (#895) ─────────────────────────────────────────────

describe("SidebarTreeService environment discovery (#895)", () => {
  /** Helper: build a service with configurable workspace folders and project types. */
  function makeDiscoveryService(opts: {
    folders: Array<{ path: string; name: string }>;
    projectTypes: Record<string, "research" | "dev" | "environment">;
    toml?: Record<string, { name?: string; status?: string }>;
    envResolution?: Record<string, { path: string; slug: string; name: string } | null>;
    /** Read the environment TOML for environment-type folders. */
    envToml?: Record<string, { name?: string; slug?: string }>;
  }) {
    return new SidebarTreeService({
      detectProjectType: (dir: string) => opts.projectTypes[dir] ?? "dev",
      readToml: (dir: string) => opts.toml?.[dir] ?? {},
      resolveEnvironment: (projectPath: string) => {
        const env = opts.envResolution?.[projectPath];
        return env ? { ...env, schemaVersion: 1 } : null;
      },
      readDirectory: async (): Promise<RawDirEntry[]> => [],
      getWorkspaceFolders: () =>
        opts.folders.map((f) => ({ uri: { fsPath: f.path }, name: f.name })),
      readEnvironmentToml: (dir: string) => {
        const t = opts.envToml?.[dir];
        return t ? { name: t.name ?? dir, slug: t.slug ?? "unknown" } : null;
      },
    });
  }

  it("workspace environment folders appear as environment roots with source 'workspace'", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/env/spin-qubit", name: "spin-qubit" },
        { path: "/proj/my-project", name: "my-project" },
      ],
      projectTypes: { "/env/spin-qubit": "environment", "/proj/my-project": "research" },
      toml: { "/proj/my-project": { name: "My Project" } },
      envToml: { "/env/spin-qubit": { name: "Spin Qubit Env", slug: "spin-qubit" } },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    expect(envRoots[0].name).toBe("Spin Qubit Env");
    expect(envRoots[0].path).toBe("/env/spin-qubit");
    expect(envRoots[0].source).toBe("workspace");
  });

  it("auto-surfaces environments resolved from project bindings with source 'resolved'", () => {
    const service = makeDiscoveryService({
      folders: [{ path: "/proj/my-project", name: "my-project" }],
      projectTypes: { "/proj/my-project": "research" },
      toml: { "/proj/my-project": { name: "My Project" } },
      envResolution: {
        "/proj/my-project": { path: "/other/transmon-oc", slug: "transmon-oc", name: "Transmon OC" },
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    expect(envRoots[0].name).toBe("Transmon OC");
    expect(envRoots[0].path).toBe("/other/transmon-oc");
    expect(envRoots[0].source).toBe("resolved");
  });

  it("deduplicates environments by slug — workspace path wins", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/env/transmon-oc", name: "transmon-oc" },
        { path: "/proj/my-project", name: "my-project" },
      ],
      projectTypes: { "/env/transmon-oc": "environment", "/proj/my-project": "research" },
      toml: { "/proj/my-project": { name: "My Project" } },
      envToml: { "/env/transmon-oc": { name: "Transmon OC", slug: "transmon-oc" } },
      envResolution: {
        "/proj/my-project": { path: "/resolved/transmon-oc", slug: "transmon-oc", name: "Transmon OC Resolved" },
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    // Workspace path wins over resolved path
    expect(envRoots[0].path).toBe("/env/transmon-oc");
    expect(envRoots[0].source).toBe("workspace");
  });

  it("computes boundProjectCount from open projects bound to the same slug", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/env/shared", name: "shared" },
        { path: "/proj/a", name: "a" },
        { path: "/proj/b", name: "b" },
        { path: "/proj/c", name: "c" },
      ],
      projectTypes: {
        "/env/shared": "environment",
        "/proj/a": "research",
        "/proj/b": "research",
        "/proj/c": "research",
      },
      toml: {
        "/proj/a": { name: "Project A" },
        "/proj/b": { name: "Project B" },
        "/proj/c": { name: "Project C" },
      },
      envToml: { "/env/shared": { name: "Shared Env", slug: "shared" } },
      envResolution: {
        "/proj/a": { path: "/env/shared", slug: "shared", name: "Shared Env" },
        "/proj/b": { path: "/env/shared", slug: "shared", name: "Shared Env" },
        // Project C is NOT bound to this environment
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    expect(envRoots[0].boundProjectCount).toBe(2);
  });

  it("environment roots have colorIndex from slug hash", () => {
    const service = makeDiscoveryService({
      folders: [{ path: "/env/spin-qubit", name: "spin-qubit" }],
      projectTypes: { "/env/spin-qubit": "environment" },
      envToml: { "/env/spin-qubit": { name: "Spin Qubit", slug: "spin-qubit" } },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    expect(envRoots[0].environment?.colorIndex).toBe(envColorIndex("spin-qubit"));
    expect(envRoots[0].environment?.slug).toBe("spin-qubit");
  });

  it("two workspace folders with same slug — last in order wins (both workspace-sourced)", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/env/first", name: "first" },
        { path: "/env/second", name: "second" },
      ],
      projectTypes: { "/env/first": "environment", "/env/second": "environment" },
      envToml: {
        "/env/first": { name: "First Env", slug: "same-slug" },
        "/env/second": { name: "Second Env", slug: "same-slug" },
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots.length).toBe(1);
    expect(envRoots[0].path).toBe("/env/second");
    expect(envRoots[0].source).toBe("workspace");
  });

  it("boundProjectCount is 0 when no projects bind to the environment", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/env/lonely", name: "lonely" },
        { path: "/proj/a", name: "a" },
      ],
      projectTypes: { "/env/lonely": "environment", "/proj/a": "research" },
      toml: { "/proj/a": { name: "Project A" } },
      envToml: { "/env/lonely": { name: "Lonely Env", slug: "lonely" } },
      // Project A resolves to a different environment
      envResolution: {
        "/proj/a": { path: "/other/env", slug: "other-slug", name: "Other Env" },
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    // lonely env + auto-surfaced other-slug env
    const lonelyEnv = envRoots.find((r) => r.path === "/env/lonely");
    expect(lonelyEnv?.boundProjectCount).toBe(0);
  });

  it("returns environment roots before research and dev roots", () => {
    const service = makeDiscoveryService({
      folders: [
        { path: "/proj/research", name: "research" },
        { path: "/env/my-env", name: "my-env" },
        { path: "/proj/dev", name: "dev" },
      ],
      projectTypes: {
        "/proj/research": "research",
        "/env/my-env": "environment",
        "/proj/dev": "dev",
      },
      toml: { "/proj/research": { name: "Research Project" } },
      envToml: { "/env/my-env": { name: "My Env", slug: "my-env" } },
    });

    const roots = service.getRoots();
    // Environments first, then research, then dev
    expect(roots[0].projectType).toBe("environment");
    expect(roots[1].projectType).toBe("research");
    expect(roots[2].projectType).toBe("dev");
  });

  it("workspace source wins dedup even when project appears before environment in folder order", () => {
    // This is the root cause of the "Remove from Workspace" bug:
    // if a research project is iterated before the environment workspace folder,
    // the project resolution adds the environment with source "resolved" first,
    // and the workspace folder must overwrite it.
    const service = makeDiscoveryService({
      folders: [
        // Project comes FIRST — its resolution will try to add the env as "resolved"
        { path: "/proj/a", name: "a" },
        // Environment workspace folder comes SECOND — must still win the dedup
        { path: "/env/shared", name: "shared" },
      ],
      projectTypes: {
        "/proj/a": "research",
        "/env/shared": "environment",
      },
      toml: { "/proj/a": { name: "Project A" } },
      envToml: { "/env/shared": { name: "Shared Env", slug: "shared" } },
      envResolution: {
        "/proj/a": { path: "/env/shared", slug: "shared", name: "Shared Env" },
      },
    });

    const roots = service.getRoots();
    const envRoots = roots.filter((r) => r.projectType === "environment");
    expect(envRoots).toHaveLength(1);
    expect(envRoots[0].source).toBe("workspace");
    expect(envRoots[0].path).toBe("/env/shared");
  });
});

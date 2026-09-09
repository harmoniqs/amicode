// sidebar_group_roots.test.ts — groupRootsForResearchSection (#911/#913).
// Tests the pure function that groups environments and their bound projects
// for nested rendering inside the Research Projects section.
import { describe, it, expect } from "vitest";
import { groupRootsForResearchSection } from "../src/sidebar_bridge";
import type { TreeRoot } from "../src/sidebar_bridge";

/** Helper: make a minimal TreeRoot. */
function makeRoot(overrides: Partial<TreeRoot> & { path: string; name: string; projectType: TreeRoot["projectType"] }): TreeRoot {
  return { ...overrides };
}

describe("groupRootsForResearchSection (#911)", () => {
  it("groups a bound project under its matching environment", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/spin", name: "Spin Env", projectType: "environment", source: "workspace",
        environment: { name: "Spin Env", slug: "spin", path: "/env/spin", colorIndex: 3 } }),
      makeRoot({ path: "/proj/a", name: "Project A", projectType: "research",
        environment: { name: "Spin Env", slug: "spin", path: "/env/spin", colorIndex: 3 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(1);
    expect(result.envGroups[0].env.path).toBe("/env/spin");
    expect(result.envGroups[0].projects).toHaveLength(1);
    expect(result.envGroups[0].projects[0].path).toBe("/proj/a");
    expect(result.unboundProjects).toHaveLength(0);
  });

  it("places unbound projects (no environment.slug) as top-level items", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/proj/solo", name: "Solo Project", projectType: "research" }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(0);
    expect(result.unboundProjects).toHaveLength(1);
    expect(result.unboundProjects[0].path).toBe("/proj/solo");
  });

  it("orphaned binding (slug points to non-existent env) renders as unbound", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/proj/orphan", name: "Orphan", projectType: "research",
        environment: { name: "Gone Env", slug: "deleted-env", path: "/env/deleted", colorIndex: 1 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    // No environment root exists for "deleted-env", so the project is unbound
    expect(result.envGroups).toHaveLength(0);
    expect(result.unboundProjects).toHaveLength(1);
    expect(result.unboundProjects[0].path).toBe("/proj/orphan");
  });

  it("empty environments (no bound projects) appear as groups with empty project list", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/lonely", name: "Lonely Env", projectType: "environment", source: "workspace",
        environment: { name: "Lonely Env", slug: "lonely", path: "/env/lonely", colorIndex: 0 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(1);
    expect(result.envGroups[0].env.path).toBe("/env/lonely");
    expect(result.envGroups[0].projects).toHaveLength(0);
    expect(result.unboundProjects).toHaveLength(0);
  });

  it("sorts environment groups alphabetically by name", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/z", name: "Zeta Env", projectType: "environment",
        environment: { name: "Zeta Env", slug: "zeta", path: "/env/z", colorIndex: 0 } }),
      makeRoot({ path: "/env/a", name: "Alpha Env", projectType: "environment",
        environment: { name: "Alpha Env", slug: "alpha", path: "/env/a", colorIndex: 1 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups[0].env.name).toBe("Alpha Env");
    expect(result.envGroups[1].env.name).toBe("Zeta Env");
  });

  it("sorts unbound projects alphabetically by name", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/proj/z", name: "Zulu", projectType: "research" }),
      makeRoot({ path: "/proj/a", name: "Alpha", projectType: "research" }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.unboundProjects[0].name).toBe("Alpha");
    expect(result.unboundProjects[1].name).toBe("Zulu");
  });

  it("sorts bound projects within an environment group alphabetically", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/e", name: "E", projectType: "environment",
        environment: { name: "E", slug: "e", path: "/env/e", colorIndex: 0 } }),
      makeRoot({ path: "/proj/z", name: "Zulu", projectType: "research",
        environment: { name: "E", slug: "e", path: "/env/e", colorIndex: 0 } }),
      makeRoot({ path: "/proj/a", name: "Alpha", projectType: "research",
        environment: { name: "E", slug: "e", path: "/env/e", colorIndex: 0 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups[0].projects[0].name).toBe("Alpha");
    expect(result.envGroups[0].projects[1].name).toBe("Zulu");
  });

  it("ignores dev roots entirely", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/dev/x", name: "Dev X", projectType: "dev" }),
      makeRoot({ path: "/proj/a", name: "Project A", projectType: "research" }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(0);
    expect(result.unboundProjects).toHaveLength(1);
    expect(result.unboundProjects[0].path).toBe("/proj/a");
  });

  it("handles mixed scenario: envs with bound + unbound projects + empty env", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/active", name: "Active Env", projectType: "environment",
        environment: { name: "Active Env", slug: "active", path: "/env/active", colorIndex: 2 } }),
      makeRoot({ path: "/env/empty", name: "Empty Env", projectType: "environment",
        environment: { name: "Empty Env", slug: "empty", path: "/env/empty", colorIndex: 5 } }),
      makeRoot({ path: "/proj/bound", name: "Bound Proj", projectType: "research",
        environment: { name: "Active Env", slug: "active", path: "/env/active", colorIndex: 2 } }),
      makeRoot({ path: "/proj/free", name: "Free Proj", projectType: "research" }),
      makeRoot({ path: "/dev/x", name: "Dev X", projectType: "dev" }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(2);
    // Active Env has one bound project
    const activeGroup = result.envGroups.find(g => g.env.name === "Active Env");
    expect(activeGroup?.projects).toHaveLength(1);
    expect(activeGroup?.projects[0].name).toBe("Bound Proj");
    // Empty Env has no projects
    const emptyGroup = result.envGroups.find(g => g.env.name === "Empty Env");
    expect(emptyGroup?.projects).toHaveLength(0);
    // Unbound
    expect(result.unboundProjects).toHaveLength(1);
    expect(result.unboundProjects[0].name).toBe("Free Proj");
  });

  it("multiple projects bound to the same environment", () => {
    const roots: TreeRoot[] = [
      makeRoot({ path: "/env/shared", name: "Shared", projectType: "environment",
        environment: { name: "Shared", slug: "shared", path: "/env/shared", colorIndex: 0 } }),
      makeRoot({ path: "/proj/a", name: "Alpha", projectType: "research",
        environment: { name: "Shared", slug: "shared", path: "/env/shared", colorIndex: 0 } }),
      makeRoot({ path: "/proj/b", name: "Beta", projectType: "research",
        environment: { name: "Shared", slug: "shared", path: "/env/shared", colorIndex: 0 } }),
    ];

    const result = groupRootsForResearchSection(roots);

    expect(result.envGroups).toHaveLength(1);
    expect(result.envGroups[0].projects).toHaveLength(2);
  });

  it("returns the correct type shape", () => {
    const result = groupRootsForResearchSection([]);

    expect(result).toHaveProperty("envGroups");
    expect(result).toHaveProperty("unboundProjects");
    expect(Array.isArray(result.envGroups)).toBe(true);
    expect(Array.isArray(result.unboundProjects)).toBe(true);
  });
});

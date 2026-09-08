// Sidebar environment pill — color palette utility + TreeService wiring + webview rendering.
// Part of #884 (sub-issue of #880 Research Environments).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { hashCode, envColorIndex, truncateWithEllipsis } from "../src/sidebar_bridge";
import { SidebarTreeService } from "../src/sidebar_tree_service";

// ── Color palette utility ────────────────────────────────────────────────────

describe("envColorIndex (#884)", () => {
  it("returns a value in [0, 7]", () => {
    for (const slug of ["transmon-oc", "rydberg-gates", "fluxonium-env", "my-env"]) {
      const idx = envColorIndex(slug);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThanOrEqual(7);
    }
  });

  it("same slug always produces the same index (deterministic)", () => {
    const a = envColorIndex("transmon-optimal-control");
    const b = envColorIndex("transmon-optimal-control");
    expect(a).toBe(b);
  });

  it("different slugs can produce different indices", () => {
    // Not guaranteed for any specific pair, but over many slugs we should see variation
    const indices = new Set(
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta", "iota"].map(envColorIndex)
    );
    expect(indices.size).toBeGreaterThan(1);
  });
});

describe("hashCode", () => {
  it("empty string returns 0", () => {
    expect(hashCode("")).toBe(0);
  });

  it("produces consistent values", () => {
    expect(hashCode("test")).toBe(hashCode("test"));
  });

  it("different strings produce different hashes", () => {
    expect(hashCode("abc")).not.toBe(hashCode("xyz"));
  });
});

describe("truncateWithEllipsis", () => {
  it("returns the string unchanged when within limit", () => {
    expect(truncateWithEllipsis("short", 15)).toBe("short");
  });

  it("truncates with ellipsis when exceeding limit", () => {
    const result = truncateWithEllipsis("transmon-optimal-control", 15);
    expect(result).toHaveLength(16); // 15 chars + ellipsis
    expect(result.endsWith("\u2026")).toBe(true);
  });

  it("handles exact-length strings without truncation", () => {
    expect(truncateWithEllipsis("exact", 5)).toBe("exact");
  });
});

// ── TreeService environment wiring ───────────────────────────────────────────

describe("SidebarTreeService environment pill data (#884)", () => {
  function makeService(overrides: Partial<Parameters<typeof SidebarTreeService.prototype.getRoots>[0]> = {}) {
    const folders = [
      { uri: { fsPath: "/proj" }, name: "proj" },
    ];
    return new SidebarTreeService({
      detectProjectType: () => "research",
      readToml: () => ({ name: "My Project", status: "running" }),
      resolveEnvironment: () => ({
        path: "/env/transmon-oc",
        slug: "transmon-oc",
        name: "Transmon OC",
        schemaVersion: 1,
      }),
      getWorkspaceFolders: () => folders,
      ...overrides,
    });
  }

  it("attaches environment info to research project roots", () => {
    const service = makeService();
    const roots = service.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].environment).toBeDefined();
    expect(roots[0].environment!.slug).toBe("transmon-oc");
    expect(roots[0].environment!.name).toBe("Transmon OC");
    expect(roots[0].environment!.path).toBe("/env/transmon-oc");
    expect(roots[0].environment!.colorIndex).toBeGreaterThanOrEqual(0);
    expect(roots[0].environment!.colorIndex).toBeLessThanOrEqual(7);
  });

  it("no environment → no environment field on root (AC-10)", () => {
    const service = makeService({
      resolveEnvironment: () => null,
    });
    const roots = service.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].environment).toBeUndefined();
  });

  it("resolveEnvironment not provided → no environment field", () => {
    const service = makeService({
      resolveEnvironment: undefined,
    });
    const roots = service.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].environment).toBeUndefined();
  });

  it("dev projects never get environment info", () => {
    const service = makeService({
      detectProjectType: () => "dev",
      resolveEnvironment: () => ({
        path: "/env/x", slug: "x", name: "X", schemaVersion: 1,
      }),
    });
    const roots = service.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].environment).toBeUndefined();
  });

  it("resolution failure → no environment, no crash", () => {
    const service = makeService({
      resolveEnvironment: () => { throw new Error("boom"); },
    });
    const roots = service.getRoots();
    expect(roots).toHaveLength(1);
    expect(roots[0].environment).toBeUndefined();
  });
});

// ── Webview rendering (source-level checks) ──────────────────────────────────

describe("sidebar environment pill rendering (#884)", () => {
  const webviewSrc = readFileSync(
    resolve(__dirname, "..", "src", "sidebar_webview.ts"),
    "utf8",
  );
  const viewSrc = readFileSync(
    resolve(__dirname, "..", "src", "sidebar_view.ts"),
    "utf8",
  );

  it("sidebar_view.ts CSS includes env-pill styling", () => {
    expect(viewSrc).toContain("env-pill");
  });

  it("sidebar_webview.ts TreeRoot interface includes the environment field", () => {
    // The webview's local TreeRoot must declare the environment property
    // so the rendering code can read it from the host-pushed data.
    expect(webviewSrc).toMatch(/interface TreeRoot[\s\S]*?environment\?/);
  });

  it("sidebar_webview.ts renderRootNode reads root.environment to create a pill", () => {
    // The rendering function must check root.environment and create a pill element
    expect(webviewSrc).toMatch(/root\.environment/);
    expect(webviewSrc).toContain("env-pill");
  });
});

// sidebar_nesting_regression.test.ts — Regression tests for #911 nesting.
// Verifies the complete set of nesting behaviors after all 5 implementation slices.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { resolveSectionOrder, groupRootsForResearchSection } from "../src/sidebar_bridge";

const webviewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);
const viewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_view.ts"),
  "utf8",
);

describe("regression: 3 sections, no environments section (#911)", () => {
  it("DEFAULT_SECTION_ORDER is exactly [research, dev, fleet]", async () => {
    vi.resetModules();
    const { SidebarViewProvider } = await import("../src/sidebar_view");
    expect(SidebarViewProvider.DEFAULT_SECTION_ORDER).toEqual(["research", "dev", "fleet"]);
  });

  it("webview available array is [research, dev, fleet]", () => {
    expect(webviewSrc).toMatch(/available.*\["research",\s*"dev",\s*"fleet"\]/);
  });

  it("no renderSectionHeader call for Research Environments", () => {
    expect(webviewSrc).not.toMatch(/renderSectionHeader\s*\(\s*["']Research Environments["']/);
  });

  it("no sectionExpanded.environments key", () => {
    expect(webviewSrc).not.toMatch(/__section_environments/);
  });
});

describe("regression: bridge resolveSectionOrder (#911)", () => {
  it("strips environments from saved order (not in available set)", () => {
    // When an old saved order includes "environments", the bridge version
    // filters it out since it's not in the available set
    expect(resolveSectionOrder(
      ["environments", "research", "dev", "fleet"],
      ["research", "dev", "fleet"],
    )).toEqual(["research", "dev", "fleet"]);
  });

  it("preserves user reorder without environments", () => {
    expect(resolveSectionOrder(
      ["fleet", "research", "dev"],
      ["research", "dev", "fleet"],
    )).toEqual(["fleet", "research", "dev"]);
  });
});

describe("regression: webview strips environments from saved order (#911)", () => {
  it("webview resolveSectionOrder filters environments explicitly", () => {
    // The webview copy has an explicit migration to strip "environments"
    expect(webviewSrc).toMatch(/filter.*environments|environments.*filter/);
  });
});

describe("regression: groupRootsForResearchSection (#911)", () => {
  it("is exported from sidebar_bridge", () => {
    expect(typeof groupRootsForResearchSection).toBe("function");
  });

  it("is used in the webview source", () => {
    expect(webviewSrc).toContain("groupRootsForResearchSection");
  });
});

describe("regression: no color coding artifacts (#911)", () => {
  it("no env-pill CSS", () => {
    expect(viewSrc).not.toMatch(/\.env-pill\b/);
  });

  it("no env-root-border CSS", () => {
    expect(viewSrc).not.toMatch(/\.env-root-border-\d/);
  });

  it("no env-project-count CSS", () => {
    expect(viewSrc).not.toMatch(/\.env-project-count\b/);
  });

  it("env-projects-separator CSS exists", () => {
    expect(viewSrc).toMatch(/\.env-projects-separator/);
  });
});

describe("regression: keyboard nav + accessibility (#911)", () => {
  it("aria-expanded on env group headers", () => {
    expect(webviewSrc).toMatch(/aria-expanded/);
  });

  it("tabindex on root-level items", () => {
    expect(webviewSrc).toMatch(/tabindex/i);
  });

  it("focus-visible CSS", () => {
    expect(viewSrc).toMatch(/focus-visible/);
  });

  it("ArrowUp/ArrowDown keyboard handler", () => {
    expect(webviewSrc).toMatch(/ArrowDown/);
    expect(webviewSrc).toMatch(/ArrowUp/);
  });
});

describe("regression: bridge environmentSlug (#911)", () => {
  it("NewProjectMessage includes environmentSlug", () => {
    expect(readFileSync(resolve(__dirname, "..", "src", "sidebar_bridge.ts"), "utf8"))
      .toMatch(/environmentSlug/);
  });
});

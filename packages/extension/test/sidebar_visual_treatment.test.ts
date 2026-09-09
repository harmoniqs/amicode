// sidebar_visual_treatment.test.ts — Projects separator + color coding removal (#915).
// Part of #911 (nest environments in research section).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const webviewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);
const viewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_view.ts"),
  "utf8",
);

describe("sidebar Projects separator (#915)", () => {
  it("populateEnvGroupChildren inserts a separator element with role=separator", () => {
    expect(webviewSrc).toMatch(/role.*separator/);
    expect(webviewSrc).toMatch(/aria-orientation.*horizontal/);
  });

  it("separator has class env-projects-separator", () => {
    expect(webviewSrc).toMatch(/env-projects-separator/);
  });

  it("separator is only rendered when there are bound projects", () => {
    // The separator must be gated on projects.length > 0
    expect(webviewSrc).toMatch(/projects\.length\s*>\s*0/);
  });

  it("CSS defines env-projects-separator style", () => {
    expect(viewSrc).toMatch(/env-projects-separator/);
  });
});

describe("sidebar color coding removal (#915)", () => {
  it("no env-root-border CSS classes in sidebar_view.ts", () => {
    expect(viewSrc).not.toMatch(/env-root-border-\d/);
  });

  it("no env-pill CSS classes in sidebar_view.ts", () => {
    expect(viewSrc).not.toMatch(/\.env-pill\b/);
  });

  it("no env-project-count CSS definition in sidebar_view.ts", () => {
    expect(viewSrc).not.toMatch(/\.env-project-count\b/);
  });

  it("renderRootNode does not apply env-root-border classes", () => {
    // The env-root-border-N class application should be removed
    expect(webviewSrc).not.toMatch(/env-root-border-\$\{/);
    expect(webviewSrc).not.toMatch(/classList\.add.*env-root-border/);
  });

  it("renderRootNode does not render an env-pill element", () => {
    // The pill creation block should be removed
    expect(webviewSrc).not.toMatch(/env-pill-\$\{/);
  });

  it("renderRootNode does not render env-project-count", () => {
    expect(webviewSrc).not.toMatch(/env-project-count/);
  });

  it("roots dedup check does not compare boundProjectCount", () => {
    // The sameness check should not use boundProjectCount anymore
    expect(webviewSrc).not.toMatch(/boundProjectCount.*currentRoots\[i\]/);
  });
});

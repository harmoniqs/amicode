// sidebar_visual_treatment.test.ts — Color coding removal (#915).
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

  it("no env-projects-separator CSS in sidebar_view.ts", () => {
    expect(viewSrc).not.toMatch(/\.env-projects-separator\b/);
  });

  it("renderRootNode does not apply env-root-border classes", () => {
    expect(webviewSrc).not.toMatch(/env-root-border-\$\{/);
    expect(webviewSrc).not.toMatch(/classList\.add.*env-root-border/);
  });

  it("renderRootNode does not render an env-pill element", () => {
    expect(webviewSrc).not.toMatch(/env-pill-\$\{/);
  });

  it("renderRootNode does not render env-project-count", () => {
    expect(webviewSrc).not.toMatch(/env-project-count/);
  });

  it("no separator element in webview", () => {
    expect(webviewSrc).not.toMatch(/env-projects-separator/);
  });

  it("roots dedup check does not compare boundProjectCount", () => {
    expect(webviewSrc).not.toMatch(/boundProjectCount.*currentRoots\[i\]/);
  });
});

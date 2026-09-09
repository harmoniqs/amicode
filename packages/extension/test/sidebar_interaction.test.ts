// sidebar_interaction.test.ts — Auto-expand + keyboard nav (#917).
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

describe("sidebar — no env auto-expand on session switch (#917)", () => {
  it("applyActiveProject does not auto-expand the parent environment group", () => {
    // Bound projects are always visible in .env-bound-projects, so no
    // env expansion is needed on session switch
    expect(webviewSrc).not.toMatch(/boundEnvSlug/);
    expect(webviewSrc).not.toMatch(/expanded\[envRoot\.path\]/);
  });

  it("no references to deleted environments section", () => {
    expect(webviewSrc).not.toMatch(/sectionExpanded\[["']environments["']\]/);
    expect(webviewSrc).not.toMatch(/sectionKey\s*===\s*["']environments["']/);
  });
});

describe("sidebar keyboard navigation (#917)", () => {
  it("adds a keydown handler for arrow keys, Enter, and Space", () => {
    expect(webviewSrc).toMatch(/keydown/);
    expect(webviewSrc).toMatch(/ArrowDown|ArrowUp/);
    expect(webviewSrc).toMatch(/Enter|Space/);
  });

  it("env group headers have aria-expanded attribute", () => {
    expect(webviewSrc).toMatch(/aria-expanded/);
  });

  it("uses tabindex for focus management", () => {
    expect(webviewSrc).toMatch(/tabindex|tabIndex/i);
  });

  it("CSS defines :focus-visible outline for tree nodes", () => {
    expect(viewSrc).toMatch(/focus-visible/);
  });
});

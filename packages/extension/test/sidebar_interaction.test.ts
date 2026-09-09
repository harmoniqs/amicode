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

describe("sidebar auto-expand parent environment (#917)", () => {
  it("applyActiveProject finds the bound environment root by slug", () => {
    expect(webviewSrc).toMatch(/boundEnvSlug/);
    expect(webviewSrc).toMatch(/envRoot.*projectType.*environment|environment.*projectType.*envRoot/s);
  });

  it("auto-expand checks mode before expanding (none skips)", () => {
    expect(webviewSrc).toMatch(/mode.*expand.*reset.*boundEnvSlug|boundEnvSlug.*mode.*expand.*reset/s);
  });

  it("auto-expand does not reference the deleted environments section", () => {
    // Must NOT reference sectionExpanded["environments"] or dataset.sectionKey === "environments"
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

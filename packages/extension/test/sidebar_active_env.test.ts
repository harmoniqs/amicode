// sidebar_active_env.test.ts — Active project behavior with nested environments.
// Updated: bound projects are always visible (two-container layout), so
// applyActiveProject does NOT expand the parent env group on session switch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);

describe("sidebar active project — no env auto-expand", () => {
  it("applyActiveProject does not expand the parent environment group", () => {
    // Bound projects are always visible in .env-bound-projects, so the
    // cascade that expanded the env group is removed.
    expect(src).not.toMatch(/expanded\[envRoot\.path\]\s*=\s*true/);
    expect(src).not.toMatch(/boundEnvSlug/);
  });

  it("applyActiveProject does not reference the deleted environments section", () => {
    expect(src).not.toMatch(/sectionExpanded\[["']environments["']\]/);
  });

  it("applyActiveProject still highlights the active project row", () => {
    // The highlight logic for the project itself is unchanged
    expect(src).toMatch(/activeEl/);
    expect(src).toMatch(/borderLeft/);
  });
});

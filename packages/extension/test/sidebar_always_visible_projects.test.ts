// sidebar_always_visible_projects.test.ts — Two-container layout: env files
// collapsible, bound projects always visible. No env auto-expand on session switch.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const webviewSrc = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);

describe("sidebar two-container env group layout", () => {
  it("renderEnvGroupNode creates an env-bound-projects container", () => {
    expect(webviewSrc).toMatch(/env-bound-projects/);
  });

  it("env-bound-projects container is always display:block (never toggled)", () => {
    // The bound projects container should never have its display set to "none"
    // Search for env-bound-projects and verify no display:none assignment
    const fnBody = webviewSrc.match(
      /function\s+renderEnvGroupNode[\s\S]*?(?=\n  function\s)/,
    );
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Must create the container
    expect(body).toMatch(/env-bound-projects/);
    // The .children container IS toggled (display none/block) but env-bound-projects is not
    expect(body).toMatch(/childrenEl\.style\.display/);
  });

  it("chevron click only toggles .children, not .env-bound-projects", () => {
    const fnBody = webviewSrc.match(
      /function\s+renderEnvGroupNode[\s\S]*?(?=\n  function\s)/,
    );
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Click handler toggles childrenEl display
    expect(body).toMatch(/childrenEl\.style\.display/);
    // Click handler does NOT toggle projectsEl or env-bound-projects display
    expect(body).not.toMatch(/projectsEl\.style\.display/);
  });

  it("bound projects are rendered into the separate container, not .children", () => {
    const fnBody = webviewSrc.match(
      /function\s+renderEnvGroupNode[\s\S]*?(?=\n  function\s)/,
    );
    expect(fnBody).not.toBeNull();
    const body = fnBody![0];
    // Projects appended to projectsEl, not childrenEl
    expect(body).toMatch(/projectsEl\.appendChild/);
  });
});

describe("sidebar no env auto-expand on session switch", () => {
  it("applyActiveProject does NOT auto-expand the parent environment group", () => {
    // The env cascade block that expanded the parent env group is removed.
    // There should be no expanded[envRoot.path] = true in applyActiveProject.
    expect(webviewSrc).not.toMatch(/expanded\[envRoot\.path\]\s*=\s*true/);
  });

  it("applyActiveProject does not reference boundEnvSlug for expansion", () => {
    // The boundEnvSlug variable and env expansion logic should be gone
    expect(webviewSrc).not.toMatch(/boundEnvSlug/);
  });

  it("no re-append logic for bound projects in children handler", () => {
    // The currentEnvGroupProjects.get() block in the children handler is deleted
    expect(webviewSrc).not.toMatch(/currentEnvGroupProjects\.get\(msg\.path\)/);
  });
});

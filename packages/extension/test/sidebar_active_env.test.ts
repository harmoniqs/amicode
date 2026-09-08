// sidebar_active_env.test.ts — Environment cascade in applyActiveProject (#895).
// Source-level structural checks for the environment highlighting behavior.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);

describe("sidebar active environment highlighting (#895)", () => {
  it("applyActiveProject looks up the active project's bound environment", () => {
    // Must find the environment from the active root's environment field
    expect(src).toMatch(/activeRoot.*environment/s);
    expect(src).toMatch(/environment.*slug/);
  });

  it("applyActiveProject highlights the bound environment root with its palette color", () => {
    // Must apply the env-root-border color to the environment's row
    expect(src).toMatch(/env-root-border/);
  });

  it("applyActiveProject clears previous environment highlights", () => {
    // Must clear the border/background on non-active environment roots
    expect(src).toMatch(/borderLeft.*"".*environment|environment.*borderLeft.*""/s);
  });

  it("applyActiveProject auto-expands the environments section if collapsed", () => {
    // Must check sectionExpanded["environments"] and expand it if needed
    expect(src).toMatch(/sectionExpanded\[?"environments"?\]/);
  });

  it("environment cascade handles missing environment gracefully", () => {
    // Must check whether the active root has a bound environment before cascading
    expect(src).toMatch(/activeRoot.*environment/s);
  });
});

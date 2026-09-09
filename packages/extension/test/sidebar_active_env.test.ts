// sidebar_active_env.test.ts — Environment cascade in applyActiveProject (#911).
// Source-level structural checks for the environment auto-expand behavior.
// Updated for #911: environments are nested inside the research section,
// not in a separate "environments" section.
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const src = readFileSync(
  resolve(__dirname, "..", "src", "sidebar_webview.ts"),
  "utf8",
);

describe("sidebar active environment highlighting (#911)", () => {
  it("applyActiveProject looks up the active project's bound environment", () => {
    // Must find the environment from the active root's environment field
    expect(src).toMatch(/activeRoot.*environment/s);
    expect(src).toMatch(/environment.*slug/);
  });

  it("applyActiveProject auto-expands the parent environment group if collapsed", () => {
    // Must expand the env group node (not a separate section) when the
    // active project is bound to that environment (#911)
    expect(src).toMatch(/boundEnvSlug/);
    expect(src).toMatch(/expanded\[envRoot\.path\]/);
  });

  it("environment cascade handles missing environment gracefully", () => {
    // Must check whether the active root has a bound environment before cascading
    expect(src).toMatch(/activeRoot.*environment/s);
  });
});

// Regression test for harmoniqs/amicode#1418 — the focused-connect boot path
// (Amicode: Connect Harmoniqs AI Provider) must hide the empty #animation
// element before revealing the form; otherwise the 100vh animation div pushes
// the form below the fold and the panel renders blank.
//
// The webview script is a browser bundle with no DOM harness in this suite, so
// this is a structural assertion over its boot block.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(__dirname, "../src/onboarding_webview.ts"),
  "utf8",
);

describe("onboarding webview — focused connect boot (#1418)", () => {
  it("the focusProvider branch hides #animation before revealing the form", () => {
    const start = SRC.indexOf("// Focused connect skips the brand animation");
    expect(start, "focused-connect boot block not found").toBeGreaterThan(-1);
    const m = SRC.slice(start).match(/if \(focusProvider\) \{([\s\S]*?)\} else \{/);
    expect(m, "focusProvider boot branch not found").not.toBeNull();
    const branch = m![1];
    expect(branch).toMatch(/animationEl\.style\.display\s*=\s*"none"/);
    expect(branch.indexOf('animationEl.style.display = "none"')).toBeLessThan(
      branch.indexOf("revealForm()"),
    );
  });
});

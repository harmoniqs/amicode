// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logo } from "../media/ui/atoms/logo";

// Pins the logo atom's contract:
//  - two variants, each derived from its real .svg file on disk (imported as
//    raw text at build time — no path data duplicated as a TS literal, the
//    exact thing that silently drifted before);
//  - "full" (default) carries the detailed mark's internal accents,
//    "reduced" is the bare outer bracket;
//  - color is theme-responsive by default (fill="currentColor" on the root,
//    host color unset → inherits .logo's var(--vscode-foreground)) and
//    overridable via `fill`.

const mediaDir = join(__dirname, "..", "media");
const outerPathD = (svgSource: string) => svgSource.match(/<path[^>]*\bd="([^"]+)"/)?.[1];

describe("logo() atom", () => {
  it("defaults to the full variant — the detailed mark from amico.svg", () => {
    const svg = logo().querySelector("svg")!;
    expect(svg).not.toBeNull();

    const d = outerPathD(readFileSync(join(mediaDir, "amico.svg"), "utf8"));
    expect(d).toBeTruthy();
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(d);
    // The full mark carries internal circuit-pattern accents (rect/polygon);
    // their presence is what distinguishes it from the reduced variant.
    expect(svg.querySelectorAll("rect, polygon").length).toBeGreaterThan(0);
  });

  it('variant "reduced" is the bare bracket from amico_reduced.svg — no accents', () => {
    const svg = logo({ variant: "reduced" }).querySelector("svg")!;

    const d = outerPathD(readFileSync(join(mediaDir, "amico_reduced.svg"), "utf8"));
    expect(d).toBeTruthy();
    expect(svg.querySelector("path")?.getAttribute("d")).toBe(d);
    expect(svg.querySelectorAll("rect, polygon").length).toBe(0);
  });

  it("is theme-responsive by default: currentColor root, no inline color override", () => {
    const el = logo();
    expect(el.classList.contains("logo")).toBe(true); // .logo sets color: var(--vscode-foreground)
    expect(el.style.color).toBe(""); // nothing hardcoded — inherits the theme var
    expect(el.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  });

  it("fill overrides the host color that drives the mark", () => {
    const el = logo({ fill: "var(--vscode-button-foreground)" });
    expect(el.style.color).toBe("var(--vscode-button-foreground)");
  });
});

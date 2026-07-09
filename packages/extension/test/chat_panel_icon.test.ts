import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The chat WebviewPanel's native tab icon can't use the logo atom's
// fill="currentColor" theming (a native tab icon is a static image with no DOM
// to resolve currentColor against — it renders dark). VS Code's only
// theme-adaptive path is a committed {light, dark} pair inside the extension
// folder (an icon in globalStorageUri renders as nothing — verified via probe).
// These two files are DERIVED from media/amico_reduced.svg with the fill
// swapped; this test keeps them in lockstep with the source so a future edit
// to the mark can't silently leave the tab icons stale.

const mediaDir = join(__dirname, "..", "media");
const read = (f: string) => readFileSync(join(mediaDir, f), "utf8");
const pathD = (svg: string) => svg.match(/<path[^>]*\bd="([^"]+)"/)?.[1];

describe("chat tab icons — committed light/dark pair, in sync with amico_reduced.svg", () => {
  const source = read("amico_reduced.svg");
  const light = read("amico-tab-light.svg");
  const dark = read("amico-tab-dark.svg");

  it("carry theme-foreground fills, no leftover currentColor", () => {
    expect(light).toContain('fill="#424242"'); // dark mark for light themes
    expect(dark).toContain('fill="#CCCCCC"'); //  light mark for dark themes
    expect(light).not.toContain("currentColor");
    expect(dark).not.toContain("currentColor");
  });

  it("share the exact geometry of the source reduced mark (no drift)", () => {
    const d = pathD(source);
    expect(d).toBeTruthy();
    expect(pathD(light)).toBe(d);
    expect(pathD(dark)).toBe(d);
  });
});
